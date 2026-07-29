/**
 * Backfill: deduplicate + set sourceOpenKey for existing OPEN pushed tasks.
 *
 * Usage: npx tsx scripts/backfill-source-open-key.ts
 *
 * Designed to run while the service is live. All destructive writes use
 * conditional WHERE clauses (status = 'OPEN', sourceOpenKey IS NULL) so
 * rows that changed since the last read are not accidentally overwritten.
 * Exits non‑zero if any OPEN pushed task still lacks sourceOpenKey after
 * the full run.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  let exitCode = 0;

  // ── Phase 1: Deduplicate same‑source OPEN tasks ──────────────────────
  console.log("[BACKFILL] Phase 1: Checking for duplicate OPEN pushed tasks...");

  const dupes = await prisma.$queryRawUnsafe<Array<{ sourceType: string; sourceId: string; cnt: number }>>(
    `SELECT sourceType, sourceId, COUNT(*) as cnt
     FROM CrmFollowUpTask
     WHERE status = 'OPEN' AND sourceType IS NOT NULL AND sourceId IS NOT NULL
     GROUP BY sourceType, sourceId
     HAVING cnt > 1`
  );

  const affectedProfiles = new Set<string>();
  let dedupCancelled = 0;

  for (const d of dupes) {
    const tasks = await prisma.crmFollowUpTask.findMany({
      where: { sourceType: d.sourceType, sourceId: d.sourceId, status: "OPEN" },
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, profileId: true },
    });

    const keeper = tasks[0];
    for (let i = 1; i < tasks.length; i++) {
      console.log(`[BACKFILL] DEDUP: cancelling "${tasks[i].title}" (${tasks[i].id}), keeping "${keeper.title}" (${keeper.id})`);
      // Conditional: only cancel if still OPEN (not already cancelled/completed between reads)
      const r = await prisma.crmFollowUpTask.updateMany({
        where: { id: tasks[i].id, status: "OPEN" },
        data: { status: "CANCELLED", sourceOpenKey: null },
      });
      if (r.count > 0) {
        affectedProfiles.add(tasks[i].profileId);
        dedupCancelled++;
      }
    }
  }

  console.log(`[BACKFILL] Phase 1 done: deduped=${dedupCancelled} duplicate tasks`);

  // ── Phase 2: Recalculate nextFollowUpAt for affected profiles ────────
  if (affectedProfiles.size > 0) {
    console.log(`[BACKFILL] Phase 2: Recalculating nextFollowUpAt for ${affectedProfiles.size} profiles...`);
    for (const pid of affectedProfiles) {
      const nextOpen = await prisma.crmFollowUpTask.findFirst({
        where: { profileId: pid, status: "OPEN" },
        orderBy: { dueAt: "asc" },
        select: { dueAt: true },
      });
      await prisma.crmCustomerProfile.update({
        where: { id: pid },
        data: { nextFollowUpAt: nextOpen?.dueAt ?? null },
      });
    }
    console.log("[BACKFILL] Phase 2 done");
  }

  // ── Phase 3: Backfill sourceOpenKey on remaining NULL rows ────────────
  console.log("[BACKFILL] Phase 3: Backfilling sourceOpenKey...");

  const tasks = await prisma.crmFollowUpTask.findMany({
    where: {
      status: "OPEN",
      sourceType: { not: null },
      sourceId: { not: null },
      sourceOpenKey: null,
    },
    select: { id: true, sourceType: true, sourceId: true, title: true, profileId: true },
  });

  console.log(`[BACKFILL] Found ${tasks.length} tasks to backfill`);

  let updated = 0;
  let conflictCancelled = 0;
  const cancelledPh3ProfileIds = new Set<string>();

  for (const t of tasks) {
    if (!t.sourceType || !t.sourceId) continue;
    const key = `push:${t.sourceType}:${t.sourceId}`;

    try {
      // Conditional: only set key if the row is still OPEN and key is still NULL
      const r = await prisma.crmFollowUpTask.updateMany({
        where: { id: t.id, status: "OPEN", sourceOpenKey: null },
        data: { sourceOpenKey: key },
      });
      if (r.count > 0) updated++;
      // If r.count === 0, the row was completed/cancelled between read and now — skip silently
    } catch (e) {
      if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002") {
        // Key already taken by a concurrently-created keyed task.
        // Conditional: only cancel if still OPEN and key is still NULL.
        console.log(`[BACKFILL] CONFLICT: task ${t.id} ("${t.title}") key already taken, cancelling duplicate`);
        const r2 = await prisma.crmFollowUpTask.updateMany({
          where: { id: t.id, status: "OPEN", sourceOpenKey: null },
          data: { status: "CANCELLED", sourceOpenKey: null },
        });
        if (r2.count > 0) {
          cancelledPh3ProfileIds.add(t.profileId);
          conflictCancelled++;
        }
      } else {
        console.error(`[BACKFILL] FAIL: task ${t.id} ("${t.title}"): ${String(e)}`);
        exitCode = 1;
      }
    }
  }

  if (cancelledPh3ProfileIds.size > 0) {
    console.log(`[BACKFILL] Phase 3a: Recalculating nextFollowUpAt for ${cancelledPh3ProfileIds.size} conflict-cancelled profiles...`);
    for (const pid of cancelledPh3ProfileIds) {
      const nextOpen = await prisma.crmFollowUpTask.findFirst({
        where: { profileId: pid, status: "OPEN" },
        orderBy: { dueAt: "asc" },
        select: { dueAt: true },
      });
      await prisma.crmCustomerProfile.update({
        where: { id: pid },
        data: { nextFollowUpAt: nextOpen?.dueAt ?? null },
      });
    }
  }

  console.log(`[BACKFILL] Phase 3 done: updated=${updated}, conflict_cancelled=${conflictCancelled}`);

  // ── Sanity check ────────────────────────────────────────────────────
  const remaining = await prisma.crmFollowUpTask.count({
    where: { status: "OPEN", sourceType: { not: null }, sourceId: { not: null }, sourceOpenKey: null },
  });

  if (remaining > 0) {
    console.error(`[BACKFILL] FAIL: ${remaining} OPEN pushed tasks still have NULL sourceOpenKey after backfill`);
    exitCode = 1;
  } else {
    console.log("[BACKFILL] OK: All OPEN pushed tasks now have sourceOpenKey set");
  }

  await prisma.$disconnect();
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("[BACKFILL] Fatal error:", err);
  process.exit(1);
});
