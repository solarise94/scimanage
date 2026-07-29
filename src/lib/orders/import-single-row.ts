/**
 * 单行订单导入领域服务（docs/agent-sequential-order-import-upgrade-design-2026-07-21.md §5）。
 *
 * 页面 commit 路径与未来 Agent proposal 路径共用这里的 4 个函数：
 *   analyzeImportRow  只读分析，产出 CREATE / UPDATE / CONFLICT 计划
 *   prepareImportRow  持久化客户决策（CONFIRMED_*），乐观 version++
 *   commitImportRow   单行事务：claim PROPOSED→IMPORTING，创建/更新订单，落 IMPORTED
 *   skipImportRow     把非终态行标记 DROPPED
 *
 * 唯一的正式订单写入逻辑在 `writeOrderForRow`（§5.5）。commitImportRow 与页面 commit 路由
 * 必须都走这一个函数，禁止出现第二套 create/update 订单逻辑。
 *
 * 幂等键使用精确来源 `(source, externalOrderNo)`（§5.3）：findExactSourceOrder 决定 UPDATE，
 * findCrossSourceConflict 决定 CONFLICT。**不**使用带跨来源 fallback 的 findExistingImportOrder。
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { NormalizedOrderRow } from "@/lib/external-order";
import { normalizeOrderSource, normalizeOrderCategory } from "@/lib/orders/constants";
import {
  computeOrderAmount,
  findExactSourceOrder,
  findCrossSourceConflict,
  normalizeImportDate,
  resolveImportRefDate,
  upsertImportSourceRecord,
} from "@/lib/orders/import-commit";
import { resolveOrCreateOrganizationForImport } from "@/lib/orders/import-masterdata";
import { createCrmCustomerProfile } from "@/lib/crm/create-profile";
import { resolveEffectiveRepresentativeForOrg } from "@/lib/crm/customer-effective-representative";
import { transitionCrmStage } from "@/lib/crm/lifecycle";
import { resolveCustomerBusinessContext } from "@/lib/business/customer-context";
import { findActiveProfile } from "@/lib/crm/ids";
import { yuanToCents } from "@/lib/finance/money";
import {
  ROW_STATUS,
  DECISION_TYPE,
  DECISION_READY_STATUSES,
  PRE_DECISION_STATUSES,
  ROW_NON_TERMINAL_STATUSES,
  summarizeRows,
  type RowStatus,
} from "@/lib/orders/import-session";

type Tx = Prisma.TransactionClient;

// ─── 结构化错误 ──────────────────────────────────────────────────────────────
/** 404 形状错误：资源不存在或不属于当前用户（不泄露存在性）。 */
export class ImportRowNotFoundError extends Error {
  constructor(message = "导入行不存在或无权访问") {
    super(message);
    this.name = "ImportRowNotFoundError";
  }
}
/** 422 形状错误：数据/校验问题。 */
export class ImportRowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportRowValidationError";
  }
}
/** 409 形状错误：version / state 冲突，携带可安全展示的最新状态。 */
export class ImportRowConflictError extends Error {
  readonly currentVersion: number;
  readonly currentStatus: string;
  readonly currentProposalId: string | null;
  readonly retryable: boolean;
  readonly code: string;
  readonly claimStartedAt: Date | null;
  constructor(params: {
    code: string;
    message: string;
    currentVersion: number;
    currentStatus: string;
    currentProposalId?: string | null;
    retryable?: boolean;
    claimStartedAt?: Date | null;
  }) {
    super(params.message);
    this.name = "ImportRowConflictError";
    this.code = params.code;
    this.currentVersion = params.currentVersion;
    this.currentStatus = params.currentStatus;
    this.currentProposalId = params.currentProposalId ?? null;
    this.retryable = params.retryable ?? false;
    this.claimStartedAt = params.claimStartedAt ?? null;
  }
}

// ─── 内部辅助：归属校验 ──────────────────────────────────────────────────────
async function assertSessionOwnedBy(
  sessionId: string,
  userId: string,
  db: typeof prisma | Tx = prisma,
): Promise<{ id: string; status: string; source: string; sourceRemark: string | null; category: string }> {
  const sess = await db.orderImportSession.findUnique({
    where: { id: sessionId },
    select: { id: true, status: true, source: true, sourceRemark: true, category: true, createdById: true },
  });
  if (!sess || sess.createdById !== userId) throw new ImportRowNotFoundError();
  return sess;
}

function parseNormalizedPayload(raw: string | null | undefined): NormalizedOrderRow | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as NormalizedOrderRow;
  } catch {
    return null;
  }
}

// ─── 内部辅助：客户/代表解析（从旧 commit route 抽取，行为保持一致） ─────────
// CONFIRMED_EXISTING 走 findActiveProfile + resolveCustomerBusinessContext；
// CONFIRMED_CREATE 走 createCrmCustomerProfile + resolveOrCreateOrganizationForImport。
// 代表只能由 effective resolver 得到（§9.4 / §5.2），绝不信任前端。
// 单行服务**不做同批去重**（§9.6 同批折叠只在旧整批路径里成立）——
// 单行提交时若发现同来源精确重复，由 findExactSourceOrder 走 UPDATE 路径处理。

interface ResolvedRowCustomer {
  profileId: string;
  representativeId: string | null;
  repSource: string;
  buyerOrgId: string | null;
  reason: string;
  /** CONFIRMED_CREATE 时为 true，表示本事务内新建了 Profile。 */
  createdProfile: boolean;
}

