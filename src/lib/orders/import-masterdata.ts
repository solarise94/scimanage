import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveOrganization } from "@/lib/organization-resolver";
import { ensureOrganizationFromInput } from "@/lib/organizations/ensure-organization";
import { resolveImportRowMatch } from "@/lib/orders/source-order-match";
import { createCrmCustomerProfile } from "@/lib/crm/create-profile";
import { resolveEffectiveRepresentativeForOrg } from "@/lib/crm/customer-effective-representative";
import { normalizeOrgName, normalizeSiteName } from "@/lib/organization-normalize";
import type { MatchInput, MatchCandidate } from "@/lib/orders/source-order-match";
import { normalizeCustomerNameAlias, type NameAliasType } from "@/lib/customers/customer-name-alias";

export type CustomerMode = "MATCH_ONLY" | "CREATE_IF_MISSING" | "SKIP";
export type OrganizationMode = "RESOLVE_ONLY" | "CREATE_IF_MISSING" | "SKIP";

type DbLike = Prisma.TransactionClient | typeof prisma;

export interface OrgResolveResult {
  organizationId: string | null;
  canonicalName: string | null;
  created: boolean;
}

async function createOrgInTx(
  db: DbLike,
  orgName: string,
): Promise<{ organizationId: string; canonicalName: string }> {
  // 用 MAX(orgCode)+1 起算，避免跳号场景下 count+1 落到已占用号导致 P2002。
  // orgCode 是 5 位 zero-padded（ORG-00001 / ORG-96805），字典序=数字序。
  const maxRow = await db.organization.findFirst({
    where: { orgCode: { startsWith: "ORG-" } },
    orderBy: { orgCode: "desc" },
    select: { orgCode: true },
  });
  const maxN = maxRow ? parseInt(maxRow.orgCode.slice(4), 10) || 0 : 0;
  let orgCode = "";
  for (let i = 1; i <= 10; i++) {
    const code = `ORG-${String(maxN + i).padStart(5, "0")}`;
    const exists = await db.organization.findUnique({ where: { orgCode: code }, select: { id: true } });
    if (!exists) { orgCode = code; break; }
  }
  // fallback：随机 5 位（罕见路径，仍可能撞但概率极低）
  if (!orgCode) orgCode = `ORG-${String(Math.floor(Math.random() * 99999) + 1).padStart(5, "0")}`;

  const normalized = normalizeOrgName(orgName.trim());
  const org = await db.organization.create({
    data: {
      orgCode,
      canonicalName: orgName.trim(),
      normalizedName: normalized,
    },
  });
  return { organizationId: org.id, canonicalName: org.canonicalName };
}

export async function resolveOrCreateOrganizationForImport(
  orgName: string | null | undefined,
  mode: OrganizationMode,
  db: DbLike = prisma,
): Promise<OrgResolveResult> {
  if (!orgName?.trim() || mode === "SKIP") {
    return { organizationId: null, canonicalName: null, created: false };
  }

  const resolved = await resolveOrganization(orgName.trim());
  if (resolved.status === "exact" && resolved.organizationId) {
    return { organizationId: resolved.organizationId, canonicalName: resolved.canonicalName, created: false };
  }

  if (mode === "CREATE_IF_MISSING") {
    // Use db for the actual creation (supports tx), fall back to ensureOrganizationFromInput for non-tx calls
    if (db !== prisma) {
      const created = await createOrgInTx(db, orgName.trim());
      return { organizationId: created.organizationId, canonicalName: created.canonicalName, created: true };
    }
    const created = await ensureOrganizationFromInput(orgName.trim());
    return { organizationId: created.organizationId, canonicalName: created.canonicalName, created: true };
  }

  return { organizationId: null, canonicalName: resolved.canonicalName || orgName.trim(), created: false };
}

export interface OrgSiteResolveResult extends OrgResolveResult {
  organizationSiteId: string | null;
}

/**
 * Resolve/create Organization 并按 (canonicalName, siteName?, siteType?) find-or-create
 * OrganizationSite，返回 organizationId + organizationSiteId。
 * 用于合同台账导入（§5 机构-校区映射）。siteName 为空时只返回 organizationId。
 *
 * rawAlias：导入原始单位名（如"浙江树人学院"）。当它与 canonicalName（如"浙江树人大学"）
 * 不同时，补建 OrganizationAlias，保证日后以原始名直接查 Organization 不漏、不误建第二条。
 */
