import { Prisma } from "@prisma/client";
import { generateProjectNo } from "@/lib/project-number";
import { resolveCustomerBusinessContext, type CustomerBusinessContext } from "@/lib/business/customer-context";
import { findActiveProfile } from "@/lib/crm/ids";
import { linkOrderToProject, OrderProjectCustomerConflictError, OrderProjectMissingProfileError } from "@/lib/orders/link-project";
import { normalizeProjectType } from "@/lib/project-type";
import { ORDER_FINANCE_TREATMENT } from "@/lib/orders/constants";
import { yuanToCents } from "@/lib/finance/money";
import { isDepartment } from "@/lib/department";
import { ValidationError } from "@/lib/application/errors";

type TransactionClient = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export interface CreateOrderLineInput {
  itemName: string;
  spec?: string | null;
  unit?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
  amount: number;
  category?: string | null;
  sortOrder?: number;
  rawJson?: string | null;
  /** Phase 1：真实 ProductSku id（新业务必填）。 */
  productSkuId?: string | null;
  /** 成交时编号快照（服务端从 SKU 生成）。 */
  productCodeSnapshot?: string | null;
  skuCodeSnapshot?: string | null;
}

export interface CreateOrderPayload {
  title: string;
  description?: string | null;
  category?: string;
  status?: string;
  orderedAt?: Date | string | null;
  /** Profile-only：客户只接受 CrmCustomerProfile.id。 */
  profileId?: string | null;
  representativeId?: string | null;
  totalAmount?: number;
  financeTreatment?: string | null;
  financeNote?: string | null;
  buyerNameSnapshot?: string | null;
  buyerPhoneSnapshot?: string | null;
  buyerWechatSnapshot?: string | null;
  buyerOrgNameSnapshot?: string | null;
  buyerAddressSnapshot?: string | null;
  /**
   * 结构化购买方机构外键（§3.3）。仅接受可唯一验证的强来源（crmProfile.organizationId）。
   * 禁止按 buyerOrgNameSnapshot 名称猜测写入——名称匹配属于治理任务，不做订单创建兜底。
   */
  buyerOrganizationId?: string | null;
  /** 订单技术支持（展示/业务事实源）；生成项目时只复制该值作为初始字段。 */
  techSupport: string;
  lines?: CreateOrderLineInput[];
  createdById: string;
  source?: string;
  sourcePlatform?: string | null;
  sourceRemark?: string | null;
  externalOrderNo?: string | null;
  merchantOrderNo?: string | null;
  /** projectAction: GENERATE = 自动创建项目, LINK = 关联现有项目 */
  projectAction?: "GENERATE" | "LINK" | null;
  /** 当 projectAction=LINK 时，指定要关联的项目ID */
  projectId?: string | null;
  /** 当 projectAction=GENERATE 时，可选的项目草稿字段 */
  projectDraft?: Record<string, unknown>;
  /** 初始成本金额 */
  initialCost?: number | null;
  initialCostType?: string | null;
  initialCostRemark?: string | null;
  /** 订单号日期参考，用于历史导入等场景 */
  orderNoRefDate?: Date | null;
  /** Override confirmedAt (import paidAt); default: now when status=CONFIRMED. */
  confirmedAt?: Date | string | null;
  /** Optional delivery timestamp (import DELIVERED path). */
  deliveredAt?: Date | string | null;
  customerMatchStatus?: string | null;
  customerMatchScore?: number | null;
  customerMatchReason?: string | null;
  buyerMiniProgramIdSnapshot?: string | null;
  /**
   * 技术负责人（Phase E）。Agent channel 创建时同事务绑定为当前合格 actor；
   * Web channel 可由 ADMIN 在 UI 指派。null = 历史/未指派，Agent 写 fail-closed。
   */
  technicalOwnerUserId?: string | null;
  /**
   * 不可变部门归属快照（设计 §4.2）。
   * 调用方应显式传入；未提供时从 createdById 用户的 department 字段解析。
   */
  departmentSnapshot?: string | null;
}

export interface RepAssignedSnapshot {
  projectId: string;
  projectName: string;
  representativeId: string;
  representativeName: string;
  representativeEmail: string;
}

