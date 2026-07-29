/**
 * 下单代表邮件通知 — FAILED 订单人工重置脚本（受控补发入口，CAS）。
 * 见 docs/order-rep-notify-email-design-2026-07-26.md §5.6 / §7.1 第 10 项
 *
 * 默认只处理「已耗尽重试」的订单（FAILED AND repNotifyAttempts >= 3）：
 *   - attempts < 3 的 FAILED 由 cron 自动重试，重置为 attempts=0 会凭空延长重试次数。
 *   - 单订单 --order-id 默认同样要求 attempts 已到上限；确需提前重置（如确认是配置问题
 *     而非临时故障）须显式加 --force-retryable。
 *
 * 用法：
 *   npx tsx scripts/reset-order-rep-notify.ts --order-id <id> [--force-retryable] [--yes]
 *   npx tsx scripts/reset-order-rep-notify.ts --all-failed --yes
 *
 * 行为约束（§5.6）：
 *   - 预览打印：数据库路径（从 DATABASE_URL 解析，防连错环境）、候选数、涉及代表数、
 *     每单订单号 / 代表邮箱 / 原 repNotifyError。
 *   - 批量模式（--all-failed）必须 --yes；单订单可交互确认。
 *   - 写入 compare-and-set（updateMany where 含原 status + attempts）：
 *     count===0 报告「状态已被 cron 改变，未重置」，绝不覆盖 PROCESSING/SENT/SKIPPED。
 *   - SENT/SKIPPED/PROCESSING 订单直接拒绝并重述当前状态。
 *   - 重置后由下一轮 cron 自然拾起重发，脚本本身不发邮件。
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const MAX_ATTEMPTS = 3;

interface ResetCandidate {
  id: string;
  orderNo: string;
  repNotifyStatus: string;
  repNotifyAttempts: number;
  repNotifyError: string | null;
  representativeId: string | null;
  repName: string | null;
  repEmail: string | null;
}

/** 从 DATABASE_URL 解析数据库路径（file: 协议取路径；否则原样展示 url）。 */
function resolveDatabaseLabel(): string {
  const url = process.env.DATABASE_URL;
  if (!url) return "(DATABASE_URL 未设置)";
  if (url.startsWith("file:")) {
    return url.slice("file:".length);
  }
  return url;
}

function usage(): string {
  return [
    "用法：",
    "  npx tsx scripts/reset-order-rep-notify.ts --order-id <id> [--force-retryable] [--yes]",
    "  npx tsx scripts/reset-order-rep-notify.ts --all-failed --yes",
    "",
    "默认仅处理 FAILED AND repNotifyAttempts >= 3（已耗尽重试）。",
    "--force-retryable：允许重置 attempts < 3 的 FAILED 单订单（确认为非临时故障时使用）。",
    "--all-failed：批量重置所有 FAILED AND attempts>=3；必须配合 --yes。",
  ].join("\n");
}

async function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(`${prompt} [y/N] `);
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.once("data", (chunk) => {
      data += chunk;
      process.stdin.pause();
      resolve(data.trim().toLowerCase() === "y" || data.trim().toLowerCase() === "yes");
    });
  });
}

/** 加载单个订单为候选（含代表信息）；不存在返回 null。 */
async function loadOrderCandidate(id: string): Promise<ResetCandidate | null> {
  const o = await prisma.order.findUnique({
    where: { id },
    select: {
      id: true,
      orderNo: true,
      repNotifyStatus: true,
      repNotifyAttempts: true,
      repNotifyError: true,
      representativeId: true,
      representative: { select: { name: true, email: true } },
    },
  });
  if (!o) return null;
  return {
    id: o.id,
    orderNo: o.orderNo,
    repNotifyStatus: o.repNotifyStatus,
    repNotifyAttempts: o.repNotifyAttempts,
    repNotifyError: o.repNotifyError,
    representativeId: o.representativeId,
    repName: o.representative?.name ?? null,
    repEmail: o.representative?.email ?? null,
  };
}

function printCandidates(cands: ResetCandidate[]): void {
  console.log(`  候选数量：${cands.length}`);
  const repIds = new Set(cands.map((c) => c.representativeId).filter((x): x is string => !!x));
  console.log(`  涉及代表数：${repIds.size}`);
  for (const c of cands) {
    const rep = c.repEmail ? `${c.repName || "—"} <${c.repEmail}>` : "(无代表)";
    console.log(
      `  - ${c.orderNo} (${c.id}) | attempts=${c.repNotifyAttempts} | rep=${rep} | error=${c.repNotifyError || "—"}`,
    );
  }
}

/**
 * CAS 重置单个订单。where 含原 status + attempts：若 cron 在预览后已把 FAILED 抢成
 * PROCESSING（或其它状态），count===0，报告「状态已被 cron 改变」绝不覆盖。
 */
