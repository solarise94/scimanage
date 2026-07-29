/**
 * Backfill and verify `User.passwordInitialized` for historical users.
 *
 * Run after `prisma db push` adds the `passwordInitialized` column.
 *
 * Rules (idempotent — safe to re-run):
 * - Never completed ACCOUNT_SETUP (has invitation with usedAt=null, and no
 *   used ACCOUNT_SETUP exists) -> passwordInitialized=false
 * - Completed at least one ACCOUNT_SETUP (usedAt != null) -> true
 * - No ACCOUNT_SETUP invitation at all (legacy activated users) -> true
 *
 * Modes:
 *   (default) write + verify
 *   --check   read-only verification (no writes)
 *
 * Usage:
 *   npx tsx scripts/backfill-user-password-initialized.ts
 *   npx tsx scripts/backfill-user-password-initialized.ts --check
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const checkOnly = process.argv.includes("--check");

async function main() {
  console.log(
    `[backfill] Starting passwordInitialized ${checkOnly ? "check" : "backfill"}...`,
  );

  const totalUsers = await prisma.user.count();
  console.log(`[backfill] Total users: ${totalUsers}`);

  // Users who successfully completed ACCOUNT_SETUP at least once
  const completedSetup = await prisma.userInvitation.findMany({
    where: { purpose: "ACCOUNT_SETUP", usedAt: { not: null } },
    select: { userId: true },
    distinct: ["userId"],
  });
  const completedIds = new Set(completedSetup.map((i) => i.userId));

  // Users with any ACCOUNT_SETUP invitation (used or not)
  const anySetup = await prisma.userInvitation.findMany({
    where: { purpose: "ACCOUNT_SETUP" },
    select: { userId: true },
    distinct: ["userId"],
  });
  const anySetupIds = new Set(anySetup.map((i) => i.userId));

  // Pending = has ACCOUNT_SETUP history but never completed one
  const pendingIds = [...anySetupIds].filter((id) => !completedIds.has(id));

  console.log(`[backfill] Completed ACCOUNT_SETUP: ${completedIds.size}`);
  console.log(`[backfill] Pending ACCOUNT_SETUP (never completed): ${pendingIds.length}`);
  console.log(
    `[backfill] No ACCOUNT_SETUP (legacy activated): ${totalUsers - anySetupIds.size}`,
  );

  if (!checkOnly) {
    // Pending activation
    if (pendingIds.length > 0) {
      const setFalse = await prisma.user.updateMany({
        where: { id: { in: pendingIds } },
        data: { passwordInitialized: false },
      });
      console.log(`[backfill] Set passwordInitialized=false (pending): ${setFalse.count}`);
    } else {
      console.log(`[backfill] Set passwordInitialized=false (pending): 0`);
    }

    // Everyone else is initialized (completed setup OR legacy with no invitation)
    const setTrue = await prisma.user.updateMany({
      where:
        pendingIds.length > 0
          ? { id: { notIn: pendingIds } }
          : {},
      data: { passwordInitialized: true },
    });
    console.log(`[backfill] Set passwordInitialized=true (activated/legacy): ${setTrue.count}`);
  }

  // Verify
  const nullResult = await prisma.$queryRaw<
    Array<{ count: bigint }>
  >`SELECT COUNT(*) as count FROM User WHERE passwordInitialized IS NULL`;
  const nullCount = Number(nullResult[0]?.count ?? 0);

  const trueCount = await prisma.user.count({
    where: { passwordInitialized: true },
  });
  const falseCount = await prisma.user.count({
    where: { passwordInitialized: false },
  });

  // Cross-check: false users should equal pending set
  const falseUsers = await prisma.user.findMany({
    where: { passwordInitialized: false },
    select: { id: true },
  });
  const unexpectedFalse = falseUsers.filter((u) => !pendingIds.includes(u.id));
  const missingFalse = pendingIds.filter((id) => !falseUsers.some((u) => u.id === id));

  console.log(`[backfill] Verification:`);
  console.log(`  passwordInitialized=true:  ${trueCount}`);
  console.log(`  passwordInitialized=false: ${falseCount}`);
  console.log(`  NULL / invalid:            ${nullCount}`);
  console.log(`  unexpected false (should be true): ${unexpectedFalse.length}`);
  console.log(`  missing false (should be pending): ${missingFalse.length}`);

  const sumCheck = trueCount + falseCount + nullCount;
  let failed = false;

  if (sumCheck !== totalUsers) {
    console.error(
      `[backfill] ERROR: count mismatch (${trueCount} + ${falseCount} + ${nullCount} = ${sumCheck} != ${totalUsers})`,
    );
    failed = true;
  }

  if (nullCount !== 0) {
    console.error(`[backfill] ERROR: ${nullCount} NULL/invalid records found`);
    failed = true;
  }

  if (unexpectedFalse.length > 0 || missingFalse.length > 0) {
    console.error(
      `[backfill] ERROR: passwordInitialized does not match invitation completion state`,
    );
    failed = true;
  }

  if (failed) {
    process.exit(1);
  }

  console.log(
    checkOnly
      ? "[backfill] Check passed. No writes performed."
      : "[backfill] Done. All records verified.",
  );
}

main()
  .catch((e) => {
    console.error("[backfill] FAILED:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
