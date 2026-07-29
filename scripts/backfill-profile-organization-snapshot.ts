/**
 * Backfill CrmCustomerProfile.organization 快照，使其等于 Organization.canonicalName。
 *
 * 默认只读 (--precheck)。显式 --apply 才写入。默认仅修复空快照；
 * 非空冲突输出待治理清单，不自动覆盖（除非 --fix-mismatches）。
 *
 * Usage:
 *   npx tsx scripts/backfill-profile-organization-snapshot.ts --precheck
 *   npx tsx scripts/backfill-profile-organization-snapshot.ts --apply
 *   npx tsx scripts/backfill-profile-organization-snapshot.ts --verify
 *   DATABASE_URL="file:/path/to/dev.db" npx tsx scripts/backfill-profile-organization-snapshot.ts --precheck
 */

import { prisma } from "../src/lib/prisma";

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const VERIFY = args.has("--verify");
const INCLUDE_INACTIVE = args.has("--include-inactive");
const FIX_MISMATCHES = args.has("--fix-mismatches");
// default mode is precheck when neither apply nor verify
const PRECHECK = args.has("--precheck") || (!APPLY && !VERIFY);

type Row = {
  id: string;
  name: string | null;
  organizationId: string;
  organization: string | null;
  organizationRawInput: string | null;
  archived: boolean;
  deleted: boolean;
  org: { id: string; canonicalName: string; deleted: boolean } | null;
};

function isEmptySnapshot(v: string | null | undefined): boolean {
  return v == null || v.trim() === "";
}

async function loadCandidates(): Promise<Row[]> {
  return prisma.crmCustomerProfile.findMany({
    where: {
      organizationId: { not: null },
      ...(INCLUDE_INACTIVE ? {} : { archived: false, deleted: false }),
      org: { deleted: false },
    },
    select: {
      id: true,
      name: true,
      organizationId: true,
      organization: true,
      organizationRawInput: true,
      archived: true,
      deleted: true,
      org: { select: { id: true, canonicalName: true, deleted: true } },
    },
    orderBy: { id: "asc" },
  }) as Promise<Row[]>;
}

function classify(rows: Row[]) {
  const empty: Row[] = [];
  const mismatch: Row[] = [];
  const ok: Row[] = [];
  for (const r of rows) {
    if (!r.organizationId || !r.org || r.org.deleted) continue;
    if (isEmptySnapshot(r.organization)) empty.push(r);
    else if (r.organization !== r.org.canonicalName) mismatch.push(r);
    else ok.push(r);
  }
  return { empty, mismatch, ok };
}

function printSamples(label: string, rows: Row[], limit = 20) {
  console.log(`\n${label} (showing up to ${limit}/${rows.length}):`);
  for (const r of rows.slice(0, limit)) {
    console.log(
      `  id=${r.id} name=${JSON.stringify(r.name)} snapshot=${JSON.stringify(r.organization)} canonical=${JSON.stringify(r.org?.canonicalName)}`,
    );
  }
}

async function verify(): Promise<number> {
  const rows = await loadCandidates();
  const { empty, mismatch } = classify(rows);
  console.log(`[verify] empty=${empty.length} mismatch=${mismatch.length} (include-inactive=${INCLUDE_INACTIVE})`);
  if (empty.length) printSamples("EMPTY", empty);
  if (mismatch.length) printSamples("MISMATCH (governance)", mismatch);
  return empty.length + (FIX_MISMATCHES ? mismatch.length : 0);
}

async function main() {
  console.log(
    `[backfill-profile-organization-snapshot] mode=${APPLY ? "APPLY" : VERIFY ? "VERIFY" : "PRECHECK"} includeInactive=${INCLUDE_INACTIVE} fixMismatches=${FIX_MISMATCHES}`,
  );

  if (VERIFY && !APPLY) {
    const unresolved = await verify();
    if (unresolved > 0) {
      console.error(`[verify] FAIL unresolved=${unresolved}`);
      process.exit(1);
    }
    console.log("[verify] OK");
    return;
  }

  const rows = await loadCandidates();
  const { empty, mismatch, ok } = classify(rows);
  console.log(`Total with FK: ${rows.length}`);
  console.log(`  ok:        ${ok.length}`);
  console.log(`  empty:     ${empty.length}`);
  console.log(`  mismatch:  ${mismatch.length}`);
  printSamples("EMPTY", empty);
  printSamples("MISMATCH (not auto-fixed unless --fix-mismatches)", mismatch);

  const toFix = FIX_MISMATCHES ? [...empty, ...mismatch] : empty;

  if (PRECHECK && !APPLY) {
    console.log(`\n(DRY-RUN) Would update ${toFix.length} profile(s). Re-run with --apply to write.`);
    return;
  }

  if (toFix.length === 0) {
    console.log("Nothing to apply.");
    if (VERIFY || APPLY) {
      const unresolved = await verify();
      if (unresolved > 0) process.exit(1);
    }
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    let updated = 0;
    for (const r of toFix) {
      if (!r.org) continue;
      // 非空冲突：若 raw 为空则保留旧快照文本到 organizationRawInput，避免无审计覆盖
      const data: { organization: string; organizationRawInput?: string | null } = {
        organization: r.org.canonicalName,
      };
      if (
        FIX_MISMATCHES &&
        !isEmptySnapshot(r.organization) &&
        r.organization !== r.org.canonicalName &&
        isEmptySnapshot(r.organizationRawInput)
      ) {
        data.organizationRawInput = r.organization;
      }
      await tx.crmCustomerProfile.update({
        where: { id: r.id },
        data,
      });
      updated++;
    }
    return updated;
  });

  console.log(`\nUpdated ${result} profile(s).`);
  const unresolved = await verify();
  if (unresolved > 0) {
    console.error(`[post-apply verify] FAIL unresolved=${unresolved}`);
    process.exit(1);
  }
  console.log("[post-apply verify] OK");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
