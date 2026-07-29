import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateCustomerCode } from "@/lib/customer-code";
import { resolveOrganization } from "@/lib/organization-resolver";
import { resolveEffectiveRepresentativeForOrg } from "@/lib/crm/customer-effective-representative";
import { toPinyinToneless } from "@/lib/crm/pinyin";
import { syncProfileRepresentativeLinks } from "@/lib/crm/customer-representative-sync";
import { retireOtherManagingTags, upsertManagingTag } from "@/lib/crm/customer-rep-tag-helpers";
import { ensureDepartmentStatesForLegacyProfile } from "@/lib/crm/create-profile";
import {
  normalizeCustomerNameAlias,
  NAME_ALIAS_TYPE,
  type MatchedNameType,
} from "@/lib/customers/customer-name-alias";

// validateOrg 可在 $transaction 内复用：传入事务 client 时所有查询走事务上下文，
// 不传则默认全局 prisma（旧调用方零改动）。
type DbClient = Prisma.TransactionClient | typeof prisma;

// ── Duplicate detection ─────────────────────────────────────────────────────

export interface DuplicateCandidate {
  /** 规范主键：Profile.id */
  id: string;
  profileId: string;
  name: string;
  customerCodeLast6: string;
  organization: string | null;
  hasCrmProfile: boolean;
  matchReasons: string[];
  // Internal only — stripped from client response
  profileOwnerUserId: string | null;
  // P1：命中姓名/称呼信息（docs §7.3）
  matchedName?: string;
  matchedNameType?: MatchedNameType;
}

