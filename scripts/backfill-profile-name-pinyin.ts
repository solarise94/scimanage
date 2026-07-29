/**
 * Backfill `CrmCustomerProfile.namePinyin` for legacy rows.
 *
 * docs/agent-customer-name-resolution-hotload-pinyin-design-2026-07-18.md §4.4
 *
 * 处理范围：
 *   - 仅处理 `namePinyin IS NULL` 或 `namePinyin = ""` 的 Profile；
 *   - 且 `name` 非空（trim 后非空串）才计算并写入；
 *   - `name` 为空（含全空白）的行跳过，保留 namePinyin 为 null。
 *
 * 特性：
 *   - 幂等：可重复运行；已写入非空 namePinyin 的行不会被再次触碰；
 *   - 分批：每批 200 条，逐条 update，避免 SQLite 参数上限与长事务；
 *   - 不使用 $transaction：单条失败不影响其他行，最终汇总异常数。
 *   - 单次收敛：先一次性查出待处理 id 的静态快照（仅 select id，按 id 升序），
 *     再按 id 批次遍历并逐条 update。分页基于静态 id 快照而不是 cursor 扫描
 *     动态结果集，避免批内 update 改变 where 结果集导致 cursor/skip 漏行。
 *
 * 用法：
 *   npx tsx scripts/backfill-profile-name-pinyin.ts
 *
 * 数据库：默认读取仓库根 `.env` 的 DATABASE_URL（dev 库）。生产环境请先
 * 确认 DATABASE_URL 指向目标库，并在低峰期运行。
 */

import { prisma } from "../src/lib/prisma";
import { toPinyinToneless } from "../src/lib/crm/pinyin";

const BATCH_SIZE = 200;

async function main() {
  console.log("[BACKFILL] CrmCustomerProfile.namePinyin: starting...");

  const whereClause = {
    OR: [{ namePinyin: null }, { namePinyin: "" }],
  };

  const totalCandidates = await prisma.crmCustomerProfile.count({ where: whereClause });
  console.log(`[BACKFILL] Candidates (namePinyin IS NULL OR = ""): ${totalCandidates}`);

  let processed = 0;
  let updated = 0;
  let skippedEmptyName = 0;
  let errors = 0;

  // 先查全量待处理 id 的静态快照（仅 select id，按 id 升序）。后续 update 会改变
  // where 结果集（namePinyin 由空变非空），但分页基于这份静态快照，不再受影响，
  // 保证单次运行完全收敛。
  //
  // 实现采用游标分页读取 id 列表，但读取阶段不做任何 update，因此结果集在读取
  // 期间是稳定的；读取完成后的 update 不再依赖 where 扫描。
  const candidateIds: string[] = [];
  let listCursor: string | undefined;
  // 安全上限：防止极端情况下的无限循环。
  const listHardCap = totalCandidates + BATCH_SIZE + 1;

  while (candidateIds.length < listHardCap) {
    const idRows = await prisma.crmCustomerProfile.findMany({
      where: whereClause,
      select: { id: true },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      ...(listCursor ? { skip: 1, cursor: { id: listCursor } } : {}),
    });

    if (idRows.length === 0) break;

    for (const r of idRows) candidateIds.push(r.id);
    listCursor = idRows[idRows.length - 1].id;

    if (idRows.length < BATCH_SIZE) break;
  }

  console.log(`[BACKFILL] Collected candidate id snapshot: ${candidateIds.length}`);

  // 按 id 批次（每批 BATCH_SIZE）遍历静态快照，逐条 update。
  for (let i = 0; i < candidateIds.length; i += BATCH_SIZE) {
    const batchIds = candidateIds.slice(i, i + BATCH_SIZE);

    // 批内重新拉取 name（name 在读取快照后理论上不变，但显式 fetch 保证一致性）。
    const rows = await prisma.crmCustomerProfile.findMany({
      where: { id: { in: batchIds } },
      select: { id: true, name: true },
      orderBy: { id: "asc" },
    });

    for (const row of rows) {
      processed++;
      const trimmedName = row.name?.trim() ?? "";
      if (!trimmedName) {
        // name 为空：不写 namePinyin（保持 null），计入跳过。
        skippedEmptyName++;
        continue;
      }
      const pinyinValue = toPinyinToneless(trimmedName);
      if (!pinyinValue) {
        // 极端情况：name 非空但拼音函数返回空（理论上不会发生）。
        skippedEmptyName++;
        continue;
      }
      try {
        await prisma.crmCustomerProfile.update({
          where: { id: row.id },
          data: { namePinyin: pinyinValue },
          select: { id: true },
        });
        updated++;
      } catch (err) {
        errors++;
        console.error(`[BACKFILL] Error updating profile ${row.id} (name="${row.name}"):`, err);
      }
    }

    console.log(
      `[BACKFILL] Progress: processed=${processed} updated=${updated} skipped=${skippedEmptyName} errors=${errors}`,
    );
  }

  console.log("─────────────────────────────────────────────");
  console.log(`[BACKFILL] Done.`);
  console.log(`[BACKFILL]   total candidates : ${totalCandidates}`);
  console.log(`[BACKFILL]   processed       : ${processed}`);
  console.log(`[BACKFILL]   updated         : ${updated}`);
  console.log(`[BACKFILL]   skipped (empty) : ${skippedEmptyName}`);
  console.log(`[BACKFILL]   errors          : ${errors}`);

  // 校验：还有多少行应该被处理却仍为空。
  const remaining = await prisma.crmCustomerProfile.count({
    where: {
      AND: [whereClause, { name: { not: "" } }, { NOT: { name: null } }],
    },
  });
  if (remaining > 0) {
    console.error(`[BACKFILL] WARN: ${remaining} profiles with non-empty name still have null/empty namePinyin.`);
  } else {
    console.log(`[BACKFILL] OK: all profiles with non-empty name have namePinyin populated.`);
  }

  await prisma.$disconnect();
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[BACKFILL] Fatal error:", err);
  prisma.$disconnect().finally(() => process.exit(1));
});
