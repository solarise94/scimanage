/**
 * Backfill reminderStatus for legacy Ticket and CrmFollowUpTask rows.
 *
 * Usage: npx tsx scripts/backfill-reminder-status.ts
 *
 * - reminderSent=true  + reminderDate IS NOT NULL → SENT
 * - reminderSent=false + reminderDate IS NOT NULL → PENDING
 * - reminderSent IS NULL + reminderDate IS NOT NULL → PENDING (legacy, same as false)
 * - Skips rows that already have reminderStatus set.
 * - Skips rows with no reminderDate (never had a reminder configured).
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  let exitCode = 0;

  // ── Ticket ──────────────────────────────────────────────────────────────
  console.log("[BACKFILL] Ticket: backfilling reminderStatus from reminderSent...");

  const ticketSent = await prisma.ticket.updateMany({
    where: {
      reminderStatus: null,
      reminderDate: { not: null },
      reminderSent: true,
    },
    data: { reminderStatus: "SENT" },
  });
  console.log(`[BACKFILL] Ticket: ${ticketSent.count} ← SENT (reminderSent=true)`);

  const ticketPending = await prisma.ticket.updateMany({
    where: {
      reminderStatus: null,
      reminderDate: { not: null },
      NOT: { reminderSent: true },
    },
    data: { reminderStatus: "PENDING" },
  });
  console.log(`[BACKFILL] Ticket: ${ticketPending.count} ← PENDING (reminderSent=false/null)`);

  // ── CRM FollowUp ────────────────────────────────────────────────────────
  console.log("[BACKFILL] CrmFollowUpTask: backfilling reminderStatus...");

  const crmSent = await prisma.crmFollowUpTask.updateMany({
    where: {
      reminderStatus: null,
      reminderSent: true,
    },
    data: { reminderStatus: "SENT" },
  });
  console.log(`[BACKFILL] CrmFollowUpTask: ${crmSent.count} ← SENT (reminderSent=true)`);

  // Only backfill PENDING for OPEN tasks; DONE/CANCELLED should not get PENDING.
  const crmPending = await prisma.crmFollowUpTask.updateMany({
    where: {
      reminderStatus: null,
      status: "OPEN",
      NOT: { reminderSent: true },
    },
    data: { reminderStatus: "PENDING" },
  });
  console.log(`[BACKFILL] CrmFollowUpTask: ${crmPending.count} ← PENDING (reminderSent=false/null, status=OPEN)`);

  // ── Sanity check ────────────────────────────────────────────────────────
  const ticketRemaining = await prisma.ticket.count({
    where: { reminderStatus: null, reminderDate: { not: null } },
  });
  const crmRemaining = await prisma.crmFollowUpTask.count({
    where: { reminderStatus: null },
  });

  if (ticketRemaining > 0) {
    console.error(`[BACKFILL] FAIL: ${ticketRemaining} tickets with reminderDate still have null reminderStatus`);
    exitCode = 1;
  }
  if (crmRemaining > 0) {
    // CRM follow-ups may legitimately have null status if never pushed (sourceOpenKey is null)
    // Only warn if there are rows with reminderSent but null status
    const crmStuck = await prisma.crmFollowUpTask.count({
      where: { reminderStatus: null, reminderSent: true },
    });
    if (crmStuck > 0) {
      console.error(`[BACKFILL] FAIL: ${crmStuck} CRM tasks with reminderSent=true still have null reminderStatus`);
      exitCode = 1;
    } else {
      console.log(`[BACKFILL] OK: ${crmRemaining} CRM tasks with null status (no prior reminder configured)`);
    }
  }

  if (exitCode === 0) {
    console.log("[BACKFILL] All done");
  }

  await prisma.$disconnect();
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("[BACKFILL] Fatal error:", err);
  process.exit(1);
});
