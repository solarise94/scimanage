/**
 * Backfill OrganizationSite.normalizedSiteName 用新的 normalizeSiteName()。
 *
 * 背景：Task 1.2 把 site 归一从 normalizeOrgName 换成 normalizeSiteName 后，现有
 * site 行的 normalizedSiteName 仍是旧 normalizeOrgName 算的值。`@@unique(
 * [organizationId, normalizedSiteName])` 约束下，旧值与新函数不一致会导致
 * findUnique 找不到已有 site（误建重复）或同 org 撞名冲突。
 *
 * 两阶段：
 *   阶段 1（扫描，只读）：按 organizationId + 新归一值分组，列出"同 org 下 ≥2 site
 *     归一后撞名"的组。这些撞名组不能自动回填（会违反唯一约束），必须先用 site 合并
 *     API（POST /api/organizations/[id]/sites/merge）人工处理，再回填剩余。
 *   阶段 2（回填，WRITE=1）：对不在撞名组、且现存值 ≠ 新值的 site 逐条 update。
 *     幂等：值已正确的跳过；再跑一遍无变更。
 *
 * 碰撞检测覆盖归档 site —— 唯一约束不排除 archived 行。
 *
 * 用法：
 *   # 仅扫描（dry-run，默认）：
 *   npx tsx scripts/backfill-site-normalized-name.ts
 *   # 执行回填（非撞名 site）：
 *   WRITE=1 npx tsx scripts/backfill-site-normalized-name.ts
 *   # 指定数据库：
 *   WRITE=1 DATABASE_URL="file:/home/.../dev.db" npx tsx scripts/backfill-site-normalized-name.ts
 */
import { prisma } from "../src/lib/prisma";
import { normalizeSiteName } from "../src/lib/organization-normalize";

const WRITE = process.env.WRITE === "1";

function isP2002(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002";
}

async function main() {
  console.log(`[backfill-site-normalized-name] mode=${WRITE ? "WRITE" : "DRY-RUN"}`);

  const sites = await prisma.organizationSite.findMany({
    select: { id: true, organizationId: true, siteName: true, normalizedSiteName: true, archived: true },
    orderBy: [{ organizationId: "asc" }, { siteName: "asc" }],
  });
  console.log(`Total sites: ${sites.length}`);

  // Group by organizationId + NEW normalized value (collision detection spans
  // archived sites too — the unique constraint does not exclude them).
  const groups = new Map<string, typeof sites>();
  const newNormMap = new Map<string, string>(); // siteId -> new normalized
  for (const s of sites) {
    const newNorm = normalizeSiteName(s.siteName);
    newNormMap.set(s.id, newNorm);
    const key = `${s.organizationId}::${newNorm}`;
    const arr = groups.get(key) || [];
    arr.push(s);
    groups.set(key, arr);
  }

  // Collision groups: ≥2 sites under the same org normalize to the same value
  const collisionGroups = [...groups.entries()].filter(([, arr]) => arr.length >= 2);
  const collisionSiteIds = new Set<string>();
  for (const [, arr] of collisionGroups) for (const s of arr) collisionSiteIds.add(s.id);

  // ── Phase 1: scan ──
  console.log("\n=== Phase 1: collision scan ===");
  if (collisionGroups.length === 0) {
    console.log("No collisions. All sites can be backfilled directly.");
  } else {
    console.log(`Found ${collisionGroups.length} collision group(s) — MUST be merged manually via the site-merge API BEFORE backfill:`);
    const orgIds = [...new Set(collisionGroups.map(([key]) => key.split("::")[0]))];
    const orgs = await prisma.organization.findMany({
      where: { id: { in: orgIds } },
      select: { id: true, canonicalName: true, orgCode: true },
    });
    const orgLabel = new Map(orgs.map((o) => [o.id, `${o.canonicalName} (${o.orgCode})`]));
    for (const [key, arr] of collisionGroups) {
      const sep = key.lastIndexOf("::");
      const orgId = key.slice(0, sep);
      const norm = key.slice(sep + 2);
      console.log(`\n  Org: ${orgLabel.get(orgId) || orgId}`);
      console.log(`  归一值: "${norm}"`);
      for (const s of arr) {
        console.log(`    - siteId=${s.id} siteName="${s.siteName}"${s.archived ? " [archived]" : ""} (现存 normalizedSiteName="${s.normalizedSiteName}")`);
      }
    }
  }

  // ── Phase 2: backfill non-colliding ──
  const toUpdate = sites.filter((s) => !collisionSiteIds.has(s.id) && s.normalizedSiteName !== newNormMap.get(s.id));
  const alreadyCorrect = sites.filter((s) => !collisionSiteIds.has(s.id) && s.normalizedSiteName === newNormMap.get(s.id));

  console.log("\n=== Phase 2: backfill non-colliding ===");
  console.log(`Already correct:               ${alreadyCorrect.length}`);
  console.log(`To update:                     ${toUpdate.length}`);
  console.log(`Skipped (in collision groups): ${collisionSiteIds.size}`);

  if (toUpdate.length === 0) {
    console.log("Nothing to backfill.");
  } else if (!WRITE) {
    console.log("\n(DRY-RUN) Would update:");
    for (const s of toUpdate.slice(0, 50)) {
      console.log(`  siteId=${s.id} "${s.normalizedSiteName}" -> "${newNormMap.get(s.id)}"`);
    }
    if (toUpdate.length > 50) console.log(`  ... and ${toUpdate.length - 50} more`);
    console.log("\nRe-run with WRITE=1 to apply.");
  } else {
    // Per-row update. Updating one site's normalizedSiteName can momentarily
    // collide with another not-yet-updated site holding that value; retry across
    // passes so blockers clear as their own rows update. Residual conflicts
    // (e.g. against an archived/collision site) are reported for manual handling.
    let updated = 0;
    let pending = [...toUpdate];
    for (let pass = 0; pass < 3 && pending.length > 0; pass++) {
      const stillPending: typeof pending = [];
      for (const s of pending) {
        try {
          await prisma.organizationSite.update({
            where: { id: s.id },
            data: { normalizedSiteName: newNormMap.get(s.id)! },
          });
          updated++;
        } catch (e) {
          if (isP2002(e)) stillPending.push(s);
          else throw e;
        }
      }
      // No progress this pass → stop retrying
      if (stillPending.length === pending.length) {
        pending = stillPending;
        break;
      }
      pending = stillPending;
    }
    console.log(`\nUpdated ${updated} site(s).`);
    if (pending.length > 0) {
      console.log(`\n⚠️  ${pending.length} site(s) could not be backfilled due to unique conflicts — handle manually (merge first):`);
      for (const s of pending) {
        console.log(`  siteId=${s.id} siteName="${s.siteName}" -> "${newNormMap.get(s.id)}" (blocked)`);
      }
    }
  }

  if (collisionGroups.length > 0) {
    console.log(`\n⚠️  ${collisionSiteIds.size} site(s) in ${collisionGroups.length} collision group(s) were NOT backfilled. Merge them via the site-merge API, then re-run.`);
  }
}

main()
  .catch((err) => {
    console.error("[backfill-site-normalized-name] Failed:", err);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
