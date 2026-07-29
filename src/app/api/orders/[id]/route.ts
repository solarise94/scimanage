import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ORDER_STATUS_TRANSITIONS, ORDER_SOURCE, OrderCategoryValidationError, assertValidOrderCategory } from "@/lib/orders/constants";
import { resolveCustomerBusinessContext } from "@/lib/business/customer-context";
import { transitionCrmStage } from "@/lib/crm/lifecycle";
import { getOrderDetail } from "@/lib/orders/application/get-order-detail";
import { businessActorFromSessionUser } from "@/lib/application/actor";
import { ApplicationError } from "@/lib/application/errors";
import { yuanToCents, centsToYuan } from "@/lib/finance/money";
import { getCustomerOrganizationName } from "@/lib/customer-organization";
import { toPublicOrder } from "@/lib/crm/public-dto";
import type { Prisma } from "@prisma/client";

function isSameYearMonth(a: Date | string | null | undefined, b: Date): boolean {
  if (!a) return false;
  const da = typeof a === "string" ? new Date(a) : a;
  return da.getFullYear() === b.getFullYear() && da.getMonth() === b.getMonth();
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  // capability / object scope / deleted 口径 / unified invoices 全部在 canonical
  // detail service 内，与 Agent orders.get_detail 共用。out-of-scope 与不存在都
  // 返回 404（不泄露存在性，见 §2.3）。
  const actor = businessActorFromSessionUser(session.user);
  let order: Awaited<ReturnType<typeof getOrderDetail>>["order"];
  let unifiedInvoices: Awaited<ReturnType<typeof getOrderDetail>>["invoices"];
  try {
    const detail = await getOrderDetail(actor, id);
    order = detail.order;
    unifiedInvoices = detail.invoices;
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }

  const resolvedCustomer = order.profile
    ? {
        id: order.profile.id,
        name: order.profile.name ?? null,
        customerCode: order.profile.customerCode ?? null,
        organization: getCustomerOrganizationName({
          organization: order.profile.organization,
          org: order.profile.org,
        }),
        organizationId: order.profile.organizationId ?? null,
      }
    : null;

  return NextResponse.json({
    order: {
      ...toPublicOrder(order as unknown as Record<string, unknown>),
      profileId: order.profileId,
      profile: order.profile
        ? { id: order.profile.id, name: order.profile.name ?? null, customerCode: order.profile.customerCode ?? null }
        : null,
      customer: resolvedCustomer,
      totalAmount: centsToYuan(order.totalAmount),
      financeAmountOverride: order.financeAmountOverride != null ? centsToYuan(order.financeAmountOverride) : null,
      lines: order.lines.map((l) => ({
        ...l,
        unitPrice: l.unitPrice != null ? centsToYuan(l.unitPrice) : null,
        amount: centsToYuan(l.amount),
      })),
      projectLinks: order.projectLinks.map((pl) => ({
        ...pl,
        allocatedAmount: pl.allocatedAmount != null ? centsToYuan(pl.allocatedAmount) : null,
      })),
      receipts: order.receipts.map((r) => ({ ...r, amount: centsToYuan(r.amount) })),
      financeCosts: order.financeCosts.map((c) => ({ ...c, amount: centsToYuan(c.amount) })),
    },
    invoices: unifiedInvoices.map((inv) => ({
      ...inv,
      totalAmount: centsToYuan(inv.totalAmount),
      allocatedAmount: centsToYuan(inv.allocatedAmount),
      items: inv.items?.map((it: Record<string, unknown>) => ({ ...it, amount: typeof it.amount === 'number' ? centsToYuan(it.amount) : it.amount })),
    })),
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const existing = await prisma.order.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      source: true,
      profileId: true,
      representativeId: true,
      orderNo: true,
      title: true,
      category: true,
      techSupport: true,
      totalAmount: true,
      orderedAt: true,
      confirmedAt: true,
      financeTreatment: true,
      deleted: true,
      accrualReversals: { select: { id: true } },
    },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (existing.deleted) return NextResponse.json({ error: "已删除订单不可编辑" }, { status: 400 });

  const body = await req.json();
  // Profile-only 契约：旧 *CustomerId 系字段一律 400（Phase E 删列后随旧列一起移除）。
  // 用键名枚举而非硬编码字段名，避免在源码里引用已废弃契约。
  const legacyKey = Object.keys(body as Record<string, unknown>).find((k) => /customerids?$/i.test(k));
  if (legacyKey) {
    return NextResponse.json(
      { error: `请使用 profileId 指定客户（不再接受 ${legacyKey}）` },
      { status: 400 },
    );
  }
  const {
    title, description, category, status,
    orderedAt, confirmedAt, deliveredAt,
    profileId: bodyProfileId, customerMatchStatus, customerMatchScore, customerMatchReason,
    representativeId,
    financeAmountOverride, financeTreatment, financeNote,
    buyerNameSnapshot, buyerPhoneSnapshot, buyerWechatSnapshot, buyerOrgNameSnapshot, buyerAddressSnapshot,
    techSupport,
    lines,
    statusNote,
    closeType,
  } = body as Record<string, unknown>;

  // 状态流转可选原因（如取消订单原因），仅写入 OrderStatusHistory.note，不回写 Order 主表
  const normalizedStatusNote = typeof statusNote === "string" && statusNote.trim() ? statusNote.trim() : null;

  const data: Record<string, unknown> = {};

  if (title !== undefined) data.title = String(title).trim();
  if (description !== undefined) data.description = (description as string)?.trim() || null;
  if (category !== undefined) {
    try {
      const nextCategory = typeof category === "string" ? category : undefined;
      assertValidOrderCategory(nextCategory);
      data.category = nextCategory;
    } catch (e) {
      if (e instanceof OrderCategoryValidationError) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      throw e;
    }
  }
  if (status !== undefined) data.status = status;
  if (orderedAt !== undefined) data.orderedAt = orderedAt ? new Date(orderedAt as string) : null;
  if (confirmedAt !== undefined) data.confirmedAt = confirmedAt ? new Date(confirmedAt as string) : null;
  if (deliveredAt !== undefined) data.deliveredAt = deliveredAt ? new Date(deliveredAt as string) : null;
  if (bodyProfileId !== undefined) {
    const rawId = (bodyProfileId as string) || null;
    // U3：禁止清空订单客户。现有客户非空且新值为空 → 400 拒绝（只认 profileId）。
    if (!rawId && existing.profileId) {
      return NextResponse.json(
        { error: "不允许清空订单客户，请换绑到其他客户或走治理流程" },
        { status: 400 },
      );
    }
    if (rawId) {
      const { findActiveProfile } = await import("@/lib/crm/ids");
      const ref = await findActiveProfile(rawId, prisma);
      if (!ref) {
        return NextResponse.json({ error: "指定的客户不存在" }, { status: 400 });
      }
      data.profileId = ref.profileId;
    } else {
      data.profileId = null;
    }
  }
  if (customerMatchStatus !== undefined) data.customerMatchStatus = customerMatchStatus;
  if (customerMatchScore !== undefined) data.customerMatchScore = customerMatchScore;
  if (customerMatchReason !== undefined) data.customerMatchReason = (customerMatchReason as string) || null;
  // ── Resolve representative ──────────────────────────────────────────
  const customerTouched = bodyProfileId !== undefined;
  const nextProfileId = customerTouched
    ? ((data.profileId as string | null | undefined) ?? null)
    : (existing.profileId ?? null);

  if (customerTouched && nextProfileId) {
    const ctx = await resolveCustomerBusinessContext(nextProfileId);
    data.representativeId = ctx.representativeId;
    if (buyerOrgNameSnapshot === undefined && ctx.organizationName) {
      data.buyerOrgNameSnapshot = ctx.organizationName;
    }
    if (buyerNameSnapshot === undefined && ctx.clientName) {
      data.buyerNameSnapshot = ctx.clientName;
    }
    if (ctx.organizationId) {
      data.buyerOrganizationId = ctx.organizationId;
    }
  } else if (customerTouched && !nextProfileId) {
    data.representativeId = null;
  } else if (representativeId !== undefined) {
    // No customer change — allow manual rep
    if (representativeId) {
      const rep = await prisma.representative.findUnique({ where: { id: representativeId as string } });
      if (!rep || rep.archived) {
        return NextResponse.json({ error: "指定的代表不存在" }, { status: 400 });
      }
      data.representativeId = rep.id;
    } else {
      data.representativeId = null;
    }
  }

  if (financeAmountOverride !== undefined) data.financeAmountOverride = financeAmountOverride === null ? null : yuanToCents(Number(financeAmountOverride));
  if (financeTreatment !== undefined) data.financeTreatment = financeTreatment;
  if (financeNote !== undefined) data.financeNote = (financeNote as string)?.trim() || null;
  if (buyerNameSnapshot !== undefined) data.buyerNameSnapshot = (buyerNameSnapshot as string)?.trim() || null;
  if (buyerPhoneSnapshot !== undefined) data.buyerPhoneSnapshot = (buyerPhoneSnapshot as string)?.trim() || null;
  if (buyerWechatSnapshot !== undefined) data.buyerWechatSnapshot = (buyerWechatSnapshot as string)?.trim() || null;
  if (buyerOrgNameSnapshot !== undefined) data.buyerOrgNameSnapshot = (buyerOrgNameSnapshot as string)?.trim() || null;
  if (buyerAddressSnapshot !== undefined) data.buyerAddressSnapshot = (buyerAddressSnapshot as string)?.trim() || null;
  if (techSupport !== undefined) {
    const nextTechSupport = typeof techSupport === "string" ? techSupport.trim() : "";
    if (!nextTechSupport) {
      return NextResponse.json({ error: "订单必须提供技术支持" }, { status: 400 });
    }
    data.techSupport = nextTechSupport;
  }

  // ── Financial lock (unified, covers lines + standalone finance fields) ──
  const lineItems = Array.isArray(lines) ? lines as Array<Record<string, unknown>> : undefined;
  const touchesFinanceFields = lineItems !== undefined
    || financeAmountOverride !== undefined
    || financeTreatment !== undefined;

  let hasFinancialRecords = false;
  if (touchesFinanceFields) {
    const finCheck = await prisma.order.findUnique({
      where: { id },
      select: {
        _count: { select: { receipts: { where: { deleted: false } }, financeCosts: true } },
        invoiceRequests: { where: { status: { not: "CANCELLED" } }, select: { id: true }, take: 1 },
        invoiceCoverage: { where: { invoiceRequest: { status: { not: "CANCELLED" } } }, select: { id: true }, take: 1 },
      },
    });
    hasFinancialRecords = !!(finCheck && (
      finCheck._count.receipts > 0 ||
      finCheck._count.financeCosts > 0 ||
      finCheck.invoiceRequests.length > 0 ||
      finCheck.invoiceCoverage.length > 0
    ));
  }

  if (lineItems !== undefined) {
    if (existing.source !== "MANUAL") {
      return NextResponse.json({ error: "只能编辑手动创建的订单明细" }, { status: 400 });
    }
    if (hasFinancialRecords) {
      return NextResponse.json({ error: "该订单已有回款/发票/成本记录，无法修改明细" }, { status: 400 });
    }
  }

  if ((financeAmountOverride !== undefined || financeTreatment !== undefined) && hasFinancialRecords) {
    return NextResponse.json({ error: "该订单已有回款/发票/成本记录，无法修改金额相关字段" }, { status: 400 });
  }

  if (Object.keys(data).length === 0 && lineItems === undefined) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  // ── Status transition validation ───────────────────────────────────────
  const isClosing = status !== undefined && status !== existing.status && status === "CLOSED";
  const isAccrualClose = isClosing && closeType === "ACCRUAL";

  if (status !== undefined && status !== existing.status) {
    const allowed = ORDER_STATUS_TRANSITIONS[existing.status as keyof typeof ORDER_STATUS_TRANSITIONS];
    if (!allowed || !allowed.includes(status as string)) {
      return NextResponse.json({ error: `无法从 ${existing.status} 转换为 ${status}` }, { status: 400 });
    }
  }

  // ── Accrual close validation ───────────────────────────────────────────
  if (isAccrualClose) {
    // W5.1：影子单只写 profileId；原单必须已有 profileId。
    if (!existing.profileId) {
      return NextResponse.json(
        { error: "原订单未绑定客户（profileId），请先补绑后再计提冲回" },
        { status: 400 },
      );
    }
    if (existing.status !== "CONFIRMED" && existing.status !== "DELIVERED") {
      return NextResponse.json({ error: "仅已确认或已交付订单可计提关闭" }, { status: 400 });
    }
    if (existing.accrualReversals.length > 0) {
      return NextResponse.json({ error: "该订单已计提冲回，不可重复计提" }, { status: 409 });
    }
    if (isSameYearMonth(existing.confirmedAt ?? existing.orderedAt, new Date())) {
      return NextResponse.json({ error: "当月关闭无需计提" }, { status: 400 });
    }
  }

  const orderUpdateInclude = {
    profile: { select: { id: true, name: true, customerCode: true } },
    representative: { select: { id: true, name: true } },
    lines: { orderBy: { sortOrder: "asc" } },
    projectLinks: { include: { project: { select: { id: true, name: true, status: true } } } },
  } as const;

  // ── Execute update with optional line replacement ──────────────────────
  let updated: Prisma.OrderGetPayload<{ include: typeof orderUpdateInclude }>;

  if (isAccrualClose) {
    const now = new Date();
    const closureNote = normalizedStatusNote;
    const shadowNote = `计提冲回：原订单 ${existing.orderNo}`;

    const shadowProfileId = existing.profileId;
    if (!shadowProfileId) {
      return NextResponse.json(
        { error: "订单缺少客户归属（profileId），无法生成计提冲回" },
        { status: 400 },
      );
    }

    updated = await prisma.$transaction(async (tx) => {
      const closed = await tx.order.update({
        where: { id },
        data,
        include: orderUpdateInclude,
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: id,
          oldStatus: existing.status,
          newStatus: "CLOSED",
          note: closureNote,
          createdById: session.user.id,
        },
      });

      const shadow = await tx.order.create({
        data: {
          orderNo: `ACCR-${existing.orderNo}`,
          title: `计提冲回：${existing.title}`,
          source: ORDER_SOURCE.ACCRUAL_REVERSAL,
          category: existing.category,
          status: "CLOSED",
          totalAmount: -existing.totalAmount,
          financeTreatment: "STANDALONE",
          techSupport: existing.techSupport,
          profileId: shadowProfileId,
          representativeId: existing.representativeId,
          orderedAt: now,
          confirmedAt: now,
          createdById: session.user.id,
          accrualReversalOfId: id,
          // 财务冲正凭证，非业务下单；默认 PENDING 会因复制原单 representativeId 误发通知。
          // 显式 SKIPPED（设计 §5.4）。扫描侧另有 source 兜底（§6.2 第 0b 步）。
          repNotifyStatus: "SKIPPED",
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: shadow.id,
          oldStatus: null,
          newStatus: "CLOSED",
          note: shadowNote,
          createdById: session.user.id,
        },
      });

      return closed;
    });
  } else if (lineItems !== undefined) {
    const computedAmount = lineItems.reduce((s, l) => s + yuanToCents(Number(l.amount) || 0), 0);
    data.totalAmount = computedAmount;

    updated = await prisma.$transaction(async (tx) => {
      await tx.orderLine.deleteMany({ where: { orderId: id } });
      if (lineItems.length > 0) {
        await tx.orderLine.createMany({
          data: lineItems.map((l, i) => ({
            orderId: id,
            itemName: String(l.itemName).trim(),
            spec: (l.spec as string)?.trim() || null,
            unit: (l.unit as string)?.trim() || null,
            quantity: l.quantity != null ? Number(l.quantity) : null,
            unitPrice: l.unitPrice != null ? yuanToCents(Number(l.unitPrice)) : null,
            amount: yuanToCents(Number(l.amount) || 0),
            sortOrder: i,
          })),
        });
      }
      return tx.order.update({
        where: { id },
        data,
        include: orderUpdateInclude,
      });
    });
  } else {
    updated = await prisma.order.update({
      where: { id },
      data,
      include: orderUpdateInclude,
    });
  }

  // ── Record status history ──────────────────────────────────────────────
  if (!isAccrualClose && status !== undefined && status !== existing.status) {
    await prisma.orderStatusHistory.create({
      data: {
        orderId: id,
        oldStatus: existing.status,
        newStatus: status as string,
        note: normalizedStatusNote,
        createdById: session.user.id,
      },
    });
  }

  // ── CRM 阶段同步（只认 profileId）──────────────
  const syncProfileIds = new Set<string>();
  if (existing.profileId) syncProfileIds.add(existing.profileId);
  if (updated.profileId) syncProfileIds.add(updated.profileId);

  if (status !== undefined && status !== existing.status) {
    const profileId = updated.profileId || existing.profileId;
    if (profileId) {
      if (status === "CONFIRMED" || status === "DELIVERED") {
        await transitionCrmStage(profileId, { type: "ORDER_CONFIRMED", orderId: id }).catch((err) => {
          console.error(`[CRM][ORDER] ORDER_CONFIRMED transition failed for ${profileId}:`, err);
        });
      } else if (status === "CLOSED") {
        await transitionCrmStage(profileId, { type: "ORDER_CLOSED", orderId: id }).catch((err) => {
          console.error(`[CRM][ORDER] ORDER_CLOSED transition failed for ${profileId}:`, err);
        });
      } else {
        await transitionCrmStage(profileId, { type: "DORMANT_SCAN" }).catch((err) => {
          console.error(`[CRM][ORDER] DORMANT_SCAN transition failed for ${profileId}:`, err);
        });
      }
    }
  } else {
    for (const profileId of syncProfileIds) {
      await transitionCrmStage(profileId, { type: "DORMANT_SCAN" }).catch((err) => {
        console.error(`[CRM][ORDER] DORMANT_SCAN transition failed for ${profileId}:`, err);
      });
    }
  }

  const profileDto = updated.profile
    ? { id: updated.profile.id, name: updated.profile.name ?? null, customerCode: updated.profile.customerCode ?? null }
    : null;
  return NextResponse.json({
    order: {
      ...toPublicOrder(updated as unknown as Record<string, unknown>),
      profileId: updated.profileId,
      profile: profileDto,
      customer: profileDto,
      totalAmount: centsToYuan(updated.totalAmount),
      financeAmountOverride: updated.financeAmountOverride != null ? centsToYuan(updated.financeAmountOverride) : null,
    },
  });
}
