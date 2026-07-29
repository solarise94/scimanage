import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { queryOrders } from "@/lib/orders/application/query-orders";
import { createOrderForActor } from "@/lib/orders/application/create-order";
import { businessActorFromSessionUser, buildInvocationContext } from "@/lib/application/actor";
import { ApplicationError, ConflictError } from "@/lib/application/errors";
import { centsToYuan } from "@/lib/finance/money";
import { getOrderInvoiceSummaryBatch } from "@/lib/finance/order-invoice-amounts";
import { toPublicOrder } from "@/lib/crm/public-dto";
import { getCustomerOrganizationName } from "@/lib/customer-organization";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = req.nextUrl;

  // Profile-only 契约：旧 *CustomerId 系查询参数一律 400（Phase E 删列后随旧列一起移除）。
  // 用键名枚举而非硬编码字段名，避免在源码里引用已废弃契约。
  const legacyParam = [...url.searchParams.keys()].find((k) => /customerids?$/i.test(k));
  if (legacyParam) {
    return NextResponse.json(
      { error: `请使用 profileId 筛选订单（不再接受 ${legacyParam}）` },
      { status: 400 },
    );
  }

  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));
  const sortKey = (url.searchParams.get("sort") || "").trim();
  const sortDir = url.searchParams.get("order") === "asc" ? "asc" : "desc";

  // capability / scope / AND-composition / 排序 / 分页 / deleted+accrual 口径全部
  // 在 canonical service (queryOrders) 内，与 Agent orders.search 共用。
  const actor = businessActorFromSessionUser(session.user);
  let result;
  try {
    result = await queryOrders(actor, {
      filters: {
        search: url.searchParams.get("search")?.trim() || undefined,
        source: url.searchParams.get("source")?.trim() || undefined,
        status: url.searchParams.get("status")?.trim() || undefined,
        category: url.searchParams.get("category")?.trim() || undefined,
        customerMatchStatus: url.searchParams.get("customerMatchStatus")?.trim() || undefined,
        financeTreatment: url.searchParams.get("financeTreatment")?.trim() || undefined,
        profileId: url.searchParams.get("profileId")?.trim() || undefined,
        projectId: url.searchParams.get("projectId")?.trim() || undefined,
        representativeId: url.searchParams.get("representativeId")?.trim() || undefined,
        createdFrom: url.searchParams.get("createdFrom")?.trim() || undefined,
        createdTo: url.searchParams.get("createdTo")?.trim() || undefined,
        deliveredFrom: url.searchParams.get("deliveredFrom")?.trim() || undefined,
        deliveredTo: url.searchParams.get("deliveredTo")?.trim() || undefined,
        includeAccrual: url.searchParams.get("includeAccrual") === "true",
        includeDeleted: url.searchParams.get("includeDeleted") === "true",
      },
      sort: { key: sortKey, dir: sortDir },
      page,
      pageSize,
    });
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }

  const orders = result.orders;
  const total = result.total;

  // A6：批量附加发票摘要（元），供订单列表展示开票状态与剩余额度。
  const invoiceSummaryMap = await getOrderInvoiceSummaryBatch(orders.map((o) => o.id));

  return NextResponse.json({
    orders: orders.map((o) => {
      const profileDto = o.profile
        ? {
            id: o.profile.id,
            name: o.profile.name ?? null,
            customerCode: o.profile.customerCode ?? null,
            organizationId: o.profile.organizationId ?? null,
            organization: getCustomerOrganizationName({
              organization: o.profile.organization,
              org: o.profile.org,
              orgSite: o.profile.orgSite,
            }),
          }
        : null;
      return {
        ...toPublicOrder(o as unknown as Record<string, unknown>),
        profileId: o.profileId,
        profile: profileDto,
        customer: profileDto,
        totalAmount: centsToYuan(o.totalAmount),
        financeAmountOverride: o.financeAmountOverride != null ? centsToYuan(o.financeAmountOverride) : null,
        projectLinks: o.projectLinks.map((pl) => ({
          ...pl,
          allocatedAmount: pl.allocatedAmount != null ? centsToYuan(pl.allocatedAmount) : null,
        })),
        invoiceSummary: invoiceSummaryMap.get(o.id) ?? {
          invoiceCount: 0,
          invoiceStatusSummary: {},
          invoiceCapacityAmount: centsToYuan(o.financeAmountOverride ?? o.totalAmount),
          invoicedAmount: 0,
          invoiceRequestedAmount: 0,
          invoiceDraftAmount: 0,
          invoiceOccupiedAmount: 0,
          invoiceRemainingAmount: centsToYuan(o.financeAmountOverride ?? o.totalAmount),
        },
      };
    }),
    total, page: result.page, pageSize: result.pageSize, totalPages: result.totalPages,
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  // Profile-only 契约：旧 *CustomerId 系字段一律 400（Phase E 删列后随旧列一起移除）。
  const legacyKey = Object.keys(body as Record<string, unknown>).find((k) => /customerids?$/i.test(k));
  if (legacyKey) {
    return NextResponse.json(
      { error: `请使用 profileId 指定客户（不再接受 ${legacyKey}）` },
      { status: 400 },
    );
  }
  const {
    title, description, category, status, orderedAt,
    profileId: bodyProfileId, representativeId, lines, totalAmount,
    projectAction, projectId, financeTreatment, financeNote,
    buyerNameSnapshot, buyerPhoneSnapshot, buyerWechatSnapshot, buyerOrgNameSnapshot, buyerAddressSnapshot,
    buyerOrganizationId,
    techSupport,
    projectDraft, initialCost, initialCostType, initialCostRemark,
  } = body as Record<string, unknown>;

  const actor = businessActorFromSessionUser(session.user);
  const invocation = buildInvocationContext({ channel: "web" });

  let created;
  try {
    created = await createOrderForActor(actor, invocation, {
      title: typeof title === "string" ? title : "",
      description: typeof description === "string" ? description : null,
      category: typeof category === "string" ? category : null,
      status: typeof status === "string" ? status : null,
      orderedAt: (orderedAt as string | Date | null | undefined) ?? null,
      profileId: typeof bodyProfileId === "string" ? bodyProfileId : "",
      representativeId: typeof representativeId === "string" ? representativeId : null,
      buyerOrganizationId: typeof buyerOrganizationId === "string" ? buyerOrganizationId : null,
      lines: Array.isArray(lines)
        ? lines.map((l: Record<string, unknown>) => ({
            itemName: String(l.itemName ?? ""),
            spec: l.spec?.toString() ?? null,
            unit: l.unit?.toString() ?? null,
            quantity: l.quantity != null ? Number(l.quantity) : null,
            unitPrice: l.unitPrice != null ? Number(l.unitPrice) : null,
            amount: Number(l.amount) || 0,
            productSkuId: typeof l.productSkuId === "string" ? l.productSkuId : null,
          }))
        : null,
      totalAmount: totalAmount != null ? Number(totalAmount) : null,
      moneyUnit: "yuan",
      projectAction: projectAction === "GENERATE" || projectAction === "LINK" ? projectAction : null,
      projectId: typeof projectId === "string" ? projectId : null,
      financeTreatment: typeof financeTreatment === "string" ? financeTreatment : null,
      financeNote: typeof financeNote === "string" ? financeNote : null,
      buyerNameSnapshot: typeof buyerNameSnapshot === "string" ? buyerNameSnapshot : null,
      buyerPhoneSnapshot: typeof buyerPhoneSnapshot === "string" ? buyerPhoneSnapshot : null,
      buyerWechatSnapshot: typeof buyerWechatSnapshot === "string" ? buyerWechatSnapshot : null,
      buyerOrgNameSnapshot: typeof buyerOrgNameSnapshot === "string" ? buyerOrgNameSnapshot : null,
      buyerAddressSnapshot: typeof buyerAddressSnapshot === "string" ? buyerAddressSnapshot : null,
      techSupport: typeof techSupport === "string" ? techSupport : null,
      projectDraft: (projectDraft as Record<string, unknown>) || null,
      initialCost: initialCost != null ? Number(initialCost) : null,
      initialCostType: typeof initialCostType === "string" ? initialCostType : null,
      initialCostRemark: typeof initialCostRemark === "string" ? initialCostRemark : null,
      source: "MANUAL",
    });
  } catch (err) {
    if (err instanceof ConflictError && err.message === "订单客户与项目客户不一致") {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }

  const order = created.order;
  const profileDto = order?.profile
    ? {
        id: order.profile.id,
        name: order.profile.name ?? null,
        customerCode: order.profile.customerCode ?? null,
      }
    : null;

  return NextResponse.json({
    order: {
      ...toPublicOrder(order as unknown as Record<string, unknown>),
      profileId: order.profileId ?? null,
      profile: profileDto,
      customer: profileDto,
      totalAmount: centsToYuan(order.totalAmount),
      financeAmountOverride: order.financeAmountOverride != null ? centsToYuan(order.financeAmountOverride) : null,
      lines: order.lines?.map((l: Record<string, unknown>) => ({
        ...l,
        unitPrice: l.unitPrice != null ? centsToYuan(l.unitPrice as number) : null,
        amount: centsToYuan(l.amount as number),
      })),
    },
  }, { status: 201 });
}
