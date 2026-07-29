/**
 * Backfill Order.representativeId and Project.representativeId/representative
 * using syncProfileRepresentativeLinks（W6.9 复审 P1：复用冻结/UNASSIGNED 门禁）。
 *
 * - 跳过 deleted / archived / merged / RECALLED / RECALL_CANDIDATE
 * - UNASSIGNED 仅机构 binding 可升 ASSIGNED；SYSTEM_FALLBACK/NONE 不写代表缓存
 * - skipped 计入统计，不写 Order/Project
 *
 * Run with:
 *   npx tsx scripts/backfill-effective-representative.ts
 */

import { prisma } from "../src/lib/prisma";
import {
  PROFILE_SYNC_ASSIGNABLE_WHERE,
  syncProfileRepresentativeLinks,
} from "../src/lib/crm/customer-representative-sync";

const BATCH_SIZE = 200;

async function backfill() {
  console.log("[BACKFILL] Starting effective representative backfill (assignable Profiles only)...");

  const profiles = await prisma.crmCustomerProfile.findMany({
    where: PROFILE_SYNC_ASSIGNABLE_WHERE,
    select: { id: true, assignmentStatus: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`[BACKFILL] Assignable profiles: ${profiles.length}`);

  const sourceStats: Record<string, number> = {
    ASSIGNED: 0,
    UNASSIGNED: 0,
    SKIPPED: 0,
    ERROR: 0,
  };

  let synced = 0;
  let skipped = 0;

  for (let i = 0; i < profiles.length; i += BATCH_SIZE) {
    const batch = profiles.slice(i, i + BATCH_SIZE);
    for (const profile of batch) {
      try {
        const result = await syncProfileRepresentativeLinks(profile.id);
        if (result.skipped) {
          skipped++;
          sourceStats.SKIPPED += 1;
          continue;
        }
        synced++;
        if (profile.assignmentStatus === "ASSIGNED") sourceStats.ASSIGNED += 1;
        else sourceStats.UNASSIGNED += 1;
      } catch (err) {
        sourceStats.ERROR += 1;
        console.error(`[BACKFILL] profile ${profile.id} failed:`, err);
      }
    }
    console.log(`[BACKFILL] Processed ${Math.min(i + BATCH_SIZE, profiles.length)} / ${profiles.length}`);
  }

  console.log("\n[BACKFILL] Done!");
  console.log(`  Synced:   ${synced}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`  ASSIGNED: ${sourceStats.ASSIGNED}`);
  console.log(`  UNASSIGNED (binding-derived writes): ${sourceStats.UNASSIGNED}`);
  console.log(`  SKIPPED:  ${sourceStats.SKIPPED}`);
  console.log(`  ERROR:    ${sourceStats.ERROR}`);

  // 任何单行失败都必须让脚本以非零退出，避免停服迁移窗口误判为成功
  if (sourceStats.ERROR > 0) {
    throw new Error(`[BACKFILL] ${sourceStats.ERROR} profile(s) failed; see ERROR logs above`);
  }
}

backfill()
  .catch((err) => {
    console.error("[BACKFILL] Failed:", err);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