async function casReset(c: ResetCandidate): Promise<"reset" | "race"> {
  const { count } = await prisma.order.updateMany({
    where: { id: c.id, repNotifyStatus: "FAILED", repNotifyAttempts: c.repNotifyAttempts },
    data: {
      repNotifyStatus: "PENDING",
      repNotifyAttempts: 0,
      repNotifyLockedAt: null,
      repNotifyError: null,
    },
  });
  return count === 0 ? "race" : "reset";
}

async function main() {
  const args = process.argv.slice(2);
  const forceRetryable = args.includes("--force-retryable");
  const yes = args.includes("--yes");
  const allFailed = args.includes("--all-failed");

  const orderIdIdx = args.indexOf("--order-id");
  const orderId =
    orderIdIdx !== -1 && orderIdIdx < args.length - 1 ? args[orderIdIdx + 1] : null;

  if (!allFailed && !orderId) {
    console.error(usage());
    process.exit(1);
  }
  if (allFailed && orderId) {
    console.error("不能同时指定 --all-failed 与 --order-id。\n" + usage());
    process.exit(1);
  }
  if (allFailed && !yes) {
    console.error("批量模式 --all-failed 必须配合 --yes（防误操作）。\n" + usage());
    process.exit(1);
  }
  if (forceRetryable && !orderId) {
    console.error("--force-retryable 仅在单订单 --order-id 模式下可用。\n" + usage());
    process.exit(1);
  }

  console.log(`[RESET][ORDER_REP] 数据库：${resolveDatabaseLabel()}`);

  let candidates: ResetCandidate[];

  if (allFailed) {
    // 候选集 = FAILED AND attempts >= 3（§5.6）
    const rows = await prisma.order.findMany({
      where: { repNotifyStatus: "FAILED", repNotifyAttempts: { gte: MAX_ATTEMPTS } },
      select: {
        id: true,
        orderNo: true,
        repNotifyStatus: true,
        repNotifyAttempts: true,
        repNotifyError: true,
        representativeId: true,
        representative: { select: { name: true, email: true } },
      },
    });
    candidates = rows.map((o) => ({
      id: o.id,
      orderNo: o.orderNo,
      repNotifyStatus: o.repNotifyStatus,
      repNotifyAttempts: o.repNotifyAttempts,
      repNotifyError: o.repNotifyError,
      representativeId: o.representativeId,
      repName: o.representative?.name ?? null,
      repEmail: o.representative?.email ?? null,
    }));
  } else {
    // 单订单模式
    const c = await loadOrderCandidate(orderId!);
    if (!c) {
      console.error(`[RESET][ORDER_REP] 订单不存在：${orderId}`);
      await prisma.$disconnect();
      process.exit(1);
    }
    // 终态/进行中状态拒绝
    if (c.repNotifyStatus === "SENT" || c.repNotifyStatus === "SKIPPED" || c.repNotifyStatus === "PROCESSING") {
      console.error(
        `[RESET][ORDER_REP] 拒绝重置：订单 ${c.orderNo} 当前状态为 ${c.repNotifyStatus}（仅 FAILED 可重置）。`,
      );
      await prisma.$disconnect();
      process.exit(1);
    }
    if (c.repNotifyStatus !== "FAILED") {
      // PENDING 等：无需重置
      console.error(
        `[RESET][ORDER_REP] 订单 ${c.orderNo} 当前状态为 ${c.repNotifyStatus}（非 FAILED），无需重置。`,
      );
      await prisma.$disconnect();
      process.exit(1);
    }
    // 默认要求 attempts >= 3；attempts < 3 须 --force-retryable
    if (c.repNotifyAttempts < MAX_ATTEMPTS && !forceRetryable) {
      console.error(
        `[RESET][ORDER_REP] 拒绝重置：订单 ${c.orderNo} 为 FAILED 但 attempts=${c.repNotifyAttempts} < ${MAX_ATTEMPTS}，` +
          `cron 会自动重试。确需提前重置请加 --force-retryable。`,
      );
      await prisma.$disconnect();
      process.exit(1);
    }
    candidates = [c];
  }

  console.log("[RESET][ORDER_REP] 预览：");
  printCandidates(candidates);

  if (candidates.length === 0) {
    console.log("[RESET][ORDER_REP] 无候选订单。完成。");
    await prisma.$disconnect();
    return;
  }

  // 确认
  if (!yes) {
    const ok = await confirm("确认重置以上订单为 PENDING（下一轮 cron 将重发）？");
    if (!ok) {
      console.log("[RESET][ORDER_REP] 用户取消。未做任何更改。");
      await prisma.$disconnect();
      return;
    }
  }

  let reset = 0;
  let raced = 0;
  for (const c of candidates) {
    const r = await casReset(c);
    if (r === "reset") {
      reset++;
    } else {
      raced++;
      console.log(`  [RACE] ${c.orderNo} (${c.id}) 状态已被 cron 改变，未重置。`);
    }
  }

  console.log(`[RESET][ORDER_REP] 完成：重置 ${reset} 单，${raced} 单因状态已变未重置。下一轮 cron 将自动重发。`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(`[RESET][ORDER_REP] 失败：${err instanceof Error ? err.message : err}`);
  prisma.$disconnect()
    .finally(() => process.exit(1));
});