export async function resolveOrCreateOrganizationWithSiteForImport(
  orgName: string | null | undefined,
  siteName: string | null | undefined,
  siteType: string | null | undefined,
  mode: OrganizationMode,
  db: DbLike = prisma,
  rawAlias?: string | null,
): Promise<OrgSiteResolveResult> {
  const org = await resolveOrCreateOrganizationForImport(orgName, mode, db);

  // 补建别名：原始名 ≠ canonicalName 且尚不存在该 alias 时
  if (org.organizationId && rawAlias?.trim() && rawAlias.trim() !== (org.canonicalName ?? orgName?.trim())) {
    const normalizedAlias = normalizeOrgName(rawAlias.trim());
    const aliasExists = await db.organizationAlias.findFirst({
      where: { organizationId: org.organizationId, normalizedAlias },
      select: { id: true },
    });
    if (!aliasExists) {
      await db.organizationAlias.create({
        data: {
          organizationId: org.organizationId,
          alias: rawAlias.trim(),
          normalizedAlias,
          aliasType: "COMMON",
        },
      }).catch(() => undefined); // 并发或唯一冲突时忽略
    }
  }

  if (!org.organizationId || !siteName?.trim()) {
    return { ...org, organizationSiteId: null };
  }

  const normalizedSiteName = normalizeSiteName(siteName.trim());
  const existing = await db.organizationSite.findUnique({
    where: {
      organizationId_normalizedSiteName: {
        organizationId: org.organizationId,
        normalizedSiteName,
      },
    },
    select: { id: true },
  });
  if (existing) {
    return { ...org, organizationSiteId: existing.id };
  }

  const site = await db.organizationSite.create({
    data: {
      organizationId: org.organizationId,
      siteName: siteName.trim(),
      normalizedSiteName,
      siteType: siteType?.trim() || "CAMPUS",
    },
    select: { id: true },
  });
  return { ...org, organizationSiteId: site.id };
}

export interface CustResolveResult {
  /** Profile-only：只认 CrmCustomerProfile.id；调用方写 Order/Project/Cost 只落 profileId。 */
  profileId: string | null;
  created: boolean;
  matchStatus: "AUTO_MATCHED" | "UNMATCHED";
  matchScore: number | null;
  matchReason: string | null;
}

export interface CustomerMatchOnlyResult {
  profileId: string | null;
  score: number | null;
  reason: string | null;
}

/**
 * Profile-only 候选召回（§5.1）：直接查 `CrmCustomerProfile`，候选就是 Profile。
 * high-priority 信号（姓名/微信/手机/小程序ID）各自独立召回，再按 site → org 低优先召回。
 *
 * 纯只读，无写副作用。供 `matchExistingCustomerForImport` 与确认页会话引擎共用。
 */