export interface CreateOrderResult {
  order: Awaited<ReturnType<TransactionClient["order"]["create"]>> & {
    lines?: Awaited<ReturnType<TransactionClient["orderLine"]["findMany"]>>;
    profile?: { id: string; name: string | null; customerCode: string | null } | null;
  };
  project?: Awaited<ReturnType<TransactionClient["project"]["create"]>> | null;
  repSnapshot?: RepAssignedSnapshot | null;
}

/**
 * Generate a unique orderNo with concurrency safety inside a transaction.
 */
async function generateOrderNo(
  tx: TransactionClient,
  prefix = "SO",
  refDate?: Date | null,
): Promise<string> {
  const date = refDate || new Date();
  const dateStr = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  const lastOrder = await tx.order.findFirst({
    where: { orderNo: { startsWith: `${prefix}-${dateStr}` } },
    orderBy: { orderNo: "desc" },
    select: { orderNo: true },
  });
  let seq = 1;
  if (lastOrder) {
    const parts = lastOrder.orderNo.split("-");
    seq = parseInt(parts[parts.length - 1] || "0", 10) + 1;
  }
  return `${prefix}-${dateStr}-${String(seq).padStart(4, "0")}`;
}

/**
 * Create an order with optional project generation/linking inside a transaction.
 *
 * This is the shared backend path used by both the API route and import scripts.
 * All project-related side effects (ProjectMember, OrderProjectLink, ActivityLog,
 * budget cost sync, CRM stage transition) are handled here.
 *
 * @param tx Prisma transaction client
 * @param payload Order creation payload
 * @returns CreateOrderResult with order and optional project/rep snapshot
 */