function normalizeOrgForMatch(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

function buildDupMatchReasons(
  input: { name: string; email: string | null; wechat: string | null; organization: string | null; miniProgramId: string | null; principal: string | null },
  profile: {
    name: string | null;
    email: string | null;
    wechat: string | null;
    organization: string | null;
    miniProgramId: string | null;
    principal: string | null;
  },
): string[] {
  const reasons: string[] = [];
  if (profile.name === input.name) reasons.push("姓名相同");
  if (input.email && profile.email === input.email) reasons.push("邮箱相同");
  if (input.wechat && profile.wechat === input.wechat) reasons.push("微信相同");
  if (input.miniProgramId && profile.miniProgramId === input.miniProgramId) reasons.push("小程序ID匹配");
  if (input.principal && profile.principal === input.principal) reasons.push("负责人相同");
  if (input.organization && profile.organization) {
    if (normalizeOrgForMatch(profile.organization) === normalizeOrgForMatch(input.organization)) {
      reasons.push("单位匹配");
    }
  }
  return reasons;
}

export async function findDuplicateCustomers(input: {
  name: string; email?: string | null; wechat?: string | null;
  miniProgramId?: string | null; organizationId?: string | null;
  organizationRawInput?: string | null; organization?: string | null;
  principal?: string | null;
}): Promise<{ blocking: DuplicateCandidate[]; weak: DuplicateCandidate[] }> {
  const t = {
    name: input.name?.trim(),
    email: input.email?.trim() || null,
    wechat: input.wechat?.trim() || null,
    miniProgramId: input.miniProgramId?.trim() || null,
    organizationId: input.organizationId || null,
    organizationRawInput: input.organizationRawInput?.trim() || null,
    organization: input.organization?.trim() || null,
    principal: input.principal?.trim() || null,
  };

  if (!t.name) return { blocking: [], weak: [] };

  const orgText = t.organizationRawInput || t.organization;

  // Phase D：查重主体为 CrmCustomerProfile（含 Profile-only）。
  const activeProfile = { deleted: false, archived: false };
  const nameMatch = { ...activeProfile, name: t.name };
  const blockingOrs: Record<string, unknown>[] = [];
  if (t.email) blockingOrs.push({ AND: [{ ...activeProfile, email: t.email }, nameMatch] });
  if (t.wechat) blockingOrs.push({ AND: [{ ...activeProfile, wechat: t.wechat }, nameMatch] });
  if (t.miniProgramId) blockingOrs.push({ ...activeProfile, miniProgramId: t.miniProgramId });
  if (t.organizationId) {
    blockingOrs.push({ AND: [{ ...activeProfile, organizationId: t.organizationId }, nameMatch] });
  }
  if (orgText) {
    blockingOrs.push({ AND: [{ ...activeProfile, organization: orgText }, nameMatch] });
  }
  if (t.principal) blockingOrs.push({ AND: [{ ...activeProfile, principal: t.principal }, nameMatch] });

  type ProfileDupRow = {
    id: string;
    ownerUserId: string | null;
    name: string | null;
    customerCode: string | null;
    email: string | null;
    wechat: string | null;
    organization: string | null;
    organizationId: string | null;
    principal: string | null;
    miniProgramId: string | null;
    nameAliases: Array<{ alias: string; normalizedAlias: string; aliasType: string; active: boolean }>;
  };

  const profileSelect = {
    id: true, ownerUserId: true, name: true, customerCode: true,
    email: true, wechat: true,
    organization: true, organizationId: true, principal: true,
    miniProgramId: true,
    nameAliases: { where: { active: true }, select: { alias: true, normalizedAlias: true, aliasType: true, active: true } },
  } as const;

  let blockingRaw: ProfileDupRow[] = [];

  let normalizedOrgMatches: ProfileDupRow[] = [];
  if (orgText && blockingOrs.length > 0) {
    const nameMatched = await prisma.crmCustomerProfile.findMany({
      where: { ...activeProfile, name: t.name },
      select: profileSelect,
      take: 20,
    });
    const normalizedInput = normalizeOrgForMatch(orgText);
    normalizedOrgMatches = nameMatched.filter((p) =>
      p.organization && normalizeOrgForMatch(p.organization) === normalizedInput,
    );
  }

  if (blockingOrs.length > 0) {
    blockingRaw = await prisma.crmCustomerProfile.findMany({
      where: { ...activeProfile, OR: blockingOrs },
      select: profileSelect,
      orderBy: { createdAt: "desc" },
      take: 10,
    });
  }

  for (const nm of normalizedOrgMatches) {
    if (!blockingRaw.some((b) => b.id === nm.id)) {
      blockingRaw.push(nm);
    }
  }

  const normalizedInputName = normalizeCustomerNameAlias(t.name);
  const aliasMatched: ProfileDupRow[] = [];
  if (normalizedInputName) {
    aliasMatched.push(
      ...(await prisma.crmCustomerProfile.findMany({
        where: {
          ...activeProfile,
          mergedIntoProfileId: null,
          nameAliases: { some: { normalizedAlias: normalizedInputName, active: true } },
        },
        select: profileSelect,
        orderBy: { createdAt: "desc" },
        take: 20,
      })),
    );
  }

  const inputOrgId = t.organizationId;
  const aliasBlockingRows: ProfileDupRow[] = [];
  const aliasWeakRows: ProfileDupRow[] = [];
  for (const row of aliasMatched) {
    if (blockingRaw.some((b) => b.id === row.id)) continue;
    const rowOrgId = row.organizationId ?? null;
    if (inputOrgId && rowOrgId === inputOrgId) {
      aliasBlockingRows.push(row);
    } else {
      aliasWeakRows.push(row);
    }
  }
  blockingRaw.push(...aliasBlockingRows);

  const blockingIds = new Set(blockingRaw.map((c) => c.id));

  function buildCandidate(p: ProfileDupRow, extraReasons: string[] = []): DuplicateCandidate {
    const reasons = buildDupMatchReasons(t, p);
    const matched = resolveMatchedNameInfo(p, normalizedInputName);
    return {
      id: p.id,
      profileId: p.id,
      name: p.name ?? "未命名客户",
      customerCodeLast6: p.customerCode?.slice(-6) ?? "------",
      organization: p.organization ?? null,
      hasCrmProfile: true,
      matchReasons: reasons.length > 0 ? [...reasons, ...extraReasons] : extraReasons,
      profileOwnerUserId: p.ownerUserId ?? null,
      ...(matched ? { matchedName: matched.alias, matchedNameType: matched.type } : {}),
    };
  }

  const blocking = blockingRaw.map((c) => buildCandidate(c));

  const weakRaw = await prisma.crmCustomerProfile.findMany({
    where: { ...activeProfile, name: t.name, id: { notIn: [...blockingIds] } },
    select: profileSelect,
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const weak: DuplicateCandidate[] = weakRaw.map((p) => ({
    id: p.id,
    profileId: p.id,
    name: p.name ?? "未命名客户",
    customerCodeLast6: p.customerCode?.slice(-6) ?? "------",
    organization: p.organization ?? null,
    hasCrmProfile: true,
    matchReasons: ["姓名相同（弱匹配）"],
    profileOwnerUserId: p.ownerUserId ?? null,
  }));

  const weakNameIds = new Set(weakRaw.map((c) => c.id));
  for (const row of aliasWeakRows) {
    if (blockingIds.has(row.id) || weakNameIds.has(row.id)) continue;
    const matched = resolveMatchedNameInfo(row, normalizedInputName);
    weak.push({
      id: row.id,
      profileId: row.id,
      name: row.name ?? "未命名客户",
      customerCodeLast6: row.customerCode?.slice(-6) ?? "------",
      organization: row.organization ?? null,
      hasCrmProfile: true,
      matchReasons: ["常用称呼命中（弱匹配）"],
      profileOwnerUserId: row.ownerUserId ?? null,
      ...(matched ? { matchedName: matched.alias, matchedNameType: matched.type } : {}),
    });
    weakNameIds.add(row.id);
  }

  return { blocking, weak };
}

/**
 * 从候选行的活动称呼中解析命中的姓名/称呼信息。
 * 优先级：如果正式姓名与输入一致，返回 FORMAL；否则从 alias 中找归一化匹配。
 */
function resolveMatchedNameInfo(
  row: {
    name: string | null;
    nameAliases: Array<{ alias: string; normalizedAlias: string; aliasType: string; active: boolean }>;
  },
  normalizedInputName: string,
): { alias: string; type: MatchedNameType } | null {
  // 正式姓名命中：只检查 Profile.name
  if (row.name && normalizeCustomerNameAlias(row.name) === normalizedInputName) {
    return { alias: row.name, type: "FORMAL" };
  }
  const aliases = row.nameAliases ?? [];
  for (const a of aliases) {
    if (a.normalizedAlias !== normalizedInputName) continue;
    const type: MatchedNameType =
      a.aliasType === NAME_ALIAS_TYPE.MERGED_NAME
        ? "MERGED_NAME"
        : a.aliasType === NAME_ALIAS_TYPE.FORMER_NAME
          ? "FORMER_NAME"
          : "COMMON";
    return { alias: a.alias, type };
  }
  return null;
}

// ── Conflict checks (split: org independent, customer depends on candidates) ──

export async function checkOrgOwnership(
  submittedByUserId: string,
  organizationId: string | null,
  organizationSiteId?: string | null,
): Promise<boolean> {
  if (!organizationId) return false;

  const submitter = await prisma.user.findUnique({
    where: { id: submittedByUserId },
    select: { email: true },
  });
  if (!submitter?.email) return true; // can't determine rep → treat as conflict

  const rep = await prisma.representative.findUnique({
    where: { email: submitter.email },
    select: { id: true },
  });
  if (!rep) return true;

  // If site is specified, prefer site-level binding first
  if (organizationSiteId) {
    const siteBinding = await prisma.representativeOrganization.findFirst({
      where: {
        representativeId: rep.id,
        organizationId,
        organizationSiteId,
        status: "ACTIVE",
      },
    });
    if (siteBinding) return false; // site-level binding found → no conflict
  }

  // Fall back to org-level binding (organizationSiteId = null)
  const orgBinding = await prisma.representativeOrganization.findFirst({
    where: {
      representativeId: rep.id,
      organizationId,
      organizationSiteId: null,
      status: "ACTIVE",
    },
  });
  return !orgBinding; // true = conflict (org not in rep's bindings)
}

export function checkCustomerOwnershipConflict(
  candidates: DuplicateCandidate[],
  submittedByUserId: string,
): boolean {
  return candidates.some(
    (c) => c.hasCrmProfile && c.profileOwnerUserId && c.profileOwnerUserId !== submittedByUserId,
  );
}

// ── Legacy helpers ───────────────────────────────────────────────────────────

interface OrgValidation {
  error?: string;
  organizationId: string | null;
  organizationSiteId: string | null;
  canonicalName: string | null;
  resolvedFromText?: boolean;
}

export async function validateOrg(
  organizationId: string | null | undefined,
  organizationSiteId: string | null | undefined,
  rawOrgText?: string | null,
  db: DbClient = prisma,
): Promise<OrgValidation> {
  // If no organizationId, try to resolve from raw text
  if (!organizationId) {
    if (rawOrgText?.trim()) {
      const resolved = await resolveOrganization(rawOrgText.trim());
      if (resolved.status === "exact" && resolved.organizationId) {
        return {
          organizationId: resolved.organizationId,
          organizationSiteId: resolved.organizationSiteId,
          canonicalName: resolved.canonicalName,
          resolvedFromText: true,
        };
      }
    }
    return { organizationId: null, organizationSiteId: null, canonicalName: null };
  }

  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, canonicalName: true, deleted: true, archived: true, isInvoiceSubject: true },
  });
  if (!org || org.deleted) {
    return { error: "指定的单位不存在", organizationId: null, organizationSiteId: null, canonicalName: null };
  }
  if (org.archived) {
    return { error: "指定的单位已归档，无法关联", organizationId: null, organizationSiteId: null, canonicalName: null };
  }
  // P0.7: Customer work unit org must be invoice subject
  if (!org.isInvoiceSubject) {
    return { error: "指定的单位未完成税务验真，暂不能作为客户机构绑定", organizationId: null, organizationSiteId: null, canonicalName: null };
  }

  const effectiveSiteId = (organizationSiteId || null);
  if (effectiveSiteId) {
    const site = await db.organizationSite.findUnique({
      where: { id: effectiveSiteId },
      select: { organizationId: true, archived: true },
    });
    if (!site || site.organizationId !== organizationId) {
      return { error: "院区不属于指定机构", organizationId: null, organizationSiteId: null, canonicalName: null };
    }
    if (site.archived) {
      return { error: "院区已归档，请选择有效院区或先恢复", organizationId: null, organizationSiteId: null, canonicalName: null };
    }
  }

  return {
    organizationId: org.id,
    organizationSiteId: effectiveSiteId,
    canonicalName: org.canonicalName,
  };
}

