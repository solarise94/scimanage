import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { businessActorFromSessionUser } from "@/lib/application/actor";
import { ApplicationError } from "@/lib/application/errors";
import {
  getInvoiceDetailForActor,
} from "@/lib/finance/application/query-invoice-detail";
import { assertOrderInvoiceListRouteRole } from "@/lib/finance/application/query-order-invoices";
import { centsToYuan, yuanToCents } from "@/lib/finance/money";
import { prisma } from "@/lib/prisma";
import { syncOrderInvoiceStatus } from "@/lib/external-order";
import { releaseInvoiceClaimsForRequest } from "@/lib/finance/invoice-claims";
import { sendInvoiceRequestedEmail } from "@/lib/business-email/notify";

const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["REQUESTED", "ISSUED", "CANCELLED"],
  REQUESTED: ["ISSUED", "CANCELLED"],
};

async function syncAllCoveredOrders(invoiceId: string) {
  const newCoverage = await prisma.orderInvoiceCoverage.findMany({
    where: { invoiceRequestId: invoiceId },
    select: { orderId: true },
  });
  for (const cov of newCoverage) {
    const order = await prisma.order.findUnique({
      where: { id: cov.orderId },
      select: { legacyExternalOrderId: true },
    });
    const legacyId = order?.legacyExternalOrderId ?? null;
    if (legacyId) {
      await syncOrderInvoiceStatus(prisma, legacyId, cov.orderId);
    }
    await syncOrderInvoiceStatus(prisma, cov.orderId, cov.orderId);
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;

  try {
    assertOrderInvoiceListRouteRole(session.user.role);
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }

  const { id } = await params;
  const actor = businessActorFromSessionUser(session.user);

  try {
    const detail = await getInvoiceDetailForActor(actor, id);
    const { invoice, lineItems, orderQuota } = detail;

    return NextResponse.json({
      invoice: {
        ...invoice,
        totalAmount: centsToYuan(invoice.totalAmount),
        items: lineItems.map((it) => ({ ...it, amount: centsToYuan(it.amount) })),
        orderCoverage: detail.coveredOrders.map((c) => ({
          amount: centsToYuan(c.amount),
          order: { id: c.orderId, orderNo: c.orderNo, title: c.title },
        })),
        legacyCoverage: invoice.legacyCoverage,
        createdAt: invoice.createdAt.toISOString(),
        updatedAt: invoice.updatedAt.toISOString(),
        actualIssuedAt: invoice.actualIssuedAt?.toISOString() ?? null,
        receipts: invoice.receipts.map((r) => ({
          ...r,
          amount: centsToYuan(r.amount),
          receivedAt: r.receivedAt?.toISOString() ?? null,
        })),
        documents: invoice.documents.map((d) => ({
          ...d,
          createdAt: d.createdAt.toISOString(),
        })),
      },
      orderQuota: orderQuota.map((q) => ({
        orderId: q.orderId,
        orderNo: q.orderNo,
        capacity: centsToYuan(q.capacity),
        occupied: centsToYuan(q.occupied),
        remaining: centsToYuan(q.remaining),
        activeInvoices: q.activeInvoices.map((row) => ({
          ...row,
          amountCents: centsToYuan(row.amountCents),
        })),
      })),
    });
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const invoice = await prisma.externalOrderInvoiceRequest.findUnique({
    where: { id },
    select: { status: true, orderId: true, _count: { select: { orderCoverage: true } } },
  });
  if (!invoice) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const currentStatus = invoice.status;
  if (currentStatus === "ISSUED" || currentStatus === "CANCELLED") {
    return NextResponse.json({ error: "终态开票申请不可修改" }, { status: 400 });
  }

  const body = await req.json();
  const {
    status, contactName, sellerProfileId, sellerName,
    sellerTaxId: manualSellerTaxId, sellerBankName: manualSellerBankName,
    sellerBankAccount: manualSellerBankAccount,
    buyerOrganizationId, buyerOrganizationName, buyerTaxId,
    invoiceType, contentSummary, remark, items, taxIdFromLookup,
  } = body as Record<string, unknown>;

  const hasCoverage = invoice._count.orderCoverage > 0;
  const touchesAmountFields =
    items !== undefined ||
    (body as Record<string, unknown>).coverageAllocations !== undefined;
  if (hasCoverage && touchesAmountFields) {
    return NextResponse.json(
      { error: "该发票已存在订单分摊记录，不能修改金额或明细。请删除草稿后重建，或走取消/冲红/重开流程。" },
      { status: 400 },
    );
  }

  if (status && status !== currentStatus) {
    const allowed = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(status as string)) {
      return NextResponse.json({ error: `不允许从 ${currentStatus} 转为 ${status}` }, { status: 400 });
    }
  }

  if (currentStatus === "REQUESTED") {
    const data: Record<string, unknown> = {};
    if (status) data.status = status;
    if (remark !== undefined) data.remark = (remark as string)?.trim() || null;
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "已申请状态只能修改备注或变更状态" }, { status: 400 });
    }
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.externalOrderInvoiceRequest.update({
        where: { id },
        data,
        include: {
          items: { orderBy: { sortOrder: "asc" } },
          createdBy: { select: { id: true, name: true } },
          orderCoverage: { include: { order: { select: { id: true, orderNo: true } } } },
        },
      });
      if (status === "CANCELLED") {
        await releaseInvoiceClaimsForRequest(tx, id);
      }
      return row;
    });
    await syncAllCoveredOrders(id);
    return NextResponse.json({
      invoice: {
        ...updated,
        totalAmount: centsToYuan(updated.totalAmount),
        items: updated.items.map((it) => ({ ...it, amount: centsToYuan(it.amount) })),
        orderCoverage: updated.orderCoverage.map((c) => ({ ...c, amount: centsToYuan(c.amount) })),
      },
    });
  }

  const data: Record<string, unknown> = {};
  if (status) data.status = status;
  if (contactName !== undefined) data.contactName = (contactName as string)?.trim() || null;
  if (remark !== undefined) data.remark = (remark as string)?.trim() || null;
  if (invoiceType !== undefined) data.invoiceType = invoiceType === "SPECIAL" ? "SPECIAL" : "NORMAL";
  if (contentSummary !== undefined) data.contentSummary = (contentSummary as string)?.trim() || null;

  if (sellerProfileId !== undefined) {
    if (sellerProfileId) {
      const profile = await prisma.billingProfile.findUnique({ where: { id: sellerProfileId as string } });
      if (profile) {
        data.sellerProfileId = profile.id; data.sellerName = profile.name;
        data.sellerTaxId = profile.taxId || null; data.sellerBankName = profile.bankName || null;
        data.sellerBankAccount = profile.bankAccount || null;
        data.sellerAddress = profile.address || null; data.sellerPhone = profile.phone || null;
      }
    } else {
      data.sellerProfileId = null; data.sellerAddress = null; data.sellerPhone = null;
      if (sellerName !== undefined) data.sellerName = (sellerName as string)?.trim() || null;
      data.sellerTaxId = (manualSellerTaxId as string)?.trim() || null;
      data.sellerBankName = (manualSellerBankName as string)?.trim() || null;
      data.sellerBankAccount = (manualSellerBankAccount as string)?.trim() || null;
    }
  }

  if (buyerOrganizationId !== undefined) data.buyerOrganizationId = buyerOrganizationId || null;
  if (buyerOrganizationName !== undefined) data.buyerOrganizationName = (buyerOrganizationName as string)?.trim() || "";
  if (buyerTaxId !== undefined) data.buyerTaxId = (buyerTaxId as string)?.trim() || null;
  if (taxIdFromLookup !== undefined) data.buyerTaxIdFromLookup = !!taxIdFromLookup;

  if (items !== undefined) {
    const itemRows = (Array.isArray(items) ? items : []).filter((it: Record<string, unknown>) => (it.itemName as string)?.trim());
    data.totalAmount = itemRows.reduce((sum: number, it: Record<string, unknown>) => sum + yuanToCents(Number(it.amount) || 0), 0);
    await prisma.externalOrderInvoiceItem.deleteMany({ where: { invoiceRequestId: id } });
    if (itemRows.length > 0) {
      await prisma.externalOrderInvoiceItem.createMany({
        data: itemRows.map((it: Record<string, unknown>, i: number) => ({
          invoiceRequestId: id, sortOrder: i,
          itemName: (it.itemName as string).trim(), spec: (it.spec as string)?.trim() || null,
          unit: (it.unit as string)?.trim() || null, quantity: it.quantity != null ? Number(it.quantity) : null,
          amount: yuanToCents(Number(it.amount) || 0),
        })),
      });
    }
  }

  if (Object.keys(data).length === 0 && items === undefined) {
    return NextResponse.json({ error: "无更新内容" }, { status: 400 });
  }

  if (currentStatus === "DRAFT" && status === "REQUESTED") {
    data.submittedAt = new Date();
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.externalOrderInvoiceRequest.update({
      where: { id },
      data,
      include: {
        items: { orderBy: { sortOrder: "asc" } },
        createdBy: { select: { id: true, name: true } },
        orderCoverage: { include: { order: { select: { id: true, orderNo: true } } } },
      },
    });
    if (status === "CANCELLED") {
      await releaseInvoiceClaimsForRequest(tx, id);
    }
    return row;
  });

  await syncAllCoveredOrders(id);
  if (currentStatus === "DRAFT" && status === "REQUESTED") {
    await sendInvoiceRequestedEmail(id);
  }
  return NextResponse.json({
    invoice: {
      ...updated,
      totalAmount: centsToYuan(updated.totalAmount),
      items: updated.items.map((it) => ({ ...it, amount: centsToYuan(it.amount) })),
      orderCoverage: updated.orderCoverage.map((c) => ({ ...c, amount: centsToYuan(c.amount) })),
    },
  });
}