export async function createOrderWithProject(
  tx: TransactionClient,
  payload: CreateOrderPayload,
): Promise<CreateOrderResult> {
  const {
    title,
    description,
    category = "SERVICE",
    status = "DRAFT",
    orderedAt,
    profileId: profileIdInput,
    totalAmount = 0,
    financeTreatment,
    financeNote,
    buyerNameSnapshot,
    buyerPhoneSnapshot,
    buyerWechatSnapshot,
    buyerOrgNameSnapshot,
    buyerAddressSnapshot,
    techSupport,
    lines,
    createdById,
    source = "MANUAL",
    sourcePlatform,
    sourceRemark,
    externalOrderNo,
    merchantOrderNo,
    projectAction,
    projectId,
    projectDraft,
    initialCost,
    initialCostType,
    initialCostRemark,
    orderNoRefDate,
    confirmedAt: confirmedAtInput,
    deliveredAt: deliveredAtInput,
    customerMatchStatus: customerMatchStatusInput,
    customerMatchScore,
    customerMatchReason: customerMatchReasonInput,
    buyerMiniProgramIdSnapshot,
    technicalOwnerUserId,
    departmentSnapshot: departmentSnapshotInput,
  } = payload;

  // 部门归属快照解析（设计 §7.2）：调用方显式传入优先；否则从创建者用户记录取。
  // Fail-closed（设计 §6.1）：用户不存在或 department 非法时拒绝创建订单，
  // 不能静默落 FIELD_SALES 快照（会产生错误部门订单）。
  let resolvedDepartmentSnapshot = departmentSnapshotInput ?? null;
  if (!resolvedDepartmentSnapshot) {
    const creator = await tx.user.findUnique({
      where: { id: createdById },
      select: { department: true },
    });
    if (!creator || !isDepartment(creator.department)) {
      throw new ValidationError(
        `无法权威解析创建者 ${createdById} 的部门，拒绝创建订单（部门字段缺失或非法）`,
      );
    }
    resolvedDepartmentSnapshot = creator.department;
  } else if (!isDepartment(resolvedDepartmentSnapshot)) {
    throw new ValidationError(`非法部门快照值: ${resolvedDepartmentSnapshot}`);
  }

  // Intent-only: payload.representativeId / buyerOrganizationId are ignored for
  // formal FKs (re-resolved from in-tx CRM context below).
  void payload.representativeId;
  void payload.buyerOrganizationId;

  const orderCategory = category || "SERVICE";
  const orderStatus = status || "DRAFT";
  const lineItems = (lines || []).filter((l) => l.itemName?.trim());
  const computedAmount = lineItems.length > 0
    ? lineItems.reduce((s, l) => s + (Number(l.amount) || 0), 0)
    : Number(totalAmount) || 0;

  // Resolve authoritative CRM context inside the transaction.
  // Prepared payload may carry a profileId intent, but formal FKs
  // (profile / org / representative) must always come from a fresh in-tx
  // active profile + customerCtx — never from a stale prepare snapshot.
  let customerCtx: CustomerBusinessContext | null = null;
  let resolvedProfileId: string | null = null;
  let finalRepresentativeId: string | null = null;
  let effectiveBuyerOrganizationId: string | null = null;

  if (profileIdInput) {
    const active = await findActiveProfile(profileIdInput, tx);
    if (!active) {
      // 用具名领域错误，让 createOrderForActor 的 catch 能映射为 400 ValidationError，
      // 而非穿透成 500。prepare→write 之间客户被归档的 TOCTOU 场景同样走这里。
      throw new OrderProjectMissingProfileError("指定的客户不存在或已归档，已拒绝建单");
    }
    customerCtx = await resolveCustomerBusinessContext(active.profileId, tx);
    if (!customerCtx.profileId) {
      throw new OrderProjectMissingProfileError("客户身份无法解析为 profileId，已拒绝建单");
    }
    resolvedProfileId = customerCtx.profileId;
    finalRepresentativeId = customerCtx.representativeId;
    effectiveBuyerOrganizationId = customerCtx.organizationId;
  }

  // Determine financeTreatment based on projectAction
  let effectiveFinanceTreatment = financeTreatment;
  if (!effectiveFinanceTreatment) {
    if (projectAction === "GENERATE" || projectAction === "LINK") {
      effectiveFinanceTreatment = ORDER_FINANCE_TREATMENT.PROJECT_INCLUDED;
    } else {
      effectiveFinanceTreatment = ORDER_FINANCE_TREATMENT.AUTO;
    }
  }

  const prefixMap: Record<string, string> = { MANUAL: "SO", PINGOODMICE: "PO", OTHER_IMPORT: "IO" };
  const orderNoPrefix = prefixMap[source] || "SO";

  // Generate orderNo inside transaction for concurrency safety
  const orderNo = await generateOrderNo(tx, orderNoPrefix, orderNoRefDate);

  const resolvedConfirmedAt =
    confirmedAtInput != null && confirmedAtInput !== ""
      ? new Date(confirmedAtInput)
      : orderStatus === "CONFIRMED"
        ? new Date()
        : null;
  const resolvedDeliveredAt =
    deliveredAtInput != null && deliveredAtInput !== ""
      ? new Date(deliveredAtInput)
      : null;

  const created = await tx.order.create({
    data: {
      orderNo,
      source,
      sourcePlatform: sourcePlatform?.trim() || null,
      sourceRemark: sourceRemark?.trim() || null,
      externalOrderNo: externalOrderNo?.trim() || null,
      merchantOrderNo: merchantOrderNo?.trim() || null,
      title: title.trim(),
      description: description?.trim() || null,
      category: orderCategory,
      status: orderStatus,
      orderedAt: orderedAt ? new Date(orderedAt) : new Date(),
      confirmedAt: resolvedConfirmedAt,
      deliveredAt: resolvedDeliveredAt,
      profileId: resolvedProfileId,
      customerMatchStatus:
        customerMatchStatusInput?.trim() ||
        (resolvedProfileId ? "MANUAL_MATCHED" : "UNMATCHED"),
      customerMatchScore: customerMatchScore ?? null,
      customerMatchReason:
        customerMatchReasonInput?.trim() ||
        (resolvedProfileId ? "created_with_customer" : null),
      representativeId: finalRepresentativeId,
      totalAmount: computedAmount,
      financeTreatment: effectiveFinanceTreatment,
      financeNote: financeNote?.trim() || null,
      buyerNameSnapshot: customerCtx ? (customerCtx.clientName?.trim() || null) : (buyerNameSnapshot?.trim() || null),
      buyerPhoneSnapshot: customerCtx ? (customerCtx.buyerPhone?.trim() || null) : (buyerPhoneSnapshot?.trim() || null),
      buyerWechatSnapshot: customerCtx ? (customerCtx.buyerWechat?.trim() || null) : (buyerWechatSnapshot?.trim() || null),
      buyerOrgNameSnapshot: customerCtx ? (customerCtx.organizationName?.trim() || null) : (buyerOrgNameSnapshot?.trim() || null),
      buyerAddressSnapshot: customerCtx ? (customerCtx.buyerAddress?.trim() || null) : (buyerAddressSnapshot?.trim() || null),
      buyerOrganizationId: effectiveBuyerOrganizationId,
      techSupport,
      // Mini-program id is not a CRM-authoritative snapshot; never invent from payload when profile-bound.
      buyerMiniProgramIdSnapshot: customerCtx ? null : (buyerMiniProgramIdSnapshot?.trim() || null),
      createdById,
      // Phase E：Agent 创建时同事务绑定为当前合格 actor；Web 可由 ADMIN 指派。
      technicalOwnerUserId: technicalOwnerUserId ?? null,
      departmentSnapshot: resolvedDepartmentSnapshot,
      lines: lineItems.length > 0
        ? {
            create: lineItems.map((l, i) => ({
              itemName: l.itemName.trim(),
              spec: l.spec?.trim() || null,
              unit: l.unit?.trim() || null,
              quantity: l.quantity != null ? Number(l.quantity) : null,
              unitPrice: l.unitPrice != null ? Number(l.unitPrice) : null,
              amount: Number(l.amount) || 0,
              category: l.category || orderCategory,
              sortOrder: l.sortOrder ?? i,
              rawJson: l.rawJson?.trim() || null,
              // Phase 1：成交时编号快照（仅当行有 productSkuId 时；服务端 prepare 已生成）。
              productCodeSnapshot: l.productCodeSnapshot ?? null,
              skuCodeSnapshot: l.skuCodeSnapshot ?? null,
            })),
          }
        : undefined,
    },
    include: {
      lines: { orderBy: { sortOrder: "asc" } },
      profile: { select: { id: true, name: true, customerCode: true } },
    },
  });

  // Phase 1：为每条带 productSkuId 的 OrderLine 原子创建目录绑定。
  // 新业务必须写 productSkuId（兼容期不变量：productSkuId OR serviceKey 至少一个非空）。
  // 历史自由文本行无 productSkuId，不创建绑定（进入未映射治理队列）。
  if (lineItems.some((l) => l.productSkuId)) {
    const createdLines = created.lines ?? [];
    for (const line of createdLines) {
      const input = lineItems.find((l) => l.itemName.trim() === line.itemName && (l.sortOrder ?? 0) === line.sortOrder);
      if (input?.productSkuId) {
        await tx.orderLineServiceMapping.create({
          data: {
            orderLineId: line.id,
            productSkuId: input.productSkuId,
            source: "AGENT_DRAFT",
            confidence: 1.0,
            confirmedAt: new Date(),
          },
        });
      }
    }
  }

  let project: Awaited<ReturnType<TransactionClient["project"]["create"]>> | null = null;
  let repSnapshot: RepAssignedSnapshot | null = null;
  let effectiveOrderProfileId = resolvedProfileId;

  // ── Project generation ──────────────────────────────────────────
  if (projectAction === "GENERATE" && resolvedProfileId) {
    // 复用上方已解析的 customerCtx（profile 主权），避免重复查询
    const ctx = customerCtx ?? await resolveCustomerBusinessContext(resolvedProfileId, tx);
    const newProjectNo = await generateProjectNo(tx as Parameters<typeof generateProjectNo>[0]);
    const draft = projectDraft || {};
    const pStartDate = (draft.startDate as string) || new Date().toISOString().slice(0, 10);
    const pBudgetCost = draft.budgetCost != null ? yuanToCents(Number(draft.budgetCost)) : null;

    const firstLine = created.lines?.[0];
    const derivedFromLine = firstLine
      ? [firstLine.itemName, firstLine.spec].filter(Boolean).join(" / ")
      : null;
    const derivedProjectContent =
      (draft.projectContent as string)?.trim() ||
      derivedFromLine ||
      title.trim();
    const derivedProjectType =
      normalizeProjectType(draft.projectType as string) ||
      (orderCategory === "PRODUCT" ? "商品" : "服务");
    const derivedQuantity =
      draft.quantity != null && draft.quantity !== ""
        ? Number(draft.quantity)
        : firstLine?.quantity ?? null;

    project = await tx.project.create({
      data: {
        projectNo: newProjectNo,
        orderNumber: orderNo,
        name: title.trim(),
        description: description?.trim() || null,
        profileId: resolvedProfileId,
        client: ctx.clientName,
        organization: ctx.organizationName,
        representativeId: ctx.representativeId,
        representative: ctx.representativeName,
        projectType: derivedProjectType,
        projectContent: derivedProjectContent,
        quantity: derivedQuantity,
        procurementSource: (draft.procurementSource as string) || null,
        brand: (draft.brand as string) || null,
        // 项目是订单的关联资源；生成时只复制订单技术支持，绝不反向决定订单字段。
        techSupport,
        budgetAmount: computedAmount,
        budgetAmountSource: "ORDER_LINK",
        budgetCost: pBudgetCost,
        startDate: new Date(pStartDate),
        status: "NOT_STARTED",
        // 部门归属继承订单（设计 §7.2：有父记录时继承父记录 department）
        departmentSnapshot: resolvedDepartmentSnapshot,
        members: {
          create: { userId: createdById, role: "OWNER" },
        },
      },
    });

    if (ctx.representativeId) {
      const rep = await tx.representative.findUnique({
        where: { id: ctx.representativeId, archived: false },
        select: { id: true, name: true, email: true },
      });
      if (rep) {
        repSnapshot = {
          projectId: project.id,
          projectName: project.name,
          representativeId: rep.id,
          representativeName: rep.name,
          representativeEmail: rep.email,
        };
      }
    }

    await tx.orderProjectLink.create({
      data: {
        orderId: created.id,
        projectId: project.id,
        relationType: "GENERATED",
        treatment: "PROJECT_INCLUDED",
        isPrimary: true,
        createdById,
      },
    });

    await tx.activityLog.create({
      data: {
        type: "PROJECT_CREATED",
        content: `通过订单 ${orderNo} 生成了项目 "${project.name}"`,
        projectId: project.id,
        userId: createdById,
      },
    });

    if (pBudgetCost) {
      const { syncProjectBudgetCost } = await import("@/lib/finance/ledger");
      await syncProjectBudgetCost(
        project.id,
        pBudgetCost,
        createdById,
        tx as Parameters<typeof syncProjectBudgetCost>[3],
      );
    }
  }

  // ── Project linking ─────────────────────────────────────────────
  if (projectAction === "LINK" && projectId) {
    const linkResult = await linkOrderToProject(
      tx,
      created.id,
      projectId,
      createdById,
      { treatment: "PROJECT_INCLUDED", isPrimary: true },
    );
    if (linkResult.repAssignedToProject) {
      repSnapshot = linkResult.repAssignedToProject;
    }
    if (linkResult.orderUpdateData) {
      await tx.order.update({
        where: { id: created.id },
        data: linkResult.orderUpdateData,
      });
      const inheritedProfileId =
        typeof linkResult.orderUpdateData.profileId === "string"
          ? linkResult.orderUpdateData.profileId
          : null;
      if (inheritedProfileId) {
        effectiveOrderProfileId = inheritedProfileId;
      }
    }
  }

  // ── Order-level initial cost ────────────────────────────────────
  const costAmount = initialCost != null ? Number(initialCost) : 0;
  if (costAmount > 0) {
    await tx.financeCost.create({
      data: {
        orderId: created.id,
        profileId: effectiveOrderProfileId,
        amount: costAmount,
        costType: initialCostType || "OTHER",
        remark: initialCostRemark?.trim() || null,
        sourceType: "ORDER_INITIAL_COST",
        sourceKey: `order-initial-cost:${created.id}`,
        createdById,
      },
    });
  }

  return { order: created, project, repSnapshot };
}

/**
 * Wrapper that retries on orderNo/projectNo unique collision.
 * Suitable for API routes that need to handle concurrent creation.
 */
export async function createOrderWithProjectRetry(
  tx: TransactionClient,
  payload: CreateOrderPayload,
  maxAttempts = 3,
): Promise<CreateOrderResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await createOrderWithProject(tx, payload);
    } catch (err) {
      lastError = err;
      if (err instanceof OrderProjectCustomerConflictError || err instanceof OrderProjectMissingProfileError) {
        throw err;
      }
      const isP2002 =
        typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002";
      const target = Array.isArray(
        ((err as { meta?: { target?: unknown } }).meta?.target),
      )
        ? ((err as { meta?: { target?: string[] } }).meta?.target || [])
        : [];
      if (isP2002 && attempt < maxAttempts - 1 && target.includes("orderNo")) {
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