const REASON_BY_DECISION: Record<string, string> = {
  [DECISION_TYPE.USE_SUGGESTION]: "import_confirmed_auto",
  [DECISION_TYPE.PICK_EXISTING]: "import_confirmed_manual_pick",
  [DECISION_TYPE.CREATE_NEW]: "import_confirmed_create",
};

export interface RowSnapshot {
  id: string;
  rowNo: number;
  reviewStatus: string;
  decisionType: string | null;
  confirmedProfileId: string | null;
  createCustomerDraftJson: string | null;
  normalizedPayloadJson: string;
  suggestedScore: number | null;
}

/**
 * 解析单行最终的客户 + 代表 + 机构。extracted 自旧 commit route step 2/3，
 * 行为完全一致：CONFIRMED_EXISTING 校验活动 Profile 并解析 effective rep（含 org fallback）；
 * CONFIRMED_CREATE 创建 Profile-only 客户，机构优先已选 organizationId 再用 organizationName。
 * repSource 为 NONE 时抛 RepresentativeMissingError，由调用方决定如何回写行状态。
 */
export class RepresentativeMissingError extends Error {
  constructor(public profileId: string | null) {
    super("representative_missing");
    this.name = "RepresentativeMissingError";
  }
}

/** 页面 commit 路由与 commitImportRow 共享的客户/代表解析（导出供页面循环复用）。 */
export async function resolveRowCustomer(
  tx: Tx,
  row: RowSnapshot,
  normalizedSource: string,
): Promise<ResolvedRowCustomer> {
  void normalizedSource; // 保留入参以便与旧签名对称；单行路径不依赖 source 做客户解析
  if (row.reviewStatus === ROW_STATUS.CONFIRMED_EXISTING) {
    if (!row.confirmedProfileId) {
      throw new ImportRowValidationError(`行 #${row.rowNo + 1} 缺少确认客户（confirmedProfileId 必填）`);
    }
    const ref = await findActiveProfile(row.confirmedProfileId, tx);
    if (!ref) {
      throw new ImportRowValidationError(`行 #${row.rowNo + 1} 的确认客户不存在或已删除/归档`);
    }
    const ctx = await resolveCustomerBusinessContext(ref.profileId, tx);
    let repId = ctx.representativeId;
    let repSource: string = repId ? "RESOLVED" : "NONE";
    // Profile-only / owner 未映射 rep 时，回退到 org effective（与 CREATE 路径同口径）。
    if (!repId && ctx.organizationId) {
      const effective = await resolveEffectiveRepresentativeForOrg(ctx.organizationId, null, tx);
      repId = effective.representativeId;
      repSource = effective.source;
    }
    if (!repId || repSource === "NONE") throw new RepresentativeMissingError(ref.profileId);
    return {
      profileId: ref.profileId,
      representativeId: repId,
      repSource,
      buyerOrgId: ctx.organizationId,
      reason: REASON_BY_DECISION[row.decisionType ?? ""] ?? "import_confirmed_manual_pick",
      createdProfile: false,
    };
  }

  // CONFIRMED_CREATE
  let draft: Record<string, string | null> = {};
  try {
    draft = JSON.parse(row.createCustomerDraftJson || "{}") as Record<string, string | null>;
  } catch {
    draft = {};
  }
  const name = (draft.name ?? "").trim();
  if (!name) throw new ImportRowValidationError(`行 #${row.rowNo + 1} 新建客户缺少名称`);
  const mini = (draft.miniProgramId ?? "").trim();
  const wechat = (draft.wechat ?? "").trim();
  const phone = (draft.phone ?? "").trim();

  // 解析机构：优先已选 organizationId，否则用 organizationName 解析/创建。
  let orgId = (draft.organizationId ?? "").trim() || null;
  if (!orgId) {
    const orgName = (draft.organizationName ?? "").trim();
    if (orgName) {
      const org = await resolveOrCreateOrganizationForImport(orgName, "CREATE_IF_MISSING", tx);
      orgId = org.organizationId;
    }
  }
  if (!orgId) throw new ImportRowValidationError(`行 #${row.rowNo + 1} 新建客户机构无法解析（U2）`);

  const organizationName = (draft.organizationName ?? "").trim() || null;
  const address = (draft.address ?? "").trim() || null;
  const effective = await resolveEffectiveRepresentativeForOrg(orgId, null, tx);

  const { id: profileId } = await createCrmCustomerProfile(
    {
      name,
      wechat: wechat || null,
      phone: phone || null,
      principal: phone || null,
      miniProgramId: mini || null,
      address,
      organizationId: orgId,
      organization: organizationName,
      organizationRawInput: organizationName,
      ownerUserId: effective.ownerUserId ?? undefined,
      assignmentStatus:
        effective.source === "SITE_BINDING" || effective.source === "ORG_BINDING" ? "ASSIGNED" : "UNASSIGNED",
      sourceHint: "ORDER_IMPORT",
    },
    tx,
  );

  if (!effective.representativeId || effective.source === "NONE") {
    throw new RepresentativeMissingError(profileId);
  }

  return {
    profileId,
    representativeId: effective.representativeId,
    repSource: effective.source,
    buyerOrgId: orgId,
    reason: "import_confirmed_create",
    createdProfile: true,
  };
}