export function buildCustomerData(
  application: {
    name: string; principal: string | null; email: string | null; wechat: string | null;
    organization: string | null; address: string | null; miniProgramId: string | null;
    organizationId: string | null; organizationRawInput?: string | null;
  },
  orgValidation: OrgValidation
) {
  const rawInput = application.organizationRawInput?.trim() || application.organization?.trim() || null;
  return {
    name: application.name.trim(),
    principal: application.principal?.trim() || null,
    email: application.email?.trim() || null,
    wechat: application.wechat?.trim() || null,
    organization: orgValidation.canonicalName || application.organization?.trim() || null,
    address: application.address?.trim() || null,
    miniProgramId: application.miniProgramId?.trim() || null,
    organizationId: orgValidation.organizationId || null,
    organizationSiteId: orgValidation.organizationSiteId,
    organizationRawInput: rawInput,
  };
}

export function buildApplicationProfileData(
  customerData: ReturnType<typeof buildCustomerData>,
) {
  return {
    name: customerData.name,
    principal: customerData.principal,
    email: customerData.email,
    wechat: customerData.wechat,
    organization: customerData.organization,
    address: customerData.address,
    miniProgramId: customerData.miniProgramId,
    organizationId: customerData.organizationId,
    organizationSiteId: customerData.organizationSiteId,
    organizationRawInput: customerData.organizationRawInput,
  };
}

