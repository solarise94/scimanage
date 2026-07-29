/**
 * Backfill Project.representativeId from Project.representative text field.
 *
 * Finds non-deleted projects where representativeId is null but representative
 * text is non-empty, and attempts to match to an active Representative by name.
 *
 * Usage:
 *   npx tsx scripts/backfill-representative-id.ts              # write mode
 *   npx tsx scripts/backfill-representative-id.ts --dry-run    # report only
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface BackfillResult {
  projectId: string;
  projectName: string;
  representative: string;
  matched: boolean;
  matchedRepId?: string;
  matchedRepName?: string;
  reason: string;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  // Find all active Representatives
  const reps = await prisma.representative.findMany({
    where: { archived: false },
    select: { id: true, name: true, email: true },
  });

  console.log(`Found ${reps.length} active representatives\n`);

  // Build lookup: normalized name → rep
  const nameMap = new Map<string, typeof reps>();
  for (const rep of reps) {
    const key = rep.name.trim();
    const existing = nameMap.get(key);
    if (existing) {
      existing.push(rep);
    } else {
      nameMap.set(key, [rep]);
    }
  }

  // Find projects needing backfill
  const projects = await prisma.project.findMany({
    where: {
      deleted: false,
      representativeId: null,
      representative: { not: null },
      NOT: { representative: "" },
    },
    select: { id: true, name: true, representative: true },
    orderBy: { updatedAt: "desc" },
  });

  console.log(`Found ${projects.length} projects with representative text but no representativeId\n`);

  const results: BackfillResult[] = [];

  for (const project of projects) {
    const repText = project.representative!.trim();
    const matches = nameMap.get(repText);

    if (!matches || matches.length === 0) {
      results.push({
        projectId: project.id,
        projectName: project.name,
        representative: repText,
        matched: false,
        reason: "no matching active representative by name",
      });
      continue;
    }

    if (matches.length > 1) {
      results.push({
        projectId: project.id,
        projectName: project.name,
        representative: repText,
        matched: false,
        reason: `ambiguous: ${matches.length} representatives with name "${repText}" (${matches.map((r) => r.email).join(", ")})`,
      });
      continue;
    }

    const rep = matches[0];
    results.push({
      projectId: project.id,
      projectName: project.name,
      representative: repText,
      matched: true,
      matchedRepId: rep.id,
      matchedRepName: rep.name,
      reason: "exact name match",
    });

    if (!dryRun) {
      await prisma.project.update({
        where: { id: project.id },
        data: { representativeId: rep.id },
      });
    }
  }

  // Summary
  const matched = results.filter((r) => r.matched);
  const skipped = results.filter((r) => !r.matched);

  console.log("=".repeat(60));
  console.log(`Summary: ${matched.length} matched, ${skipped.length} skipped, ${results.length} total`);
  console.log("=".repeat(60));

  if (skipped.length > 0) {
    console.log("\nSkipped:");
    for (const r of skipped) {
      console.log(`  [${r.projectId}] "${r.projectName}" — rep="${r.representative}" — ${r.reason}`);
    }
  }

  if (matched.length > 0) {
    console.log(`\nMatched${dryRun ? " (DRY RUN)" : ""}:`);
    for (const r of matched) {
      console.log(`  [${r.projectId}] "${r.projectName}" → ${r.matchedRepName} (${r.matchedRepId})`);
    }
  }

  if (dryRun) {
    console.log("\nDRY RUN — no changes written. Remove --dry-run to apply.");
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
