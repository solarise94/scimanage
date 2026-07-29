/**
 * 下单代表邮件通知 — 存量订单回填为 SKIPPED（一次性迁移，停服窗口专用）。
 * 见 docs/order-rep-notify-email-design-2026-07-26.md §5.3 / §7.2（runbook 第 3 步）
 *
 * 为什么必须只执行一次（2026-07-27 三审 P0 修复）：
 *   repNotifyStatus 默认值 PENDING 意味着首次 db push 后所有历史订单都是 PENDING，
 *   必须回填 SKIPPED，否则上线后第一轮扫描会补发几年份的下单邮件（群发事故）。
 *   但回填【不能每次部署都重跑】——设计允许 representativeId=null 的订单长期停留
 *   PENDING 等待 CRM sync 回填后补发；若每次部署用当前时间作 cutoff 重跑，这些合法
 *   待通知订单会被永久 SKIPPED（漏发事故）。
 *   因此本脚本用 `MigrationMarker`（表 `_MigrationMarker`，key='order_rep_notify_backfill_v1'）
 *   保证整个数据库生命周期内只回填一次：marker 存在 → 直接 no-op 退出 0。
 *   marker 在「检查 → 回填 → 写入」同一事务内落库；部分失败整事务回滚，下次可安全重试。
 *   并发：主键 CAS（create 冲突 P2002）保证只有一个事务成为迁移执行者。
 *
 * 用法：
 *   npx tsx scripts/backfill-order-rep-notify-skipped.ts --cutoff <ISO8601> [--max-candidates <n>]
 *
 * 示例：
 *   npx tsx scripts/backfill-order-rep-notify-skipped.ts --cutoff 2026-07-26T10:00:00+08:00
 *
 * 无 --cutoff 且 marker 不存在 → 报错退出（非零）。仅更新 createdAt <= cutoff AND
 * repNotifyStatus='PENDING'。--max-candidates：候选数超过 n 时报错退出（非零），
 * 防异常大批量回填被静默执行（部署脚本可经 ORDER_REP_BACKFILL_MAX_CANDIDATES 传入）。
 *
 * ⚠️ runbook：本脚本必须与首次引入 repNotify 字段的 npx prisma db push 在同一停服窗口
 * 完成，且先于新代码启动。部署脚本（prod/demo）每次部署都会调用本脚本——marker 保证
 * 只有首次真正执行，后续为安全 no-op。`_MigrationMarker` 已建模进 schema.prisma，
 * db push 不会再把它当外部表 drift。
 */

import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const MARKER_KEY = "order_rep_notify_backfill_v1";

function parseCutoff(raw: string): Date {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`--cutoff 不是合法的 ISO 8601 时间：${raw}`);
  }
  return d;
}

function parseArgs(argv: string[]): { cutoff: Date | null; maxCandidates: number | null } {
  const idx = argv.indexOf("--cutoff");
  const cutoff = idx !== -1 && idx < argv.length - 1 ? parseCutoff(argv[idx + 1]) : null;

  let maxCandidates: number | null = null;
  const midx = argv.indexOf("--max-candidates");
  if (midx !== -1) {
    if (midx === argv.length - 1) {
      throw new Error("--max-candidates 需要一个非负整数参数");
    }
    const n = Number(argv[midx + 1]);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`--max-candidates 必须是非负整数：${argv[midx + 1]}`);
    }
    maxCandidates = n;
  }
  return { cutoff, maxCandidates };
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

async function main() {
  const { cutoff, maxCandidates } = parseArgs(process.argv.slice(2));

  // 快路径：后续常规部署绝大多数命中，避免开事务。
  const existingFast = await prisma.migrationMarker.findUnique({ where: { key: MARKER_KEY } });
  if (existingFast != null) {
    console.log(`[BACKFILL][ORDER_REP] 一次性迁移已完成（${existingFast.value}），本次调用为 no-op。`);
    await prisma.$disconnect();
    return;
  }

  if (!cutoff) {
    throw new Error(
      "缺少必需参数 --cutoff <ISO8601>（首次回填必填；marker 存在后可省略）。\n" +
        "用法：npx tsx scripts/backfill-order-rep-notify-skipped.ts --cutoff 2026-07-26T10:00:00+08:00 [--max-candidates <n>]",
    );
  }

  type TxResult =
    | { kind: "noop"; value: string }
    | { kind: "done"; updated: number; markerValue: string };

  let result: TxResult;
  try {
    result = await prisma.$transaction(async (tx) => {
      // 事务内再检查：并发部署时只有一个执行者继续。
      const existing = await tx.migrationMarker.findUnique({ where: { key: MARKER_KEY } });
      if (existing != null) {
        return { kind: "noop" as const, value: existing.value };
      }

      const candidateCount = await tx.order.count({
        where: { createdAt: { lte: cutoff }, repNotifyStatus: "PENDING" },
      });

      console.log(`[BACKFILL][ORDER_REP] cutoff=${cutoff.toISOString()}`);
      console.log(`[BACKFILL][ORDER_REP] 候选（createdAt<=cutoff AND repNotifyStatus='PENDING'）：${candidateCount} 行`);

      if (maxCandidates != null && candidateCount > maxCandidates) {
        throw new Error(
          `候选数 ${candidateCount} 超过 --max-candidates=${maxCandidates}，疑似异常大批量回填，已中止。请人工核对后调整上限重跑。`,
        );
      }

      let updated = 0;
      if (candidateCount > 0) {
        const updateResult = await tx.order.updateMany({
          where: { createdAt: { lte: cutoff }, repNotifyStatus: "PENDING" },
          data: {
            repNotifyStatus: "SKIPPED",
            repNotifyLockedAt: null,
            repNotifyError: "Legacy order backfilled at deploy",
          },
        });
        updated = updateResult.count;
        console.log(`[BACKFILL][ORDER_REP] 已将 ${updated} 行订单置为 SKIPPED。`);
      } else {
        console.log("[BACKFILL][ORDER_REP] 无需更新（已全部为非 PENDING）。");
      }

      const markerValue = `cutoff=${cutoff.toISOString()} updated=${updated}`;
      // create（非 upsert）：主键冲突 → 整事务回滚，由外层按 P2002 视为并发 no-op。
      await tx.migrationMarker.create({
        data: { key: MARKER_KEY, value: markerValue },
      });
      return { kind: "done" as const, updated, markerValue };
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const winner = await prisma.migrationMarker.findUnique({ where: { key: MARKER_KEY } });
      // 只有读到同 key marker 才能证明另一执行者已完成迁移；否则可能是无关唯一约束冲突。
      if (winner == null) {
        throw err;
      }
      console.log(
        `[BACKFILL][ORDER_REP] 并发迁移已被其他执行者完成（${winner.value}），本次为 no-op。`,
      );
      await prisma.$disconnect();
      return;
    }
    throw err;
  }

  if (result.kind === "noop") {
    console.log(`[BACKFILL][ORDER_REP] 一次性迁移已完成（${result.value}），本次调用为 no-op。`);
  } else {
    console.log(`[BACKFILL][ORDER_REP] 一次性迁移 marker 已写入（${result.markerValue}）。后续部署调用将为 no-op。`);
    console.log("[BACKFILL][ORDER_REP] 完成。");
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(`[BACKFILL][ORDER_REP] 失败：${err instanceof Error ? err.message : err}`);
  prisma.$disconnect()
    .finally(() => process.exit(1));
});