export async function recallImportCandidates(
  input: MatchInput,
  organizationId: string | null,
  db: DbLike = prisma,
  organizationSiteId?: string | null,
): Promise<MatchCandidate[]> {
  if (!input.buyerName?.trim()) return [];

  const SELECT = {
    id: true,
    name: true,
    customerCode: true,
    wechat: true,
    phone: true,
    principal: true,
    miniProgramId: true,
    organization: true,
    address: true,
    organizationId: true,
    organizationSiteId: true,
    nameAliases: { where: { active: true }, select: { alias: true, aliasType: true } },
    org: {
      select: {
        canonicalName: true,
        normalizedName: true,
        aliases: { select: { alias: true } },
        sites: { where: { archived: false }, select: { id: true, siteName: true } },
      },
    },
  } as const;

  // 匹配生命周期只看 Profile 本体，不依赖可空的 sourceCustomer。
  const base = {
    deleted: false,
    archived: false,
    mergedIntoProfileId: null,
  } as const;
  const nameTrim = input.buyerName.trim();

  const [nameHits, codeHits, wechatHits, phoneHits, miniHits] = await Promise.all([
    db.crmCustomerProfile.findMany({
      where: { ...base, name: nameTrim },
      select: SELECT,
      take: 30,
    }),
    input.buyerCustomerCode?.trim()
      ? db.crmCustomerProfile.findMany({
          where: { ...base, customerCode: input.buyerCustomerCode.trim() },
          select: SELECT,
          take: 30,
        })
      : Promise.resolve([]),
    input.buyerWechat?.trim()
      ? db.crmCustomerProfile.findMany({
          where: { ...base, wechat: input.buyerWechat.trim() },
          select: SELECT,
          take: 30,
        })
      : Promise.resolve([]),
    input.buyerPhone?.trim()
      ? db.crmCustomerProfile.findMany({
          where: {
            ...base,
            OR: [
              { phone: { contains: input.buyerPhone.trim() } },
              { principal: { contains: input.buyerPhone.trim() } },
            ],
          },
          select: SELECT,
          take: 30,
        })
      : Promise.resolve([]),
    input.buyerMiniProgramId?.trim()
      ? db.crmCustomerProfile.findMany({
          where: { ...base, miniProgramId: input.buyerMiniProgramId.trim() },
          select: SELECT,
          take: 30,
        })
      : Promise.resolve([]),
  ]);

  const seen = new Set<string>();
  const highHits = [nameHits, codeHits, wechatHits, phoneHits, miniHits]
    .flat()
    .filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

  const siteHits =
    organizationId && organizationSiteId
      ? (
          await db.crmCustomerProfile.findMany({
            where: {
              ...base,
              id: { notIn: [...seen] },
              organizationSiteId,
            },
            select: SELECT,
            take: 20,
          })
        )
      : [];
  siteHits.forEach((p) => seen.add(p.id));

  const orgHits = organizationId
    ? (
        await db.crmCustomerProfile.findMany({
          where: {
            ...base,
            id: { notIn: [...seen] },
            organizationId,
          },
          select: SELECT,
          take: 20,
        })
      )
    : [];
  orgHits.forEach((p) => seen.add(p.id));

  const aliasHits = nameTrim
    ? (
        await db.crmCustomerProfile.findMany({
          where: {
            ...base,
            id: { notIn: [...seen] },
            nameAliases: {
              some: { normalizedAlias: normalizeCustomerNameAlias(nameTrim), active: true },
            },
          },
          select: SELECT,
          take: 20,
        })
      )
    : [];

  const finalSeen = new Set<string>();
  const candidateRecords = [...highHits, ...siteHits, ...orgHits, ...aliasHits].filter((p) => {
    if (finalSeen.has(p.id)) return false;
    finalSeen.add(p.id);
    return true;
  });

  return candidateRecords.map((p) => {
    const sites = p.org?.sites || [];
    const siteNames = sites.map((s) => s.siteName).filter(Boolean) as string[];
    const customerSite = p.organizationSiteId
      ? sites.find((s) => s.id === p.organizationSiteId)?.siteName ?? null
      : null;
    return {
      profileId: p.id,
      name: p.name ?? null,
      customerCode: p.customerCode ?? null,
      wechat: p.wechat ?? null,
      phone: p.phone ?? null,
      principal: p.principal ?? null,
      miniProgramId: p.miniProgramId ?? null,
      organization: p.organization ?? null,
      address: p.address ?? null,
      orgCanonicalName: p.org?.canonicalName,
      orgNormalizedName: p.org?.normalizedName,
      orgAliases: p.org?.aliases?.map((a) => a.alias) || [],
      orgSiteNames: siteNames,
      customerSiteName: customerSite,
      nameAliases: (p.nameAliases || []).map((a) => ({
        alias: a.alias,
        aliasType: a.aliasType as NameAliasType,
      })),
    };
  });
}

/**
 * 只读客户匹配：候选召回 + 统一打分核心（§5）。**Profile-only**：召回与打分的业务信号
 * （微信/手机/小程序ID/机构/地址）均取自 `CrmCustomerProfile`，候选就是 Profile。
 *
 * 仅当结论为 `AUTO_SUGGESTED`（高置信，§5.3）时返回 profileId 作为可自动绑定的匹配；
 * `AMBIGUOUS`/`NO_MATCH` 一律不自动绑定（防过度兜底），但回传 best score/reason 供报告。
 *
 * **不创建客户、不 ensure profile**——纯只读。供导入预览未匹配预检与 commit 复用，
 * 保证预览不产生任何写副作用。
 */