// ─── Deliverable 2 核心共享函数：writeOrderForRow ─────────────────────────────
/**
 * §5.5 单行事务内的正式订单写入核心。commitImportRow（PROPOSED→IMPORTING claim 之后）
 * 与页面 commit 路由（CONFIRMED_*→IMPORTING claim 之后）都调用本函数，
 * 保证全仓库只有这一处 create/update 订单逻辑。
 *
 * UPDATE 白名单（§5.4）：只更新来源相关字段（sourcePlatform / sourceRemark / merchantOrderNo /
 * 买方快照 / orderedAt / confirmedAt / title / 本来源 OrderLine / OrderSourceRecord.rawJson）。
 * 不得覆盖：人工修正的 profileId（仅当当前为 null 才写）、项目关联、发票/回款/成本、
 * financeTreatment / financeAmountOverride、deleted/archived（恢复已删除订单保留旧行为，
 * 但视为高风险，后续应由独立 action 处理）、非本来源订单行。
 *
 * 返回 created=true 表示新建订单，false 表示更新（含「既有合并目标订单，跳过更新」语义）。
 */
export interface WriteOrderForRowContext {
  row: RowSnapshot;
  customer: ResolvedRowCustomer;
  parsed: NormalizedOrderRow;
  normalizedSource: string;
  sourceRemark: string | null;
  category: string;
  userId: string;
  /** Required for T2.5 CREATE via prepareCreateOrderForActor (ADMIN-only). */
  actorRole: string;
  actorName?: string | null;
  actorEmail?: string | null;
}

export interface WriteOrderForRowResult {
  orderId: string;
  created: boolean;
  /** true 表示既有订单已是合并目标，本次跳过更新（对应旧 route 的 skippedCount 分支）。 */
  skippedMergeTarget: boolean;
}

