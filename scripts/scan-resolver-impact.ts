/**
 * resolver 影响面扫描（只读，不写库）— W6.6 Profile-only
 *
 * 对每个 assignmentStatus=ASSIGNED 的 Profile，对比：
 *   OLD（当前生效）= resolveEffectiveRepresentativesForProfiles（含 EXPLICIT）
 *   NEW（纯绑定）   = SITE_BINDING > ORG_BINDING > NONE（不含 EXPLICIT）
 *
 * 分类：CONSISTENT / WILL_CHANGE / WILL_LOSE / SKIPPED_DELETED
 *
 * 用法（只读）：
 *   npx tsx scripts/scan-resolver-impact.ts
 */
import { prisma } from "../src/lib/prisma";
import { resolveEffectiveRepresentativesForProfiles } from "../src/lib/crm/customer-effective-representative";

type Klass = "CONSISTENT" | "WILL_CHANGE" | "WILL_LOSE" | "SKIPPED_DELETED";
type Row = {
  profileId: string;
  profileName: string;
  klass: Klass;
  oldRepName: string | null;
  newRepName: string | null;
  hasSite: boolean;
  hasOrg: boolean;
};

type BindingRow = {
  isPrimary: boolean;
  reviewedAt: Date | null;
  createdAt: Date;
  representative: { id: string; name: string };
};

function pickBinding(rows: BindingRow[]): { id: string; name: string } | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    const ar = a.reviewedAt?.getTime() ?? 0;
    const br = b.reviewedAt?.getTime() ?? 0;
    if (ar !== br) return br - ar;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
  return sorted[0].representative;
}

async function main() {
  console.log("[scan-resolver-impact] 只读扫描（Profile-only），不写库\n");

  const liveProfiles = await prisma.crmCustomerProfile.findMany({
    where: { assignmentStatus: "ASSIGNED" },
    select: {
      id: true,
      name: true,
      organizationId: true,
      organizationSiteId: true,
      deleted: true,
      archived: true,
    },
  });

  console.log(`assignmentStatus=ASSIGNED 的 profile 总数: ${liveProfiles.length}`);
  if (liveProfiles.length === 0) {
    console.log("无数据，结束。");
    return;
  }

  const oldMap = await resolveEffectiveRepresentativesForProfiles(liveProfiles.map((p) => p.id));

  const siteIds = [...new Set(liveProfiles.map((p) => p.organizationSiteId).filter((id): id is string => !!id))];
  const orgIds = [...new Set(liveProfiles.map((p) => p.organizationId).filter((id): id is string => !!id))];

  const siteBindings =
    siteIds.length > 0
      ? await prisma.representativeOrganization.findMany({
          where: {
            organizationSiteId: { in: siteIds },
            representative: { archived: false, kind: "HUMAN" },
          },
          select: {
            organizationSiteId: true,
            isPrimary: true,
            reviewedAt: true,
            createdAt: true,
            representative: { select: { id: true, name: true } },
          },
        })
      : [];
  const orgBindings =
    orgIds.length > 0
      ? await prisma.representativeOrganization.findMany({
          where: {
            organizationId: { in: orgIds },
            organizationSiteId: null,
            representative: { archived: false, kind: "HUMAN" },
          },
          select: {
            organizationId: true,
            isPrimary: true,
            reviewedAt: true,
            createdAt: true,
            representative: { select: { id: true, name: true } },
          },
        })
      : [];

  const siteMap = new Map<string, BindingRow[]>();
  for (const b of siteBindings) {
    if (!b.organizationSiteId) continue;
    const arr = siteMap.get(b.organizationSiteId) ?? [];
    arr.push(b);
    siteMap.set(b.organizationSiteId, arr);
  }
  const orgMap = new Map<string, BindingRow[]>();
  for (const b of orgBindings) {
    if (!b.organizationId) continue;
    const arr = orgMap.get(b.organizationId) ?? [];
    arr.push(b);
    orgMap.set(b.organizationId, arr);
  }

  const rows: Row[] = [];
  for (const p of liveProfiles) {
    if (p.deleted || p.archived) {
      rows.push({
        profileId: p.id,
        profileName: p.name ?? "未命名",
        klass: "SKIPPED_DELETED",
        oldRepName: null,
        newRepName: null,
        hasSite: !!p.organizationSiteId,
        hasOrg: !!p.organizationId,
      });
      continue;
    }

    const old = oldMap.get(p.id);
    const oldRepName = old?.representativeName ?? null;
    const oldIsExplicit = old?.source === "EXPLICIT_ASSIGNMENT";

    let newRep: { id: string; name: string } | null = null;
    if (p.organizationSiteId) {
      newRep = pickBinding(siteMap.get(p.organizationSiteId) ?? []);
    }
    if (!newRep && p.organizationId) {
      newRep = pickBinding(orgMap.get(p.organizationId) ?? []);
    }
    const newRepName = newRep?.name ?? null;

    let klass: Klass;
    if (!oldIsExplicit) {
      klass = (oldRepName ?? null) === (newRepName ?? null) ? "CONSISTENT" : "WILL_CHANGE";
    } else if (newRepName && newRepName !== oldRepName) {
      klass = "WILL_CHANGE";
    } else if (!newRepName && oldRepName) {
      klass = "WILL_LOSE";
    } else {
      klass = "CONSISTENT";
    }

    rows.push({
      profileId: p.id,
      profileName: p.name ?? "未命名",
      klass,
      oldRepName,
      newRepName,
      hasSite: !!p.organizationSiteId,
      hasOrg: !!p.organizationId,
    });
  }

  const counts = {
    CONSISTENT: 0,
    WILL_CHANGE: 0,
    WILL_LOSE: 0,
    SKIPPED_DELETED: 0,
  };
  for (const r of rows) counts[r.klass] += 1;

  console.log("\n汇总:");
  console.log(`  CONSISTENT      ${counts.CONSISTENT}`);
  console.log(`  WILL_CHANGE     ${counts.WILL_CHANGE}`);
  console.log(`  WILL_LOSE       ${counts.WILL_LOSE}`);
  console.log(`  SKIPPED_DELETED ${counts.SKIPPED_DELETED}`);

  const interesting = rows.filter((r) => r.klass === "WILL_CHANGE" || r.klass === "WILL_LOSE").slice(0, 30);
  if (interesting.length > 0) {
    console.log("\n样例（WILL_CHANGE / WILL_LOSE，最多 30）:");
    for (const r of interesting) {
      console.log(
        `  ${r.profileId} "${r.profileName}" [${r.klass}] OLD=${r.oldRepName ?? "∅"} → NEW=${r.newRepName ?? "∅"} site=${r.hasSite} org=${r.hasOrg}`,
      );
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