export async function matchExistingCustomerForImport(
  input: MatchInput,
  organizationId: string | null,
  db: DbLike = prisma,
  organizationSiteId?: string | null,
): Promise<CustomerMatchOnlyResult> {
  if (!input.buyerName?.trim()) {
    return { profileId: null, score: null, reason: null };
  }

  const candidates = await recallImportCandidates(input, organizationId, db, organizationSiteId);
  const resolution = resolveImportRowMatch(input, candidates);

  if (resolution.status === "AUTO_SUGGESTED" && resolution.best) {
    return {
      profileId: resolution.best.profileId,
      score: resolution.best.score,
      reason: resolution.best.reason,
    };
  }
  return {
    profileId: null,
    score: resolution.best?.score ?? null,
    reason: resolution.best?.reason ?? null,
  };
}

export async function resolveOrCreateCustomerForImport(
  input: MatchInput,
  mode: CustomerMode,
  organizationId: string | null,
  ownerUserId?: string | null,
  db: DbLike = prisma,
  organizationSiteId?: string | null,
): Promise<CustResolveResult> {
  if (!input.buyerName?.trim() || mode === "SKIP") {
    return { profileId: null, created: false, matchStatus: "UNMATCHED", matchScore: null, matchReason: null };
  }

  const matched = await matchExistingCustomerForImport(input, organizationId, db, organizationSiteId);

  if (matched.profileId) {
    // 仅接受匹配结果已带出的有效 profileId；命中后复核 Profile 仍活动
    const activeProfile = await db.crmCustomerProfile.findFirst({
      where: {
        id: matched.profileId,
        deleted: false,
        archived: false,
      },
      select: { id: true },
    });
    if (!activeProfile) {
      return {
        profileId: null,
        created: false,
        matchStatus: "UNMATCHED",
        matchScore: matched.score,
        matchReason: matched.reason ?? "matched_profile_inactive",
      };
    }

    return {
      profileId: activeProfile.id,
      created: false,
      matchStatus: "AUTO_MATCHED",
      matchScore: matched.score,
      matchReason: matched.reason,
    };
  }

  if (mode === "CREATE_IF_MISSING") {
    // U2/U7：禁止创建无机构客户。机构由调用方 resolveOrCreateOrganizationForImport
    // 从买方快照解析后传入；解析失败（organizationId 为 null）则拒绝该行，记入导入失败
    // 报告，由 ADMIN 手动建机构后再导入——不再建"待定机构"的无机构客户。
    if (!organizationId) {
      return {
        profileId: null,
        created: false,
        matchStatus: "UNMATCHED",
        matchScore: matched.score,
        matchReason: "org_unresolved_reject_create",
      };
    }

    // Phase D（docs/customer-legacy-field-remediation-plan-2026-07-15.md）：新建客户
    // 不再产生 Customer 锚点，直接建 Profile-only 客户。owner 解析优先级与旧流程一致
    // （effective org/site binding → 调用方传入的 ownerUserId 兜底 → 本部/ADMIN 兜底），
    // 只是提前到创建前一次性解析，不再需要"先建后补"的两段更新。
    const principal = input.buyerPhone?.trim() || null;
    const wechat = input.buyerWechat?.trim() || null;
    const organization = input.buyerOrgName?.trim() || null;
    const address = input.buyerAddress?.trim() || null;

    const effective = await resolveEffectiveRepresentativeForOrg(organizationId, organizationSiteId ?? null, db);
    const finalOwnerUserId = effective.ownerUserId ?? ownerUserId ?? null;
    const assignmentStatus =
      effective.source === "SITE_BINDING" || effective.source === "ORG_BINDING" ? "ASSIGNED" : "UNASSIGNED";

    const { id: profileId } = await createCrmCustomerProfile(
      {
        name: input.buyerName.trim(),
        principal,
        wechat,
        organization,
        organizationId,
        organizationSiteId: organizationSiteId ?? null,
        address,
        ownerUserId: finalOwnerUserId ?? undefined,
        assignmentStatus,
        sourceHint: "ORDER_IMPORT",
      },
      db,
    );

    return {
      profileId,
      created: true,
      matchStatus: "AUTO_MATCHED",
      matchScore: 0,
      matchReason: "created_during_import",
    };
  }

  return { profileId: null, created: false, matchStatus: "UNMATCHED", matchScore: matched.score, matchReason: matched.reason };
}