export async function writeOrderForRow(
  tx: Tx,
  ctx: WriteOrderForRowContext,
): Promise<WriteOrderForRowResult> {
  const { row, customer, parsed, normalizedSource, sourceRemark, category, userId } = ctx;
  const orderCategory = normalizeOrderCategory(category);
  const orderAt = normalizeImportDate(parsed.orderAt);
  const paidAt = normalizeImportDate(parsed.paidAt);
  const refDate = resolveImportRefDate(orderAt, paidAt);
  const totalAmount = yuanToCents(computeOrderAmount(parsed));
  const matchScore = row.decisionType === DECISION_TYPE.USE_SUGGESTION ? row.suggestedScore : null;

  // §5.3 精确来源幂等：决定 CREATE / UPDATE
  const exact = await findExactSourceOrder(tx, normalizedSource, parsed.externalOrderNo);

  if (exact?.orderId) {
    // 既有订单已是合并目标：保留旧行为——跳过更新，标记 IMPORTED + finalOrderId。
    if (exact.order && exact.order.mergeTargets.length > 0) {
      await tx.orderImportRow.update({
        where: { id: row.id },
        data: {
          reviewStatus: ROW_STATUS.IMPORTED,
          finalOrderId: exact.orderId,
          finalError: "既存合并目标订单，跳过更新",
        },
      });
      return { orderId: exact.orderId, created: false, skippedMergeTarget: true };
    }

    const isDeleted = exact.order?.deleted;
    // §5.4 UPDATE 白名单：仅来源相关字段。正式客户关系（profile/org/rep）
    // 仅在既有订单对应字段为空时回填；已有非空关系与导入决策冲突时 fail-closed。
    const existing = await tx.order.findUnique({
      where: { id: exact.orderId },
      select: {
        profileId: true,
        representativeId: true,
        buyerOrganizationId: true,
        buyerNameSnapshot: true,
        buyerPhoneSnapshot: true,
        buyerWechatSnapshot: true,
        buyerOrgNameSnapshot: true,
        buyerAddressSnapshot: true,
        buyerMiniProgramIdSnapshot: true,
      },
    });
    if (!existing) {
      throw new ImportRowNotFoundError("精确来源命中的订单不存在");
    }

    const conflictField = (
      field: "profileId" | "representativeId" | "buyerOrganizationId",
      existingValue: string | null,
      incomingValue: string | null,
    ) => {
      if (existingValue && incomingValue && existingValue !== incomingValue) {
        throw new ImportRowConflictError({
          code: "ORDER_CUSTOMER_RELATION_CONFLICT",
          message: `既有订单 ${field} 与导入决策不一致，禁止自动改写正式客户关系`,
          currentVersion: 0,
          currentStatus: row.reviewStatus,
          retryable: false,
        });
      }
    };
    conflictField("profileId", existing.profileId, customer.profileId);
    conflictField("representativeId", existing.representativeId, customer.representativeId);
    conflictField("buyerOrganizationId", existing.buyerOrganizationId, customer.buyerOrgId);

    // Formal buyer snapshots: CRM-only. File/parsed text never writes here.
    // CRM empty → keep existing formal snapshot (do not null-out or adopt import text).
    const profileForSnap = existing.profileId ?? customer.profileId;
    const snapCtx = profileForSnap
      ? await resolveCustomerBusinessContext(profileForSnap, tx)
      : null;
    const crmOrKeep = (crm: string | null | undefined, keep: string | null) => {
      const t = typeof crm === "string" ? crm.trim() : "";
      return t || keep;
    };

    await tx.order.update({
      where: { id: exact.orderId },
      data: {
        totalAmount: totalAmount > 0 ? totalAmount : undefined,
        category: orderCategory,
        sourceRemark: sourceRemark ?? undefined,
        buyerNameSnapshot: crmOrKeep(snapCtx?.clientName, existing.buyerNameSnapshot),
        buyerPhoneSnapshot: crmOrKeep(snapCtx?.buyerPhone, existing.buyerPhoneSnapshot),
        buyerWechatSnapshot: crmOrKeep(snapCtx?.buyerWechat, existing.buyerWechatSnapshot),
        buyerOrgNameSnapshot: crmOrKeep(snapCtx?.organizationName, existing.buyerOrgNameSnapshot),
        buyerAddressSnapshot: crmOrKeep(snapCtx?.buyerAddress, existing.buyerAddressSnapshot),
        // Keep existing mini-program snapshot; import raw stays in source record.
        buyerMiniProgramIdSnapshot: existing.buyerMiniProgramIdSnapshot,
        orderedAt: orderAt ?? undefined,
        confirmedAt: paidAt ?? undefined,
        title: parsed.productNamesRaw ?? undefined,
        // Only backfill empty formal relations — never overwrite non-null FKs.
        profileId: existing.profileId ?? customer.profileId,
        representativeId: existing.representativeId ?? customer.representativeId,
        buyerOrganizationId: existing.buyerOrganizationId ?? customer.buyerOrgId ?? undefined,
        customerMatchStatus: "MATCHED",
        customerMatchScore: matchScore,
        customerMatchReason: customer.reason,
        ...(isDeleted
          ? { deleted: false, deletedAt: null, archived: false, financeTreatment: "AUTO" }
          : {}),
      },
    });
    await tx.orderLine.updateMany({
      where: { orderId: exact.orderId },
      data: { category: orderCategory },
    });
    await upsertImportSourceRecord(tx, {
      orderId: exact.orderId,
      source: normalizedSource,
      sourceRemark: sourceRemark ?? undefined,
      platform: parsed.platform || ctx.category,
      externalOrderNo: parsed.externalOrderNo,
      merchantOrderNo: parsed.merchantOrderNo,
      rawJson: JSON.stringify(parsed),
    });
    return { orderId: exact.orderId, created: false, skippedMergeTarget: false };
  }

  // 新建订单（§5.5 step 5 CREATE 分支）—— T2.5：走与 Web/Agent create 相同的
  // prepare + createOrderWithProject（经 createPreparedOrderInTx），再写 OrderSourceRecord。
  if (!customer.profileId) {
    throw new ImportRowValidationError("导入行缺少客户档案，无法创建订单");
  }
  const { prepareCreateOrderForActor } = await import("@/lib/orders/application/prepare-create-order");
  const { createPreparedOrderInTx } = await import("@/lib/orders/application/create-order");
  const { ApplicationError } = await import("@/lib/application/errors");
  const itemName = parsed.productNamesRaw || parsed.externalOrderNo || "导入订单";

  const actor = {
    userId,
    role: ctx.actorRole,
    name: ctx.actorName ?? null,
    email: ctx.actorEmail ?? null,
  };
  let prepared;
  try {
    prepared = await prepareCreateOrderForActor(actor, {
      title: parsed.productNamesRaw || `${parsed.receiverName || "未知"}的订单`,
      profileId: customer.profileId,
      category: orderCategory,
      status: "DELIVERED",
      orderedAt: orderAt,
      confirmedAt: paidAt,
      deliveredAt: paidAt ?? new Date(),
      moneyUnit: "cents",
      totalAmount,
      lines: [
        {
          itemName: String(itemName).slice(0, 200),
          amount: totalAmount,
        },
      ],
      source: normalizedSource,
      sourcePlatform: parsed.platform || ctx.category,
      sourceRemark,
      externalOrderNo: parsed.externalOrderNo,
      merchantOrderNo: parsed.merchantOrderNo,
      orderNoRefDate: refDate,
      // Formal buyer snapshots come only from CRM in prepare/writer.
      // Import file text stays in OrderSourceRecord.rawJson below.
      customerMatchStatus: "MATCHED",
      customerMatchScore: matchScore,
      customerMatchReason: customer.reason,
    });
  } catch (err) {
    if (err instanceof ApplicationError) {
      throw new ImportRowValidationError(err.message);
    }
    throw err;
  }

  // Import CREATE never generates/links projects inside writeOrderForRow.
  prepared.payload.projectAction = null;
  prepared.payload.projectId = null;

  // 对齐 create-order.ts L113-120：经 Agent 导入创建的新订单绑定 technicalOwner。
  // 否则这些新订单创建后任何 actor 都无法经 Agent 再写（technical owner gate fail-closed）。
  // 注意：仅 ADMIN/USER 可经 Agent 导入（canUseAgentImport），RM/REP 早在 availability 被拦。
  if (actor.role === "ADMIN" || actor.role === "USER") {
    prepared.payload.technicalOwnerUserId = actor.userId;
  }

  const created = await createPreparedOrderInTx(tx, prepared);
  await upsertImportSourceRecord(tx, {
    orderId: created.order.id,
    source: normalizedSource,
    sourceRemark: sourceRemark ?? undefined,
    platform: parsed.platform || ctx.category,
    externalOrderNo: parsed.externalOrderNo,
    merchantOrderNo: parsed.merchantOrderNo,
    rawJson: JSON.stringify(parsed),
  });
  return { orderId: created.order.id, created: true, skippedMergeTarget: false };
}