/**
 * 客户申请创建的统一 helper（确定性顺序）。
 *
 * Phase D（docs/customer-legacy-field-remediation-plan-2026-07-15.md）：不再建
 * Customer 锚点，直接 Profile-only 建档；`sourceCustomerId` 留空。
 *
 * 顺序不变量（违反会导致 owner/tag 漂移）：
 *   1. 基于申请里已解析好的机构字段（organizationId/organizationSiteId）解析 effective owner
 *   2. 建 Profile，一次性写入全部字段（含 organizationId/customerCode），ownerUserId 用最终 effective owner
 *   3. 用最终 effective owner 对应 representative 写 MANAGING tag（profileId 主键，customerId 留空）
 *   4. syncProfileRepresentativeLinks（对齐 Order/Project，owner 幂等）
 *
 * 必须在 $transaction 内调用（传入 tx）。
 */
export async function createApplicationCustomerWithProfile(
  tx: Prisma.TransactionClient,
  params: {
    name: string;
    customerCode: string;
    profileFields: ReturnType<typeof buildApplicationProfileData>;
    placeholderOwnerUserId: string;  // 未使用（保留字段名兼容旧调用方签名，effective 解析失败时的兜底见 fallbackOwnerUserId）
    fallbackOwnerUserId: string;     // effective resolver 全部失败（NONE）时的最终兜底
    actingUserId: string;
    actingNote: string;
  },
): Promise<{ profileId: string }> {
  const { name, customerCode, profileFields, fallbackOwnerUserId, actingUserId, actingNote } = params;
  void name; // profileFields.name 已包含姓名，保留参数是为了兼容调用方现有签名

  // 1) 基于申请已解析好的机构字段解析 effective owner（无 customerId 可用，直接按 org/site 解析）。
  const effective = await resolveEffectiveRepresentativeForOrg(
    profileFields.organizationId,
    profileFields.organizationSiteId,
    tx,
  );
  const finalOwnerUserId = effective.ownerUserId ?? fallbackOwnerUserId;

  // 2) Profile-only 建档，写入全部字段（含机构 + customerCode），ownerUserId 直接用最终 effective owner。
  //    namePinyin 与 name 同源计算（此 create 绕过 createCrmCustomerProfile，需显式补字段）。
  const profile = await tx.crmCustomerProfile.create({
    data: {
      // sourceCustomerId 留空：Profile-only 创建，不产生 Customer 锚点。
      ownerUserId: finalOwnerUserId,
      stage: "LEAD",
      importance: "NORMAL",
      lastFollowUpAt: new Date(),
      ...profileFields,
      namePinyin: toPinyinToneless(profileFields.name ?? "") || null,
      customerCode,
    },
    select: { id: true },
  });

  // 3) MANAGING tag：用最终 effective owner 对应的 representative（profileId 主键，customerId 留空）。
  const ownerRep = await resolveRepForUser(tx, finalOwnerUserId);
  if (ownerRep) {
    const now = new Date();
    await retireOtherManagingTags(tx, {
      profileId: profile.id, exceptRepId: ownerRep.id, now,
      actingUserId, note: actingNote,
    });
    await upsertManagingTag(tx, {
      profileId: profile.id, representativeId: ownerRep.id, now, actingUserId,
    });
  }

  // 4) sync：对齐 Order/Project.representativeId。
  //    关键不变量——sync 后 owner 不会漂移，分两种情况：
  //    - SITE/ORG/SYSTEM_FALLBACK（有 effective owner）：sync 回写同一 effective.ownerUserId（幂等）。
  //    - NONE（机构无绑定且无本部代表）：sync 因 effective owner 为空会跳过覆盖、保留上面写入的 fallback 值。
  //    两种情况下 owner 都不会在 sync 阶段被二次改变，tag 不会指向被覆盖的旧 owner。
  await syncProfileRepresentativeLinks(profile.id, tx);

  // 5) 部门隔离 Phase 4：补齐两行部门 state（申请审批属 FIELD_SALES 流程，
  //    FIELD_SALES CLAIMED + ONLINE_OPS 隐藏 POOL；assignmentStatus 走 schema 默认 ASSIGNED）。
  await ensureDepartmentStatesForLegacyProfile(
    profile.id,
    {
      ownerUserId: finalOwnerUserId,
      assignmentStatus: "ASSIGNED",
      stage: "LEAD",
      importance: "NORMAL",
      assignedAt: new Date(),
      assignedByUserId: actingUserId,
    },
    tx,
  );

  return { profileId: profile.id };
}

