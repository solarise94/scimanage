/**
 * 预检/回填 Organization / Alias / Site 的 normalized* 字段（Unicode 归一变更后）。
 *
 * 默认只读。存在未解决碰撞时 --apply 拒绝执行。
 * 碰撞覆盖：
 *   - org normalizedName 全局撞名
 *   - site 同机构 normalizedSiteName 撞名
 *   - alias 同机构内重复
 *   - alias 跨机构全局撞名（resolveOrganization findFirst 会任意命中）
 *   - alias 与其他机构 normalizedName 交叉碰撞
 *
 * Usage:
 *   npx tsx scripts/backfill-organization-unicode-normalization.ts --precheck
 *   npx tsx scripts/backfill-organization-unicode-normalization.ts --apply
 *   npx tsx scripts/backfill-organization-unicode-normalization.ts --verify
 *   DATABASE_URL="file:/path/to/dev.db" npx tsx ... --precheck
 */

import { prisma } from "../src/lib/prisma";
import {
  hasInvisibleUnicodeCharacters,
  listInvisibleUnicodeCodePoints,
  normalizeOrgName,
  normalizeSiteName,
} from "../src/lib/organization-normalize";

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const VERIFY = args.has("--verify");
const PRECHECK = args.has("--precheck") || (!APPLY && !VERIFY);

type OrgRow = { id: string; canonicalName: string; normalizedName: string; orgCode: string };
type AliasRow = { id: string; organizationId: string; alias: string; normalizedAlias: string };
type SiteRow = {
  id: string;
  organizationId: string;
  siteName: string;
  normalizedSiteName: string;
  archived: boolean;
};

function printInvisible(label: string, text: string) {
  if (!hasInvisibleUnicodeCharacters(text)) return;
  console.log(`  ${label} invisible=${listInvisibleUnicodeCodePoints(text).join(",")}`);
}