// ─── Deliverable 2.1: analyzeImportRow（只读） ───────────────────────────────
export type ImportRowPlan = "CREATE" | "UPDATE" | "CONFLICT";

export interface ImportRowFieldDiff {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface ImportRowAnalysis {
  rowId: string;
  rowNo: number;
  rawFields: Record<string, unknown> | null;
  normalizedFields: NormalizedOrderRow | null;
  provenance: Record<string, string> | null;
  missingFields: string[];
  /** 客户候选内部信息（来源记录回算 / suggested 字段）。 */
  candidates: Array<{ profileId: string; reason: string | null }>;
  /** 精确来源重复命中（→ UPDATE）。 */
  exactDuplicate: { orderId: string; deleted: boolean } | null;
  /** 跨来源冲突命中（→ CONFLICT）。 */
  crossSourceConflict: Array<{ orderId: string; source: string; sourceRecordId: string }>;
  plan: ImportRowPlan;
  updateDiff: ImportRowFieldDiff[] | null;
  version: number;
  progress: {
    total: number;
    imported: number;
    confirmed: number;
    unresolved: number;
  };
}

export interface AnalyzeImportRowParams {
  sessionId: string;
  rowId?: string;
  userId: string;
}

/**
 * §5.1 只读领域分析函数。不写任何数据，也不作为独立 HTTP API 暴露
 * （orders.get_import_row action 内部调用本函数）。
 */
export async function analyzeImportRow(
  params: AnalyzeImportRowParams,
  db: typeof prisma | Tx = prisma,
): Promise<ImportRowAnalysis> {
  const sess = await assertSessionOwnedBy(params.sessionId, params.userId, db);
  const normalizedSource = normalizeOrderSource(sess.source);

  // 选择目标行：指定 rowId 用之，否则取第一条未完成行（按 rowNo 升序）。
  let row: {
    id: string;
    rowNo: number;
    reviewStatus: string;
    normalizedPayloadJson: string;
    fieldProvenanceJson: string | null;
    version: number;
    suggestedProfileId: string | null;
    suggestedReason: string | null;
    confirmedProfileId: string | null;
    decisionType: string | null;
  };
  if (params.rowId) {
    const r = await db.orderImportRow.findUnique({
      where: { id: params.rowId },
      select: {
        id: true, rowNo: true, reviewStatus: true, normalizedPayloadJson: true,
        fieldProvenanceJson: true, version: true, suggestedProfileId: true, suggestedReason: true,
        confirmedProfileId: true, decisionType: true, sessionId: true,
      },
    });
    if (!r || r.sessionId !== params.sessionId) throw new ImportRowNotFoundError();
    row = r;
  } else {
    const r = await db.orderImportRow.findFirst({
      where: {
        sessionId: params.sessionId,
        reviewStatus: { in: [...PRE_DECISION_STATUSES, ...DECISION_READY_STATUSES] as string[] },
      },
      orderBy: { rowNo: "asc" },
      select: {
        id: true, rowNo: true, reviewStatus: true, normalizedPayloadJson: true,
        fieldProvenanceJson: true, version: true, suggestedProfileId: true, suggestedReason: true,
        confirmedProfileId: true, decisionType: true,
      },
    });
    if (!r) throw new ImportRowNotFoundError("没有待处理的导入行");
    row = r;
  }

  const parsed = parseNormalizedPayload(row.normalizedPayloadJson);
  let provenance: Record<string, string> | null = null;
  if (row.fieldProvenanceJson) {
    try {
      provenance = JSON.parse(row.fieldProvenanceJson) as Record<string, string>;
    } catch {
      provenance = null;
    }
  }

  // 硬必填检查（§5.2）
  const missingFields: string[] = [];
  if (parsed) {
    if (!parsed.externalOrderNo) missingFields.push("externalOrderNo");
    if (!parsed.productNamesRaw) missingFields.push("title");
    if (computeOrderAmount(parsed) < 0) missingFields.push("amount");
  } else {
    missingFields.push("normalizedPayload");
  }
  // profileId / 完整 createCustomerDraft 在 prepare 阶段再严格校验；此处只报告候选。
  const candidates: Array<{ profileId: string; reason: string | null }> = [];
  if (row.suggestedProfileId) {
    candidates.push({ profileId: row.suggestedProfileId, reason: row.suggestedReason });
  }

  // 精确来源幂等 & 跨来源冲突（§5.3）
  let plan: ImportRowPlan = "CREATE";
  let exactDuplicate: ImportRowAnalysis["exactDuplicate"] = null;
  let crossSourceConflict: ImportRowAnalysis["crossSourceConflict"] = [];
  let updateDiff: ImportRowFieldDiff[] | null = null;

  if (parsed?.externalOrderNo) {
    const exact = await findExactSourceOrder(db, normalizedSource, parsed.externalOrderNo);
    if (exact) {
      plan = "UPDATE";
      exactDuplicate = { orderId: exact.orderId, deleted: exact.order?.deleted ?? false };
      // §5.4 diff：仅白名单字段
      const existing = await db.order.findUnique({
        where: { id: exact.orderId },
        select: {
          title: true, sourcePlatform: true, merchantOrderNo: true, orderedAt: true, confirmedAt: true,
        },
      });
      if (existing) {
        const diffs: ImportRowFieldDiff[] = [];
        if ((parsed.productNamesRaw ?? null) !== existing.title) {
          diffs.push({ field: "title", oldValue: existing.title, newValue: parsed.productNamesRaw ?? null });
        }
        if ((parsed.merchantOrderNo ?? null) !== existing.merchantOrderNo) {
          diffs.push({ field: "merchantOrderNo", oldValue: existing.merchantOrderNo, newValue: parsed.merchantOrderNo ?? null });
        }
        updateDiff = diffs;
      }
    } else {
      const conflicts = await findCrossSourceConflict(db, normalizedSource, parsed.externalOrderNo);
      // 复用 import-commit 的 findCrossSourceConflict
      crossSourceConflict = conflicts.map((c) => ({
        orderId: c.orderId, source: c.source, sourceRecordId: c.sourceRecordId,
      }));
      if (crossSourceConflict.length > 0) plan = "CONFLICT";
    }
  }

  // 进度统计
  const grouped = await db.orderImportRow.groupBy({
    by: ["reviewStatus"],
    where: { sessionId: params.sessionId },
    _count: { _all: true },
  });
  const summary = summarizeRows(
    grouped.flatMap((g) => Array.from({ length: g._count._all }, () => ({ reviewStatus: g.reviewStatus }))),
  );

  return {
    rowId: row.id,
    rowNo: row.rowNo,
    rawFields: parsed ? safeJsonParse(parsed.rawJson) : null,
    normalizedFields: parsed,
    provenance,
    missingFields,
    candidates,
    exactDuplicate,
    crossSourceConflict,
    plan,
    updateDiff,
    version: row.version,
    progress: {
      total: summary.rowCount,
      imported: summary.imported,
      confirmed: summary.confirmed,
      unresolved: summary.unresolved,
    },
  };
}

// findCrossSourceConflict 用于 analyze（已在顶部 import）

function safeJsonParse(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── Deliverable 2.2: prepareImportRow（持久化客户决策） ──────────────────────
export interface PrepareImportRowParams {
  sessionId: string;
  rowId: string;
  userId: string;
  decision: {
    type: "USE_SUGGESTION" | "PICK_EXISTING" | "CREATE_NEW";
    profileId?: string | null;
    createCustomerDraft?: Record<string, string | null> | null;
  };
  expectedVersion: number;
}

export interface PreparedImportRow {
  rowId: string;
  reviewStatus: string;
  decisionType: string;
  confirmedProfileId: string | null;
  version: number;
}

/**
 * §5 / §4.3.1 持久化客户决策。把行从 PRE_DECISION 态迁移到 CONFIRMED_EXISTING / CONFIRMED_CREATE，
 * 或在已 CONFIRMED_* 时允许覆盖决策（用户改主意）。version++ 通过乐观 updateMany 实现，
 * 影响行数 0 → 抛 ImportRowConflictError(ROW_VERSION_CONFLICT)。
 */
export async function prepareImportRow(
  params: PrepareImportRowParams,
  db: typeof prisma = prisma,
): Promise<PreparedImportRow> {
  await assertSessionOwnedBy(params.sessionId, params.userId, db);

  const row = await db.orderImportRow.findUnique({
    where: { id: params.rowId },
    select: { id: true, sessionId: true, reviewStatus: true, version: true },
  });
  if (!row || row.sessionId !== params.sessionId) throw new ImportRowNotFoundError();

  const allowedSourceStatuses = new Set<string>([
    ...PRE_DECISION_STATUSES,
    ...DECISION_READY_STATUSES,
  ] as string[]);
  if (!allowedSourceStatuses.has(row.reviewStatus)) {
    throw new ImportRowConflictError({
      code: "ROW_STATE_CONFLICT",
      message: `行状态为 ${row.reviewStatus}，无法再次确认`,
      currentVersion: row.version,
      currentStatus: row.reviewStatus,
      retryable: false,
    });
  }

  let nextStatus: string;
  const decisionType: string = params.decision.type;
  let confirmedProfileId: string | null = null;
  let createCustomerDraftJson: string | null = null;

  if (params.decision.type === DECISION_TYPE.CREATE_NEW) {
    nextStatus = ROW_STATUS.CONFIRMED_CREATE;
    createCustomerDraftJson = JSON.stringify(params.decision.createCustomerDraft ?? {});
  } else {
    // USE_SUGGESTION / PICK_EXISTING：都需要 profileId
    nextStatus = ROW_STATUS.CONFIRMED_EXISTING;
    confirmedProfileId = (params.decision.profileId ?? "").trim() || null;
    if (!confirmedProfileId) {
      throw new ImportRowValidationError(`${params.decision.type} 决策缺少 profileId`);
    }
  }

  const updated = await db.orderImportRow.updateMany({
    where: { id: params.rowId, version: params.expectedVersion },
    data: {
      reviewStatus: nextStatus,
      decisionType,
      confirmedProfileId,
      createCustomerDraftJson,
      finalError: null,
      version: { increment: 1 },
    },
  });
  if (updated.count === 0) {
    const fresh = await db.orderImportRow.findUnique({
      where: { id: params.rowId },
      select: { version: true, reviewStatus: true, proposalId: true },
    });
    throw new ImportRowConflictError({
      code: "ROW_VERSION_CONFLICT",
      message: "行版本已过期，请刷新后重试",
      currentVersion: fresh?.version ?? params.expectedVersion,
      currentStatus: fresh?.reviewStatus ?? row.reviewStatus,
      currentProposalId: fresh?.proposalId ?? null,
      retryable: true,
    });
  }

  return {
    rowId: params.rowId,
    reviewStatus: nextStatus,
    decisionType,
    confirmedProfileId,
    version: params.expectedVersion + 1,
  };
}

// ─── Deliverable 2.3: commitImportRow（单行事务，PROPOSED→IMPORTING→IMPORTED） ─
export type ImportRowCommitResult =
  | { kind: "COMMITTED"; finalOrderId: string; created: boolean }
  | { kind: "IDEMPOTENT_SUCCESS"; finalOrderId: string }
  | {
      kind: "CONFLICT";
      code: "ROW_VERSION_CONFLICT" | "ROW_ALREADY_IMPORTING" | "ROW_STATE_CONFLICT";
      currentVersion: number;
      currentStatus: string;
      currentProposalId: string | null;
      retryable: boolean;
      claimStartedAt: Date | null;
    };

export interface CommitImportRowParams {
  sessionId: string;
  rowId: string;
  userId: string;
  expectedRowVersion: number;
  proposalId: string;
  /** 可选 claim 标识（Agent run id），用于诊断卡住的 IMPORTING 行。 */
  claimRunId?: string | null;
  /** Actor role/name/email for T2.5 create prepare (ADMIN-only). */
  actorRole: string;
  actorName?: string | null;
  actorEmail?: string | null;
}

/**
 * §5.5 单行事务落库。Agent proposal 确认路径的执行核心。
 *
 * 单事务步骤：
 *   1. 原子 claim：PROPOSED + version + proposalId → IMPORTING
 *   2. claim count 0 → §5.5.1 幂等/冲突判定（只读重查）
 *   3. 重读 session+row，重验归属与 proposal
 *   4. 重跑客户/代表/机构/金额硬校验（resolveRowCustomer）
 *   5. writeOrderForRow 创建/白名单更新订单
 *   6. 行标记 IMPORTED，finalOrderId 写入，version++，清 claim 字段
 *
 * 事务外：best-effort transitionCrmStage(ORDER_CONFIRMED)，失败仅日志。
 */
export async function commitImportRow(
  params: CommitImportRowParams,
  db: typeof prisma = prisma,
): Promise<ImportRowCommitResult> {
  const now = new Date();
  const claimRunId = params.claimRunId ?? null;

  // 单事务
  const out = await db.$transaction(async (tx) => {
    // 1. 原子 claim
    const claimed = await tx.orderImportRow.updateMany({
      where: {
        id: params.rowId,
        sessionId: params.sessionId,
        version: params.expectedRowVersion,
        reviewStatus: ROW_STATUS.PROPOSED,
        proposalId: params.proposalId,
      },
      data: {
        reviewStatus: ROW_STATUS.IMPORTING,
        claimStartedAt: now,
        claimRunId,
      },
    });

    if (claimed.count === 0) {
      // 2. §5.5.1 幂等/冲突判定（事务内只读重查）
      const fresh = await tx.orderImportRow.findUnique({
        where: { id: params.rowId },
        select: {
          reviewStatus: true, version: true, proposalId: true, claimStartedAt: true,
          finalOrderId: true, sessionId: true,
        },
      });
      if (!fresh || fresh.sessionId !== params.sessionId) {
        throw new ImportRowNotFoundError();
      }
      if (
        fresh.reviewStatus === ROW_STATUS.IMPORTED &&
        fresh.proposalId === params.proposalId &&
        fresh.finalOrderId
      ) {
        return {
          kind: "IDEMPOTENT_SUCCESS" as const,
          finalOrderId: fresh.finalOrderId,
        };
      }
      if (
        fresh.reviewStatus === ROW_STATUS.PROPOSED &&
        (fresh.version !== params.expectedRowVersion || fresh.proposalId !== params.proposalId)
      ) {
        throw new ImportRowConflictError({
          code: "ROW_VERSION_CONFLICT",
          message: "行版本或 proposal 已变更，请刷新后重试",
          currentVersion: fresh.version,
          currentStatus: fresh.reviewStatus,
          currentProposalId: fresh.proposalId,
          retryable: true,
        });
      }
      if (fresh.reviewStatus === ROW_STATUS.IMPORTING) {
        throw new ImportRowConflictError({
          code: "ROW_ALREADY_IMPORTING",
          message: "该行正在导入中，请稍后刷新",
          currentVersion: fresh.version,
          currentStatus: fresh.reviewStatus,
          currentProposalId: fresh.proposalId,
          retryable: false,
          claimStartedAt: fresh.claimStartedAt,
        });
      }
      throw new ImportRowConflictError({
        code: "ROW_STATE_CONFLICT",
        message: `行状态为 ${fresh.reviewStatus}，无法导入`,
        currentVersion: fresh.version,
        currentStatus: fresh.reviewStatus,
        currentProposalId: fresh.proposalId,
        retryable: false,
      });
    }

    // 3. 重读 session + row，重验归属与 proposal
    const sess = await assertSessionOwnedBy(params.sessionId, params.userId, tx);
    const row = await tx.orderImportRow.findUnique({
      where: { id: params.rowId },
      select: {
        id: true, rowNo: true, reviewStatus: true, decisionType: true,
        confirmedProfileId: true, createCustomerDraftJson: true,
        normalizedPayloadJson: true, suggestedScore: true, version: true, proposalId: true,
      },
    });
    if (!row) throw new ImportRowNotFoundError();
    if (row.proposalId !== params.proposalId) {
      throw new ImportRowConflictError({
        code: "ROW_VERSION_CONFLICT",
        message: "proposal 已变更，请刷新后重试",
        currentVersion: row.version,
        currentStatus: row.reviewStatus,
        currentProposalId: row.proposalId,
        retryable: true,
      });
    }

    const parsed = parseNormalizedPayload(row.normalizedPayloadJson);
    if (!parsed) {
      throw new ImportRowValidationError(`行 #${row.rowNo + 1} 标准化数据损坏`);
    }

    // 4. 重跑客户/代表/机构/金额硬校验
    const normalizedSource = normalizeOrderSource(sess.source);
    const customer = await resolveRowCustomer(tx, row, normalizedSource);
    if (computeOrderAmount(parsed) < 0) {
      throw new ImportRowValidationError(`行 #${row.rowNo + 1} 金额为负`);
    }

    // 5. writeOrderForRow 创建/更新订单
    const result = await writeOrderForRow(tx, {
      row,
      customer,
      parsed,
      normalizedSource,
      sourceRemark: sess.sourceRemark,
      category: sess.category,
      userId: params.userId,
      actorRole: params.actorRole,
      actorName: params.actorName,
      actorEmail: params.actorEmail,
    });

    // 6. 行标记 IMPORTED（writeOrderForRow 已更新合并目标分支；这里覆盖非跳过分支）
    if (!result.skippedMergeTarget) {
      await tx.orderImportRow.update({
        where: { id: params.rowId },
        data: {
          reviewStatus: ROW_STATUS.IMPORTED,
          finalOrderId: result.orderId,
          finalError: null,
          claimStartedAt: null,
          claimRunId: null,
          version: { increment: 1 },
        },
      });
    } else {
      // 合并目标分支：writeOrderForRow 已写 IMPORTED+finalOrderId，这里只清 claim 字段。
      await tx.orderImportRow.update({
        where: { id: params.rowId },
        data: { claimStartedAt: null, claimRunId: null, version: { increment: 1 } },
      });
    }

    return {
      kind: "COMMITTED" as const,
      finalOrderId: result.orderId,
      created: result.created,
      _profileId: customer.profileId,
    };
  });

  // 事务外 best-effort：CRM 阶段推进（ORDER_CONFIRMED）
  if (out.kind === "COMMITTED") {
    await transitionCrmStage(out._profileId, {
      type: "ORDER_CONFIRMED",
      orderId: out.finalOrderId,
    }).catch((err) => {
      console.error(
        `[CRM][IMPORT_SINGLE_ROW] ORDER_CONFIRMED transition failed for ${out._profileId}:`,
        err,
      );
    });
  }

  if (out.kind === "IDEMPOTENT_SUCCESS") {
    return { kind: "IDEMPOTENT_SUCCESS", finalOrderId: out.finalOrderId };
  }
  return { kind: "COMMITTED", finalOrderId: out.finalOrderId, created: out.created };
}

// ─── Deliverable 2.4: skipImportRow ──────────────────────────────────────────
export interface SkipImportRowParams {
  sessionId: string;
  rowId: string;
  userId: string;
  expectedVersion: number;
  reason: string;
}

/**
 * §6.6 把非终态行标记 DROPPED，记录原状态 + 原因到 finalError。乐观 version++，
 * count 0 → ROW_VERSION_CONFLICT。
 */
export async function skipImportRow(
  params: SkipImportRowParams,
  db: typeof prisma = prisma,
): Promise<void> {
  await assertSessionOwnedBy(params.sessionId, params.userId, db);
  const reason = (params.reason ?? "").trim();
  if (!reason) throw new ImportRowValidationError("跳过原因不能为空");

  const row = await db.orderImportRow.findUnique({
    where: { id: params.rowId },
    select: { sessionId: true, reviewStatus: true, version: true },
  });
  if (!row || row.sessionId !== params.sessionId) throw new ImportRowNotFoundError();
  if (!ROW_NON_TERMINAL_STATUSES.includes(row.reviewStatus as RowStatus)) {
    throw new ImportRowConflictError({
      code: "ROW_STATE_CONFLICT",
      message: `行状态为 ${row.reviewStatus}，无法跳过`,
      currentVersion: row.version,
      currentStatus: row.reviewStatus,
      retryable: false,
    });
  }

  const updated = await db.orderImportRow.updateMany({
    where: { id: params.rowId, version: params.expectedVersion },
    data: {
      reviewStatus: ROW_STATUS.DROPPED,
      finalError: `已跳过：${reason}（原状态 ${row.reviewStatus}）`,
      version: { increment: 1 },
      // 清理可能残留的 proposal / claim 字段
      proposalId: null,
      claimStartedAt: null,
      claimRunId: null,
    },
  });
  if (updated.count === 0) {
    const fresh = await db.orderImportRow.findUnique({
      where: { id: params.rowId },
      select: { version: true, reviewStatus: true, proposalId: true },
    });
    throw new ImportRowConflictError({
      code: "ROW_VERSION_CONFLICT",
      message: "行版本已过期，请刷新后重试",
      currentVersion: fresh?.version ?? params.expectedVersion,
      currentStatus: fresh?.reviewStatus ?? row.reviewStatus,
      currentProposalId: fresh?.proposalId ?? null,
      retryable: true,
    });
  }
}