async function resolveRepForUser(tx: Prisma.TransactionClient, userId: string) {
  const u = await tx.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!u?.email) return null;
  return tx.representative.findUnique({ where: { email: u.email }, select: { id: true } });
}

type PrismaClientLike = {
  $transaction: typeof prisma.$transaction;
};

export async function createCustomerWithRetry(
  client: PrismaClientLike,
  customerData: ReturnType<typeof buildCustomerData>,
  applicationId: string,
  ownerUserId: string,
  reviewerUserId: string,
  reviewNote: string | null,
  location?: { lat: number; lng: number; address: string } | null,
): Promise<{ error?: string; status?: number; application?: Record<string, unknown> | null }> {
  // U2：客户必须有机构。审批建客户前强制 organizationId 非空——validateOrg 解析不出
  // 有效机构（既无 organizationId 也无法从 rawText 解析）时拒绝审批，不建无机构客户。
  // 单条审批路径 → 返回 400；批量审批路径 → 记入 errors 跳过该行。
  if (!customerData.organizationId) {
    return { error: "审批前必须为客户绑定有效机构，请在申请中补全可识别的单位后再审批", status: 400 };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await client.$transaction(async (tx: any) => {
        // Atomically claim the application with a conditional write
        const claim = await tx.crmCustomerApplication.updateMany({
          where: { id: applicationId, status: "PENDING" },
          data: { reviewedByUserId: reviewerUserId, reviewedAt: new Date() },
        });
        if (claim.count === 0) {
          return { skipped: true };
        }

        const customerCode = await generateCustomerCode(tx);
        const profileData = buildApplicationProfileData(customerData);

        const { profileId } = await createApplicationCustomerWithProfile(tx, {
          name: customerData.name,
          customerCode,
          profileFields: profileData,
          placeholderOwnerUserId: ownerUserId,
          fallbackOwnerUserId: ownerUserId,
          actingUserId: reviewerUserId,
          actingNote: reviewNote || "申请审批：管理关系转为跟进历史",
        });

        // Create CrmCustomerAddress from location data if available
        if (location?.address?.trim()) {
          await tx.crmCustomerAddress.create({
            data: {
              profileId,
              sourceType: "CUSTOMER_APPLICATION",
              addressText: location.address.trim(),
              lat: location.lat,
              lng: location.lng,
              isPrimary: true,
            },
          });
        }

        const updated = await tx.crmCustomerApplication.update({
          where: { id: applicationId },
          data: {
            status: "APPROVED",
            reviewedByUserId: reviewerUserId,
            reviewedAt: new Date(),
            reviewNote,
            createdCrmProfileId: profileId,
          },
          include: {
            submittedByUser: { select: { id: true, name: true, email: true } },
            reviewedByUser: { select: { id: true, name: true } },
            createdCrmProfile: { select: { id: true, name: true, customerCode: true } },
          },
        });

        return { skipped: false, application: updated };
      });

      if (result.skipped) {
        return { error: "申请已被处理", status: 400 };
      }
      return { application: result.application };
    } catch (e: unknown) {
      const isPrismaUnique = typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002";
      if (!isPrismaUnique || attempt === 2) {
        console.error("Approve application error:", e);
        return { error: "审核操作失败", status: 500 };
      }
    }
  }

  return { error: "审核操作失败", status: 500 };
}
