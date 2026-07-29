import { prisma } from "@/lib/prisma";
import { normalizeOrgName } from "@/lib/organization-normalize";

async function generateOrgCode(): Promise<string> {
  const count = await prisma.organization.count();
  for (let i = 0; i < 10; i++) {
    const code = `ORG-${String(count + 1 + i).padStart(5, "0")}`;
    const exists = await prisma.organization.findUnique({ where: { orgCode: code }, select: { id: true } });
    if (!exists) return code;
  }
  return `ORG-${String(Date.now() % 100000).padStart(5, "0")}`;
}

export async function ensureOrganizationFromInput(rawName: string): Promise<{
  organizationId: string;
  canonicalName: string;
}> {
  const trimmed = rawName.trim();
  if (!trimmed) throw new Error("单位名称不能为空");

  const normalized = normalizeOrgName(trimmed);

  // Check exact match on canonicalName or normalizedName
  const existing = await prisma.organization.findFirst({
    where: {
      deleted: false,
      OR: [
        { canonicalName: trimmed },
        { normalizedName: normalized },
      ],
    },
    orderBy: [{ archived: "asc" }, { createdAt: "asc" }],
    select: { id: true, canonicalName: true, archived: true },
  });

  if (existing) {
    if (existing.archived) {
      throw new Error(`同名单位 "${existing.canonicalName}" 已归档，请联系管理员恢复`);
    }
    return { organizationId: existing.id, canonicalName: existing.canonicalName };
  }

  // Also check approved aliases
  const aliasMatch = await prisma.organizationAlias.findFirst({
    where: {
      normalizedAlias: normalized,
      approved: true,
      organization: { deleted: false, archived: false },
    },
    include: { organization: { select: { id: true, canonicalName: true } } },
  });

  if (aliasMatch) {
    return {
      organizationId: aliasMatch.organization.id,
      canonicalName: aliasMatch.organization.canonicalName,
    };
  }

  // Check site names: the input may be a composite "org+site" (e.g.
  // "浙江大学医学院") that should resolve to the parent org + site, not
  // create a standalone orphan. Try matching against every active org's
  // canonicalName/normalizedName/aliases concatenated with its site names.
  const allOrgs = await prisma.organization.findMany({
    where: { deleted: false, archived: false },
    select: {
      id: true,
      canonicalName: true,
      normalizedName: true,
      sites: { where: { archived: false }, select: { id: true, siteName: true } },
    },
  });
  for (const org of allOrgs) {
    for (const site of org.sites) {
      // Match "canonicalName + siteName" in both orders, normalized
      const compositeA = normalizeOrgName(org.canonicalName + site.siteName);
      const compositeB = normalizeOrgName(site.siteName + org.canonicalName);
      if (normalized === compositeA || normalized === compositeB) {
        return {
          organizationId: org.id,
          canonicalName: org.canonicalName,
        };
      }
    }
  }

  // No match — create new Organization
  // Retry on orgCode P2002 collision
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const orgCode = await generateOrgCode();
      const created = await prisma.organization.create({
        data: {
          orgCode,
          canonicalName: trimmed,
          normalizedName: normalized,
        },
        select: { id: true, canonicalName: true },
      });
      return { organizationId: created.id, canonicalName: created.canonicalName };
    } catch (e: unknown) {
      const isP2002 = typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002";
      if (!isP2002 || attempt === 2) throw e;
      // P2002 on canonicalName — re-check and return existing
      const conflict = await prisma.organization.findFirst({
        where: { canonicalName: trimmed, deleted: false },
        select: { id: true, canonicalName: true },
      });
      if (conflict) return { organizationId: conflict.id, canonicalName: conflict.canonicalName };
    }
  }

  throw new Error("创建单位失败");
}
