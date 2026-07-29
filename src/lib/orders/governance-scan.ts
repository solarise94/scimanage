/**
 * 存量订单分层治理扫描（设计文档 §11：G1/G2/G3/G4；W6.7b Profile-only 契约）。
 *
 * 重要边界：
 *  - 扫描只读。写动作走 batch 端点，且只收/写 profileId。
 *  - 可内部观察遗留 Order.customerId 脏数据，但不得作为治理主体或对外 DTO。
 *  - G2 只给建议；G3 以 Profile effective resolver 为准；G4 只读。
 *  - 状态口径 CONFIRMED/DELIVERED/CLOSED。
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveEffectiveRepresentativesForProfiles } from "@/lib/crm/customer-effective-representative";
import { createMatchContext, resolveMatch } from "@/lib/finance/pingoodmice-match";
import { isStrongSignalEmpty, readProfileOrg } from "@/lib/governance/common";
import { resolveOrganization } from "@/lib/organization-resolver";
import {
  loadAddressMatchOrganizations,
  extractOrgFromAddress,
  type AddressMatchOrg,
} from "@/lib/orders/order-address-org";

type DbLike = typeof prisma | Prisma.TransactionClient;

// 口径单一来源在 governance/common.ts；此处 re-export 以兼容现有 import 路径。
export { GOVERNANCE_ORDER_STATUSES } from "@/lib/governance/common";
import { GOVERNANCE_ORDER_STATUSES } from "@/lib/governance/common";

function nonEmpty(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s ? s : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// G3：代表不一致（§11.4）
// ─────────────────────────────────────────────────────────────────────────────

export interface RepMismatchRecord {
  orderId: string;
  orderNo: string;
  status: string;
  category: string;
  totalAmount: number;
  createdAt: Date;
  profileId: string;
  customerName: string | null;
  currentRepId: string | null;
  currentRepName: string | null;
  effectiveRepId: string | null;
  effectiveRepName: string | null;
  effectiveSource: string;
  /** effectiveSource !== "NONE" 时可一键按 effective resolver 回填；NONE 需先补机构/站点绑定。 */
  autoFixable: boolean;
}

/** G3 活动主体：未删/未归档/未合并且 ASSIGNED（排除 RECALLED 等，防止把已清空的代表缓存写回）。 */
export const G3_ACTIVE_ASSIGNED_PROFILE_WHERE = {
  deleted: false,
  archived: false,
  mergedIntoProfileId: null,
  assignmentStatus: "ASSIGNED",
} as const;

export type SyncOrderRepresentativesResult = {
  synced: number;
  unchanged: number;
  needsBinding: number;
  skipped: number;
};

/**
 * G3 扫描：活动 ASSIGNED Profile 上的订单里，
 * order.representativeId 与 Profile effective resolver 不一致。
 */