async function main() {
  console.log(
    `[backfill-organization-unicode-normalization] mode=${APPLY ? "APPLY" : VERIFY ? "VERIFY" : "PRECHECK"}`,
  );

  const [orgs, aliases, sites] = await Promise.all([
    prisma.organization.findMany({
      select: { id: true, canonicalName: true, normalizedName: true, orgCode: true },
    }),
    prisma.organizationAlias.findMany({
      select: { id: true, organizationId: true, alias: true, normalizedAlias: true },
    }),
    prisma.organizationSite.findMany({
      select: {
        id: true,
        organizationId: true,
        siteName: true,
        normalizedSiteName: true,
        archived: true,
      },
    }),
  ]);

  console.log(`Loaded orgs=${orgs.length} aliases=${aliases.length} sites=${sites.length}`);

  // --- Org normalizedName changes + unique collisions ---
  const orgNew = new Map<string, string>();
  const orgChanges: Array<{ row: OrgRow; next: string }> = [];
  for (const o of orgs as OrgRow[]) {
    const next = normalizeOrgName(o.canonicalName);
    orgNew.set(o.id, next);
    if (next !== o.normalizedName) {
      orgChanges.push({ row: o, next });
      printInvisible(`org ${o.id} ${o.orgCode}`, o.canonicalName);
    }
  }

  const orgByNorm = new Map<string, OrgRow[]>();
  for (const o of orgs as OrgRow[]) {
    const next = orgNew.get(o.id)!;
    const arr = orgByNorm.get(next) || [];
    arr.push(o);
    orgByNorm.set(next, arr);
  }
  const orgCollisions = [...orgByNorm.entries()].filter(([, arr]) => arr.length >= 2);

  // --- Alias ---
  const aliasChanges: Array<{ row: AliasRow; next: string }> = [];
  const aliasNew = new Map<string, string>();
  for (const a of aliases as AliasRow[]) {
    const next = normalizeOrgName(a.alias);
    aliasNew.set(a.id, next);
    if (next !== a.normalizedAlias) {
      aliasChanges.push({ row: a, next });
      printInvisible(`alias ${a.id}`, a.alias);
    }
  }

  // Same-org duplicate normalizedAlias
  const aliasByOrgNorm = new Map<string, AliasRow[]>();
  for (const a of aliases as AliasRow[]) {
    const next = aliasNew.get(a.id)!;
    const key = `${a.organizationId}::${next}`;
    const arr = aliasByOrgNorm.get(key) || [];
    arr.push(a);
    aliasByOrgNorm.set(key, arr);
  }
  const aliasPerOrgCollisions = [...aliasByOrgNorm.entries()].filter(([, arr]) => arr.length >= 2);

  // Global cross-org alias collision: same normalizedAlias on ≥2 distinct organizationIds
  const aliasByNormGlobal = new Map<string, AliasRow[]>();
  for (const a of aliases as AliasRow[]) {
    const next = aliasNew.get(a.id)!;
    const arr = aliasByNormGlobal.get(next) || [];
    arr.push(a);
    aliasByNormGlobal.set(next, arr);
  }
  const aliasCrossOrgCollisions = [...aliasByNormGlobal.entries()].filter(([, arr]) => {
    const orgIds = new Set(arr.map((a) => a.organizationId));
    return orgIds.size >= 2;
  });

  // Alias vs other org's normalizedName (same org alias==own name is OK)
  const aliasVsOrgNameCollisions: Array<{
    norm: string;
    alias: AliasRow;
    org: OrgRow;
  }> = [];
  for (const a of aliases as AliasRow[]) {
    const next = aliasNew.get(a.id)!;
    const collidingOrgs = orgByNorm.get(next) || [];
    for (const o of collidingOrgs) {
      if (o.id === a.organizationId) continue;
      aliasVsOrgNameCollisions.push({ norm: next, alias: a, org: o });
    }
  }

  // --- Site (critical unique) ---
  const siteChanges: Array<{ row: SiteRow; next: string }> = [];
  const siteNew = new Map<string, string>();
  for (const s of sites as SiteRow[]) {
    const next = normalizeSiteName(s.siteName);
    siteNew.set(s.id, next);
    if (next !== s.normalizedSiteName) {
      siteChanges.push({ row: s, next });
      printInvisible(`site ${s.id}`, s.siteName);
    }
  }
  const siteByOrgNorm = new Map<string, SiteRow[]>();
  for (const s of sites as SiteRow[]) {
    const next = siteNew.get(s.id)!;
    const key = `${s.organizationId}::${next}`;
    const arr = siteByOrgNorm.get(key) || [];
    arr.push(s);
    siteByOrgNorm.set(key, arr);
  }
  const siteCollisions = [...siteByOrgNorm.entries()].filter(([, arr]) => arr.length >= 2);
  const collisionSiteIds = new Set<string>();
  for (const [, arr] of siteCollisions) for (const s of arr) collisionSiteIds.add(s.id);

  const hasBlockingCollisions =
    orgCollisions.length > 0 ||
    siteCollisions.length > 0 ||
    aliasPerOrgCollisions.length > 0 ||
    aliasCrossOrgCollisions.length > 0 ||
    aliasVsOrgNameCollisions.length > 0;

  console.log("\n=== Changes ===");
  console.log(`orgs to update:     ${orgChanges.length}`);
  console.log(`aliases to update:  ${aliasChanges.length}`);
  console.log(`sites to update:    ${siteChanges.length}`);

  console.log("\n=== Collisions ===");
  console.log(`org normalizedName collisions: ${orgCollisions.length}`);
  for (const [norm, arr] of orgCollisions.slice(0, 20)) {
    console.log(`  norm="${norm}"`);
    for (const o of arr) console.log(`    - ${o.id} ${o.orgCode} "${o.canonicalName}"`);
  }
  console.log(`alias per-org collisions: ${aliasPerOrgCollisions.length}`);
  for (const [key, arr] of aliasPerOrgCollisions.slice(0, 20)) {
    console.log(`  ${key}`);
    for (const a of arr) console.log(`    - ${a.id} "${a.alias}"`);
  }
  console.log(`alias cross-org collisions: ${aliasCrossOrgCollisions.length}`);
  for (const [norm, arr] of aliasCrossOrgCollisions.slice(0, 20)) {
    console.log(`  norm="${norm}"`);
    for (const a of arr) {
      console.log(`    - aliasId=${a.id} orgId=${a.organizationId} "${a.alias}"`);
    }
  }
  console.log(`alias vs other-org normalizedName: ${aliasVsOrgNameCollisions.length}`);
  for (const c of aliasVsOrgNameCollisions.slice(0, 20)) {
    console.log(
      `  norm="${c.norm}" aliasId=${c.alias.id} org=${c.alias.organizationId} "${c.alias.alias}" ↔ org ${c.org.orgCode} "${c.org.canonicalName}"`,
    );
  }
  console.log(`site per-org collisions: ${siteCollisions.length}`);
  for (const [key, arr] of siteCollisions.slice(0, 20)) {
    console.log(`  ${key}`);
    for (const s of arr) {
      console.log(`    - ${s.id} "${s.siteName}"${s.archived ? " [archived]" : ""} (old=${s.normalizedSiteName})`);
    }
  }

  if (VERIFY && !APPLY) {
    const orgBad = (orgs as OrgRow[]).filter((o) => o.normalizedName !== orgNew.get(o.id)).length;
    const aliasBad = (aliases as AliasRow[]).filter((a) => a.normalizedAlias !== aliasNew.get(a.id)).length;
    const siteBad = (sites as SiteRow[]).filter((s) => s.normalizedSiteName !== siteNew.get(s.id)).length;
    console.log(
      `\n[verify] orgBad=${orgBad} aliasBad=${aliasBad} siteBad=${siteBad} blockingCollisions=${hasBlockingCollisions}`,
    );
    if (orgBad + aliasBad + siteBad > 0 || hasBlockingCollisions) {
      process.exit(1);
    }
    console.log("[verify] OK");
    return;
  }

  if (PRECHECK && !APPLY) {
    console.log("\n(DRY-RUN) No writes. Re-run with --apply after resolving collisions.");
    if (hasBlockingCollisions) {
      console.log("(Note) Blocking collisions present — --apply will refuse.");
    }
    return;
  }

  if (hasBlockingCollisions) {
    console.error(
      "\nRefusing --apply: unresolved collisions (org / site / cross-org alias / alias-vs-orgName). Govern first.",
    );
    process.exit(1);
  }

  const siteSafe = siteChanges.filter((c) => !collisionSiteIds.has(c.row.id));

  await prisma.$transaction(async (tx) => {
    for (const { row, next } of orgChanges) {
      await tx.organization.update({
        where: { id: row.id },
        data: { normalizedName: next },
      });
    }
    for (const { row, next } of aliasChanges) {
      await tx.organizationAlias.update({
        where: { id: row.id },
        data: { normalizedAlias: next },
      });
    }
    for (const { row, next } of siteSafe) {
      await tx.organizationSite.update({
        where: { id: row.id },
        data: { normalizedSiteName: next },
      });
    }
  });

  console.log(
    `\nApplied org=${orgChanges.length} alias=${aliasChanges.length} site=${siteSafe.length}`,
  );

  // re-verify field equality (collisions already cleared)
  const [orgs2, aliases2, sites2] = await Promise.all([
    prisma.organization.findMany({ select: { id: true, canonicalName: true, normalizedName: true } }),
    prisma.organizationAlias.findMany({ select: { id: true, alias: true, normalizedAlias: true } }),
    prisma.organizationSite.findMany({
      select: { id: true, siteName: true, normalizedSiteName: true },
    }),
  ]);
  const orgBad = orgs2.filter((o) => o.normalizedName !== normalizeOrgName(o.canonicalName)).length;
  const aliasBad = aliases2.filter((a) => a.normalizedAlias !== normalizeOrgName(a.alias)).length;
  const siteBad = sites2.filter((s) => s.normalizedSiteName !== normalizeSiteName(s.siteName)).length;
  console.log(`[post-apply verify] orgBad=${orgBad} aliasBad=${aliasBad} siteBad=${siteBad}`);
  if (orgBad + aliasBad + siteBad > 0) process.exit(1);
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