export async function scanRepresentativeMismatch(db: DbLike = prisma): Promise<RepMismatchRecord[]> {
  const orders = await db.order.findMany({
    where: {
      deleted: false,
      archived: false,
      profileId: { not: null },
      status: { in: [...GOVERNANCE_ORDER_STATUSES] },
      profile: G3_ACTIVE_ASSIGNED_PROFILE_WHERE,
    },
    select: {
      id: true,
      orderNo: true,
      status: true,
      category: true,
      totalAmount: true,
      createdAt: true,
      profileId: true,
      representativeId: true,
      profile: { select: { id: true, name: true } },
      representative: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const profileIds = [
    ...new Set(orders.map((o) => o.profileId).filter((id): id is string => !!id)),
  ];
  const effMap = await resolveEffectiveRepresentativesForProfiles(profileIds, db);

  const records: RepMismatchRecord[] = [];
  for (const o of orders) {
    if (!o.profileId) continue;
    const eff = effMap.get(o.profileId);
    const effRepId = eff?.representativeId ?? null;
    const effRepName = eff?.representativeName ?? null;
    const effSource = eff?.source ?? "NONE";

    if ((o.representativeId ?? null) === effRepId) continue;
    records.push({
      orderId: o.id,
      orderNo: o.orderNo,
      status: o.status,
      category: o.category,
      totalAmount: o.totalAmount,
      createdAt: o.createdAt,
      profileId: o.profileId,
      customerName: o.profile?.name ?? null,
      currentRepId: o.representativeId ?? null,
      currentRepName: o.representative?.name ?? null,
      effectiveRepId: effRepId,
      effectiveRepName: effRepName,
      effectiveSource: effSource,
      autoFixable: effSource !== "NONE",
    });
  }
  return records;
}

/**
 * G3 写端：按 Profile effective resolver 回填订单代表。
 * 独立复核活动 ASSIGNED Profile，不依赖扫描候选集。
 */
export async function syncOrderRepresentativesFromEffective(
  orderIds: string[],
  db: DbLike = prisma,
): Promise<SyncOrderRepresentativesResult> {
  const uniqueIds = [...new Set(orderIds.filter(Boolean))];
  const result: SyncOrderRepresentativesResult = {
    synced: 0,
    unchanged: 0,
    needsBinding: 0,
    skipped: 0,
  };
  if (uniqueIds.length === 0) return result;

  const orders = await db.order.findMany({
    where: {
      id: { in: uniqueIds },
      deleted: false,
      archived: false,
      profileId: { not: null },
      status: { in: [...GOVERNANCE_ORDER_STATUSES] },
      profile: G3_ACTIVE_ASSIGNED_PROFILE_WHERE,
    },
    select: { id: true, profileId: true, representativeId: true },
  });

  const foundIds = new Set(orders.map((o) => o.id));
  result.skipped = uniqueIds.filter((id) => !foundIds.has(id)).length;

  const profileIds = [
    ...new Set(orders.map((o) => o.profileId).filter((id): id is string => !!id)),
  ];
  const repMap = await resolveEffectiveRepresentativesForProfiles(profileIds, db);

  for (const o of orders) {
    if (!o.profileId) {
      result.skipped++;
      continue;
    }
    const eff = repMap.get(o.profileId);
    if (!eff || eff.source === "NONE" || !eff.representativeId) {
      result.needsBinding++;
      continue;
    }
    if ((o.representativeId ?? null) === eff.representativeId) {
      result.unchanged++;
      continue;
    }
    await db.order.update({
      where: { id: o.id },
      data: { representativeId: eff.representativeId },
    });
    result.synced++;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// G2：疑似错绑（§11.3）——只给建议，不自动改绑
// ─────────────────────────────────────────────────────────────────────────────

export interface MisbindingRecord {
  orderId: string;
  orderNo: string;
  status: string;
  category: string;
  totalAmount: number;
  createdAt: Date;
  currentProfileId: string;
  currentCustomerName: string | null;
  suggestedProfileId: string;
  suggestedCustomerName: string;
  suggestedScore: number;
  suggestedReason: string;
  currentScore: number;
  scoreDelta: number;
}

/**
 * G2 扫描：对已绑 Profile 的订单用快照重跑匹配；
 * 高置信 AUTO_SUGGESTED 且 suggestedProfileId ≠ currentProfileId → 疑似错绑。
 * 修复动作只认 profileId（见 bind-order-customer REBIND）。
 */
export async function scanSuspectedMisbinding(): Promise<MisbindingRecord[]> {
  const ctx = await createMatchContext();
  const orders = await prisma.order.findMany({
    where: {
      deleted: false,
      archived: false,
      profileId: { not: null },
      status: { in: [...GOVERNANCE_ORDER_STATUSES] },
    },
    select: {
      id: true,
      orderNo: true,
      status: true,
      category: true,
      totalAmount: true,
      createdAt: true,
      profileId: true,
      profile: { select: { id: true, name: true } },
      buyerNameSnapshot: true,
      buyerPhoneSnapshot: true,
      buyerWechatSnapshot: true,
      buyerMiniProgramIdSnapshot: true,
      buyerOrgNameSnapshot: true,
      buyerAddressSnapshot: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const records: MisbindingRecord[] = [];
  for (const o of orders) {
    if (!o.profileId) continue;
    const hasStrong =
      nonEmpty(o.buyerMiniProgramIdSnapshot) || nonEmpty(o.buyerWechatSnapshot) || nonEmpty(o.buyerPhoneSnapshot);
    if (!hasStrong) continue;

    const resolution = resolveMatch(ctx, {
      buyerName: o.buyerNameSnapshot,
      buyerPhone: o.buyerPhoneSnapshot,
      buyerWechat: o.buyerWechatSnapshot,
      buyerMiniProgramId: o.buyerMiniProgramIdSnapshot,
      buyerOrgName: o.buyerOrgNameSnapshot,
      buyerAddress: o.buyerAddressSnapshot,
    });

    const best = resolution.best;
    if (!best) continue;
    if (resolution.status !== "AUTO_SUGGESTED") continue;

    const currentProfileId = o.profileId;
    const suggestedProfileId = resolution.suggestedProfileId ?? best.profileId ?? null;
    if (!suggestedProfileId || suggestedProfileId === currentProfileId) continue;

    const currentScore =
      resolution.candidates.find((c) => c.profileId === currentProfileId)?.score ?? 0;
    records.push({
      orderId: o.id,
      orderNo: o.orderNo,
      status: o.status,
      category: o.category,
      totalAmount: o.totalAmount,
      createdAt: o.createdAt,
      currentProfileId,
      currentCustomerName: o.profile?.name ?? null,
      suggestedProfileId,
      suggestedCustomerName: best.name,
      suggestedScore: best.score,
      suggestedReason: best.reason,
      currentScore,
      scoreDelta: best.score - currentScore,
    });
  }
  return records;
}

// ─────────────────────────────────────────────────────────────────────────────
// G4：历史快照缺失（§11.5）——只读
// ─────────────────────────────────────────────────────────────────────────────

export interface MissingSnapshotRecord {
  orderId: string;
  orderNo: string;
  status: string;
  category: string;
  totalAmount: number;
  createdAt: Date;
  profileId: string | null;
  customerName: string | null;
  buyerNameSnapshot: string | null;
  buyerOrgNameSnapshot: string | null;
  buyerAddressSnapshot: string | null;
}

/** 缺失全部强身份快照（姓名/电话/微信/小程序ID 皆空）的订单 where 子句，无法用匹配引擎回放。 */
const MISSING_SNAPSHOT_WHERE: Prisma.OrderWhereInput = {
  deleted: false,
  archived: false,
  status: { in: [...GOVERNANCE_ORDER_STATUSES] },
  AND: [
    { OR: [{ buyerNameSnapshot: null }, { buyerNameSnapshot: "" }] },
    { OR: [{ buyerPhoneSnapshot: null }, { buyerPhoneSnapshot: "" }] },
    { OR: [{ buyerWechatSnapshot: null }, { buyerWechatSnapshot: "" }] },
    { OR: [{ buyerMiniProgramIdSnapshot: null }, { buyerMiniProgramIdSnapshot: "" }] },
  ],
};

/** G4 扫描：列出无强身份快照、无法自动回放的「空快照」订单（只读）。 */
export async function scanMissingSnapshots(db: DbLike = prisma): Promise<MissingSnapshotRecord[]> {
  const orders = await db.order.findMany({
    where: MISSING_SNAPSHOT_WHERE,
    select: {
      id: true,
      orderNo: true,
      status: true,
      category: true,
      totalAmount: true,
      createdAt: true,
      profileId: true,
      profile: { select: { name: true } },
      buyerNameSnapshot: true,
      buyerOrgNameSnapshot: true,
      buyerAddressSnapshot: true,
    },
    orderBy: { createdAt: "desc" },
  });
  return orders.map((o) => ({
    orderId: o.id,
    orderNo: o.orderNo,
    status: o.status,
    category: o.category,
    totalAmount: o.totalAmount,
    createdAt: o.createdAt,
    profileId: o.profileId,
    customerName: o.profile?.name ?? null,
    buyerNameSnapshot: o.buyerNameSnapshot,
    buyerOrgNameSnapshot: o.buyerOrgNameSnapshot,
    buyerAddressSnapshot: o.buyerAddressSnapshot,
  }));
}

export function countMissingSnapshots(db: DbLike = prisma): Promise<number> {
  return db.order.count({ where: MISSING_SNAPSHOT_WHERE });
}

// ─────────────────────────────────────────────────────────────────────────────
// G4 换绑财务关联守卫（§6.3）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 判断订单是否存在发票/回款等财务关联数据。
 * 口径：
 *  - 非 CANCELLED 状态的发票申请（ExternalOrderInvoiceRequest）
 *  - 未删除的回款（FinanceReceipt）
 *  - 通过 FinanceReceiptAllocation 关联到该订单的回款（未删除）
 *
 * 只要命中任意一项，换绑即需填写原因 + 显式确认。
 */
export async function orderHasFinancialAssociations(
  orderId: string,
  db: DbLike = prisma,
): Promise<boolean> {
  const [invoiceCount, receiptCount, allocationCount] = await Promise.all([
    db.externalOrderInvoiceRequest.count({
      where: {
        orderId,
        status: { not: "CANCELLED" },
      },
    }),
    db.financeReceipt.count({
      where: {
        orderId,
        deleted: false,
      },
    }),
    db.financeReceiptAllocation.count({
      where: {
        orderId,
        receipt: { deleted: false },
      },
    }),
  ]);

  return invoiceCount > 0 || receiptCount > 0 || allocationCount > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// G1 增强：按快照重新匹配（§11.2 / §11.6.A）——含 buyerMiniProgramIdSnapshot 重扫
// ─────────────────────────────────────────────────────────────────────────────

export interface RematchCandidate {
  profileId: string;
  name: string;
  score: number;
  reason: string;
}

export interface RematchResult {
  orderId: string;
  orderNo: string;
  /** AUTO_SUGGESTED | AMBIGUOUS | NO_MATCH */
  status: string;
  suggestedProfileId: string | null;
  suggestedScore: number | null;
  suggestedReason: string | null;
  candidates: RematchCandidate[];
}

/**
 * 对一批订单用其原始快照（含 buyerMiniProgramIdSnapshot）重跑 Profile-first 匹配，返回三态建议。
 * 供「无客户订单」治理页的「重新匹配」入口使用，建议由人工在治理页确认后再走 batch-bind-customer 落绑。
 *
 * W6.3b：只返回 profileId；AUTO_SUGGESTED 但缺 profileId 时降为 NO_MATCH（fail-closed）。
 */
export async function rematchOrdersFromSnapshots(orderIds: string[]): Promise<RematchResult[]> {
  const ids = [...new Set(orderIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const ctx = await createMatchContext();
  const orders = await prisma.order.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      orderNo: true,
      buyerNameSnapshot: true,
      buyerPhoneSnapshot: true,
      buyerWechatSnapshot: true,
      buyerMiniProgramIdSnapshot: true,
      buyerOrgNameSnapshot: true,
      buyerAddressSnapshot: true,
    },
  });

  return orders.map((o) => {
    const resolution = resolveMatch(ctx, {
      buyerName: o.buyerNameSnapshot,
      buyerPhone: o.buyerPhoneSnapshot,
      buyerWechat: o.buyerWechatSnapshot,
      buyerMiniProgramId: o.buyerMiniProgramIdSnapshot,
      buyerOrgName: o.buyerOrgNameSnapshot,
      buyerAddress: o.buyerAddressSnapshot,
    });

    const candidates: RematchCandidate[] = resolution.candidates
      .slice(0, 5)
      .filter((c): c is typeof c & { profileId: string } => !!c.profileId)
      .map((c) => ({
        profileId: c.profileId,
        name: c.name,
        score: c.score,
        reason: c.reason,
      }));

    let status = resolution.status;
    let suggestedProfileId =
      resolution.suggestedProfileId
      ?? resolution.best?.profileId
      ?? null;

    if (status === "AUTO_SUGGESTED" && !suggestedProfileId) {
      status = "NO_MATCH";
      suggestedProfileId = null;
    }
    if (suggestedProfileId && !candidates.some((c) => c.profileId === suggestedProfileId)) {
      // 建议 id 不在带 profileId 的候选中 → fail-closed
      if (status === "AUTO_SUGGESTED") status = "NO_MATCH";
      suggestedProfileId = null;
    }

    return {
      orderId: o.id,
      orderNo: o.orderNo,
      status,
      suggestedProfileId,
      suggestedScore: resolution.best?.score ?? null,
      suggestedReason: resolution.best?.reason ?? null,
      candidates,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// O5：订单购买方机构补绑扫描（Order.buyerOrganizationId）
//
// 轻量列表模式：扫描 buyerOrganizationId = null 且处于治理范围的订单。
// 优先从快照解析强命中机构（resolveOrganization(buyerOrgNameSnapshot)），
// 无强命中时从地址抽取（CANONICAL_HIT 或 PATTERN_TEXT）。仅 EXACT/CANONICAL_HIT
// 可直接用于一键绑定；弱候选只展示，不自动写库。不建 OrderOrgBindingTask 表。
// ─────────────────────────────────────────────────────────────────────────────

export interface OrderOrgBindingRecord {
  orderId: string;
  orderNo: string;
  status: string;
  category: string;
  totalAmount: number;
  createdAt: Date;
  profileId: string | null;
  customerName: string | null;
  /** 当前 buyerOrgNameSnapshot 文本快照 */
  buyerOrgNameSnapshot: string | null;
  /** 当前 buyerAddressSnapshot 文本快照 */
  buyerAddressSnapshot: string | null;
  /** 来自客户档案（CrmCustomerProfile.organizationId）的机构候选——最可靠来源 */
  profileOrgCandidate: {
    organizationId: string;
    canonicalName: string;
    isInvoiceSubject: boolean;
  } | null;
  /** 从 resolveOrganization(buyerOrgNameSnapshot) 得到的 EXACT 强命中 */
  resolvedOrg: {
    organizationId: string;
    canonicalName: string;
    isInvoiceSubject: boolean;
    archived: boolean;
  } | null;
  /** 从 buyerAddressSnapshot 抽取的机构候选 */
  addressCandidate: {
    kind: "CANONICAL_HIT" | "PATTERN_TEXT";
    organizationId: string | null;
    text: string;
  } | null;
  /** 是否存在财务关联（阶段0 硬门槛：此类订单绑定率必须 100%） */
  hasFinancialAssociations: boolean;
}

/** 扫描需要补绑购买方机构的订单。cheap 查询后按需做地址抽取。 */
export async function scanOrdersMissingBuyerOrg(
  page = 1,
  pageSize = 20,
  db: DbLike = prisma,
): Promise<{ rows: OrderOrgBindingRecord[]; total: number }> {
  const where: Prisma.OrderWhereInput = {
    deleted: false,
    archived: false,
    buyerOrganizationId: null,
    status: { in: [...GOVERNANCE_ORDER_STATUSES] },
  };

  const [orders, total] = await Promise.all([
    db.order.findMany({
      where,
      skip: Math.max(0, page - 1) * pageSize,
      take: pageSize,
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        orderNo: true,
        status: true,
        category: true,
        totalAmount: true,
        createdAt: true,
        profileId: true,
        profile: {
          select: {
            name: true,
            organizationId: true,
            org: { select: { canonicalName: true, isInvoiceSubject: true, archived: true, deleted: true } },
          },
        },
        buyerOrgNameSnapshot: true,
        buyerAddressSnapshot: true,
      },
    }),
    db.order.count({ where }),
  ]);

  if (orders.length === 0) return { rows: [], total };

  // 首选候选：从绑定 Profile.organizationId 读取——最可靠来源。
  const profileOrgByOrder = new Map<string, OrderOrgBindingRecord["profileOrgCandidate"]>();
  for (const o of orders) {
    const profile = o.profile;
    if (profile?.organizationId && profile.org && !profile.org.deleted && !profile.org.archived) {
      profileOrgByOrder.set(o.id, {
        organizationId: profile.organizationId,
        canonicalName: profile.org.canonicalName,
        isInvoiceSubject: profile.org.isInvoiceSubject,
      });
    }
  }

  // 批量解析 buyerOrgNameSnapshot（强命中 only）
  const resolvedByOrder = new Map<string, OrderOrgBindingRecord["resolvedOrg"]>();
  const resolveInputs = orders
    .map((o) => ({ orderId: o.id, raw: nonEmpty(o.buyerOrgNameSnapshot) }))
    .filter((x): x is { orderId: string; raw: string } => !!x.raw);
  await Promise.all(
    resolveInputs.map(async ({ orderId, raw }) => {
      const r = await resolveOrganization(raw);
      if (r.status === "exact" && r.organizationId) {
        resolvedByOrder.set(orderId, {
          organizationId: r.organizationId,
          canonicalName: r.canonicalName || r.organizationId,
          // 完整机构信息稍后批量补；这里先占位 isInvoiceSubject 为 true（exact 必须可开票才 bind）
          isInvoiceSubject: true,
          archived: false,
        });
      }
    }),
  );

  // 批量补全 resolved org 的完整字段（isInvoiceSubject / archived）
  const resolvedOrgIds = [...new Set([...resolvedByOrder.values()].map((o) => o?.organizationId).filter((id): id is string => !!id))];
  if (resolvedOrgIds.length > 0) {
    const orgs = await db.organization.findMany({
      where: { id: { in: resolvedOrgIds } },
      select: { id: true, canonicalName: true, isInvoiceSubject: true, archived: true },
    });
    const orgMap = new Map(orgs.map((o) => [o.id, o]));
    for (const [orderId, res] of resolvedByOrder.entries()) {
      if (!res) continue;
      const full = orgMap.get(res.organizationId);
      if (full) {
        resolvedByOrder.set(orderId, {
          organizationId: full.id,
          canonicalName: full.canonicalName,
          isInvoiceSubject: full.isInvoiceSubject,
          archived: full.archived,
        });
      } else {
        resolvedByOrder.delete(orderId);
      }
    }
  }

  // 地址候选：仅对没有强命中的行按需抽取
  const rowsNeedingAddress = orders.filter((o) => !resolvedByOrder.has(o.id) && nonEmpty(o.buyerAddressSnapshot));
  let addressOrgs: AddressMatchOrg[] | null = null;
  if (rowsNeedingAddress.length > 0) addressOrgs = await loadAddressMatchOrganizations();
  const addressCandidateByOrder = new Map<string, OrderOrgBindingRecord["addressCandidate"]>();
  for (const o of rowsNeedingAddress) {
    if (!addressOrgs) break;
    const cand = extractOrgFromAddress(addressOrgs, o.buyerAddressSnapshot);
    if (cand) addressCandidateByOrder.set(o.id, cand);
  }

  // 批量财务关联判断
  const financeChecks = await Promise.all(
    orders.map(async (o) => ({ orderId: o.id, hasFinance: await orderHasFinancialAssociations(o.id, db) })),
  );
  const financeByOrder = new Map(financeChecks.map((c) => [c.orderId, c.hasFinance]));

  const rows: OrderOrgBindingRecord[] = orders.map((o) => ({
    orderId: o.id,
    orderNo: o.orderNo,
    status: o.status,
    category: o.category,
    totalAmount: o.totalAmount,
    createdAt: o.createdAt,
    profileId: o.profileId,
    customerName: o.profile?.name ?? null,
    buyerOrgNameSnapshot: o.buyerOrgNameSnapshot,
    buyerAddressSnapshot: o.buyerAddressSnapshot,
    profileOrgCandidate: profileOrgByOrder.get(o.id) ?? null,
    resolvedOrg: resolvedByOrder.get(o.id) ?? null,
    addressCandidate: addressCandidateByOrder.get(o.id) ?? null,
    hasFinancialAssociations: financeByOrder.get(o.id) ?? false,
  }));

  return { rows, total };
}

// ─────────────────────────────────────────────────────────────────────────────
// O2：绑空壳客户的订单（设计文档 §4.2 / §八 Phase G3；W6.6 Profile 主体）
//
// O2 = 订单已挂 Profile（或遗留 customer 锚点可映射到 Profile）AND 该 Profile
// isStrongSignalEmpty。本质是 C2 在订单上的投影。治理定位「展示 + 导航到 C2」。
// ─────────────────────────────────────────────────────────────────────────────

export type EmptyShellOrderPath = "CUSTOMER_TEXT" | "ADDRESS" | "REBINDABLE" | "INFO_INCOMPLETE" | "CONTACT_MISSING";

/** O2 原始行（cheap：仅做 isStrongSignalEmpty 过滤，未跑地址/重匹配分类）。 */
export interface RawEmptyShellBoundOrder {
  orderId: string;
  orderNo: string;
  status: string;
  category: string;
  totalAmount: number;
  createdAt: Date;
  profileId: string;
  customerName: string | null;
  customerOrgText: string | null;
  customerOrgId: string | null;
  buyerNameSnapshot: string | null;
  buyerPhoneSnapshot: string | null;
  buyerWechatSnapshot: string | null;
  buyerMiniProgramIdSnapshot: string | null;
  buyerOrgNameSnapshot: string | null;
  buyerAddressSnapshot: string | null;
}

/** O2 富化行（含治理路径 + 地址候选 + 换绑建议）。 */
export interface EmptyShellBoundOrder {
  orderId: string;
  orderNo: string;
  status: string;
  category: string;
  totalAmount: number;
  createdAt: Date;
  profileId: string;
  customerName: string | null;
  customerOrgText: string | null;
  customerOrgId: string | null;
  path: EmptyShellOrderPath;
  addressCandidateOrg: string | null;
  addressCandidateExact: boolean;
  rebindSuggestedProfileId: string | null;
  rebindSuggestedCustomerName: string | null;
}

/** 加载全部「绑空壳 Profile」的订单（cheap 过滤；W6.7 只认 profileId）。 */
export async function loadEmptyShellBoundOrders(): Promise<RawEmptyShellBoundOrder[]> {
  const orders = await prisma.order.findMany({
    where: {
      deleted: false,
      archived: false,
      status: { in: [...GOVERNANCE_ORDER_STATUSES] },
      profileId: { not: null },
    },
    select: {
      id: true,
      orderNo: true,
      status: true,
      category: true,
      totalAmount: true,
      createdAt: true,
      profileId: true,
      buyerNameSnapshot: true,
      buyerPhoneSnapshot: true,
      buyerWechatSnapshot: true,
      buyerMiniProgramIdSnapshot: true,
      buyerOrgNameSnapshot: true,
      buyerAddressSnapshot: true,
      profile: {
        select: {
          id: true,
          name: true,
          wechat: true,
          phone: true,
          principal: true,
          miniProgramId: true,
          organization: true,
          organizationId: true,
          deleted: true,
          archived: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const rows: RawEmptyShellBoundOrder[] = [];
  for (const o of orders) {
    const p = o.profile && !o.profile.deleted && !o.profile.archived ? o.profile : null;
    if (!p || !o.profileId) continue;
    if (!isStrongSignalEmpty(p)) continue;
    const org = readProfileOrg(p);
    rows.push({
      orderId: o.id,
      orderNo: o.orderNo,
      status: o.status,
      category: o.category,
      totalAmount: o.totalAmount,
      createdAt: o.createdAt,
      profileId: o.profileId,
      customerName: p.name ?? null,
      customerOrgText: org.organization,
      customerOrgId: org.organizationId,
      buyerNameSnapshot: o.buyerNameSnapshot,
      buyerPhoneSnapshot: o.buyerPhoneSnapshot,
      buyerWechatSnapshot: o.buyerWechatSnapshot,
      buyerMiniProgramIdSnapshot: o.buyerMiniProgramIdSnapshot,
      buyerOrgNameSnapshot: o.buyerOrgNameSnapshot,
      buyerAddressSnapshot: o.buyerAddressSnapshot,
    });
  }
  return rows;
}

export async function countEmptyShellBoundOrders(): Promise<number> {
  return (await loadEmptyShellBoundOrders()).length;
}

/**
 * 富化一批 O2 原始行 → 标注治理路径（设计文档 §4.2 路径表）。
 * 仅对传入的切片（通常是当前页）做地址抽取与重匹配，重活随分页有界。
 *
 * 分类顺序（成本递增，命中即止）：
 *  1. 已绑机构（customerOrgId 有值）→ CONTACT_MISSING（机构已绑，缺联系方式，去 CRM 补）。
 *  2. 有机构文本未绑 → CUSTOMER_TEXT（去 C2 文本补）。
 *  3. 地址抽到机构候选 → ADDRESS（去 C2 地址补）。
 *  4. 快照有强信号 → 重匹配，命中非空壳 AUTO_SUGGESTED → REBINDABLE。
 *  5. 否则 INFO_INCOMPLETE。
 */
export async function classifyEmptyShellBoundOrders(
  rows: RawEmptyShellBoundOrder[],
): Promise<EmptyShellBoundOrder[]> {
  if (rows.length === 0) return [];

  // 地址候选：仅对无机构文本的行需要，按需加载一次机构主数据。
  const needAddress = rows.filter((r) => !r.customerOrgText);
  let addressOrgs: AddressMatchOrg[] | null = null;
  if (needAddress.length > 0) addressOrgs = await loadAddressMatchOrganizations();

  // 重匹配：仅对「无机构文本 + 地址无候选 + 快照有强信号」的残差行跑引擎。
  // 注意：已绑机构（customerOrgId 有值）的行已在前面 CONTACT_MISSING 分支处理，不会进入这里。
  const addressHitByOrder = new Map<string, { text: string; exact: boolean }>();
  const residualForRematch: RawEmptyShellBoundOrder[] = [];
  for (const r of rows) {
    if (r.customerOrgText || r.customerOrgId) continue;
    const cand = addressOrgs ? extractOrgFromAddress(addressOrgs, r.buyerAddressSnapshot) : null;
    if (cand) {
      addressHitByOrder.set(r.orderId, { text: cand.text, exact: cand.kind === "CANONICAL_HIT" });
      continue;
    }
    const hasStrong =
      nonEmpty(r.buyerMiniProgramIdSnapshot) || nonEmpty(r.buyerWechatSnapshot) || nonEmpty(r.buyerPhoneSnapshot);
    if (hasStrong) residualForRematch.push(r);
  }

  const rebindByOrder = new Map<string, { profileId: string; name: string }>();
  if (residualForRematch.length > 0) {
    const ctx = await createMatchContext();
    for (const r of residualForRematch) {
      const resolution = resolveMatch(ctx, {
        buyerName: r.buyerNameSnapshot,
        buyerPhone: r.buyerPhoneSnapshot,
        buyerWechat: r.buyerWechatSnapshot,
        buyerMiniProgramId: r.buyerMiniProgramIdSnapshot,
        buyerOrgName: r.buyerOrgNameSnapshot,
        buyerAddress: r.buyerAddressSnapshot,
      });
      // AUTO_SUGGESTED：命中非空壳 Profile；与当前 profileId 不同才可换绑。
      const best = resolution.best;
      const bestProfileId = best?.profileId ?? null;
      if (
        resolution.status === "AUTO_SUGGESTED"
        && best
        && bestProfileId
        && bestProfileId !== r.profileId
      ) {
        rebindByOrder.set(r.orderId, { profileId: bestProfileId, name: best.name });
      }
    }
  }

  return rows.map((r) => {
    let path: EmptyShellOrderPath;
    let addressCandidateOrg: string | null = null;
    let addressCandidateExact = false;
    let rebindSuggestedCustomerName: string | null = null;
    let rebindSuggestedProfileId: string | null = null;

    if (r.customerOrgId) {
      path = "CONTACT_MISSING";
    } else if (r.customerOrgText) {
      path = "CUSTOMER_TEXT";
    } else {
      const addr = addressHitByOrder.get(r.orderId);
      const rebind = rebindByOrder.get(r.orderId);
      if (addr) {
        path = "ADDRESS";
        addressCandidateOrg = addr.text;
        addressCandidateExact = addr.exact;
      } else if (rebind) {
        path = "REBINDABLE";
        rebindSuggestedCustomerName = rebind.name;
        rebindSuggestedProfileId = rebind.profileId;
      } else {
        path = "INFO_INCOMPLETE";
      }
    }

    return {
      orderId: r.orderId,
      orderNo: r.orderNo,
      status: r.status,
      category: r.category,
      totalAmount: r.totalAmount,
      createdAt: r.createdAt,
      profileId: r.profileId,
      customerName: r.customerName,
      customerOrgText: r.customerOrgText,
      customerOrgId: r.customerOrgId,
      path,
      addressCandidateOrg,
      addressCandidateExact,
      rebindSuggestedCustomerName,
      rebindSuggestedProfileId,
    };
  });
}
