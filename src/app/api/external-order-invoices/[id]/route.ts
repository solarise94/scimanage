import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { syncOrderInvoiceStatus } from "@/lib/external-order";

async function syncInvoiceAndCoverageOrders(invoiceId: string, directOrderId: string | null, orderId?: string | null) {
  const legacyCoverage = await prisma.externalOrderInvoiceCoverage.findMany({
    where: { invoiceRequestId: invoiceId },
    select: { externalOrderId: true },
  });
  // Also check new OrderInvoiceCoverage
  const newCoverage = await prisma.orderInvoiceCoverage.findMany({
    where: { invoiceRequestId: invoiceId },
    select: { orderId: true },
  });
  // Sync all legacy externalOrderIds
  const allExtIds = [directOrderId, ...legacyCoverage.map((c) => c.externalOrderId)].filter(Boolean) as string[];
  for (const oid of allExtIds) {
    await syncOrderInvoiceStatus(prisma, oid);
  }
  // Sync all new orderIds
  const allOrderIds = [orderId, ...newCoverage.map((c) => c.orderId)].filter(Boolean) as string[];
  for (const oid of allOrderIds) {
    // Find the matching externalOrderId if any (for legacy sync)
    const legacyId = await prisma.externalOrder.findFirst({
      where: { id: oid },
      select: { id: true },
    }).then((e) => e?.id ?? null);
    if (legacyId) {
      await syncOrderInvoiceStatus(prisma, legacyId, oid);
    } else {
      // New-style: only Order, no ExternalOrder
      await syncOrderInvoiceStatus(prisma, oid, oid);
    }
  }
}

const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["REQUESTED", "CANCELLED"],
  REQUESTED: ["ISSUED", "CANCELLED"],
};

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const invoice = await prisma.externalOrderInvoiceRequest.findUnique({
    where: { id },
    select: { externalOrderId: true, orderId: true, status: true, buyerTaxIdFromLookup: true },
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
  } = body as {
    status?: string; contactName?: string; sellerProfileId?: string;
    sellerName?: string; sellerTaxId?: string; sellerBankName?: string;
    sellerBankAccount?: string; buyerOrganizationId?: string;
    buyerOrganizationName?: string; buyerTaxId?: string;
    invoiceType?: string; contentSummary?: string; remark?: string;
    items?: Array<{ itemName: string; spec?: string; unit?: string; quantity?: number; amount?: number }>;
    taxIdFromLookup?: boolean;
  };

  if (status && status !== currentStatus) {
    const allowed = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(status)) {
      return NextResponse.json({ error: `不允许从 ${currentStatus} 转为 ${status}` }, { status: 400 });
    }
  }

  if (currentStatus === "REQUESTED") {
    const data: Record<string, unknown> = {};
    if (status) data.status = status;
    if (remark !== undefined) data.remark = remark?.trim() || null;
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "已申请状态只能修改备注或变更状态" }, { status: 400 });
    }
    const updated = await prisma.externalOrderInvoiceRequest.update({
      where: { id }, data,
      include: { items: { orderBy: { sortOrder: "asc" } }, createdBy: { select: { id: true, name: true } } },
    });
    await syncInvoiceAndCoverageOrders(id, invoice.externalOrderId, invoice.orderId);
    return NextResponse.json({ invoice: updated });
  }

  const data: Record<string, unknown> = {};
  if (status) data.status = status;
  if (contactName !== undefined) data.contactName = contactName?.trim() || null;
  if (remark !== undefined) data.remark = remark?.trim() || null;
  if (invoiceType !== undefined) data.invoiceType = invoiceType === "SPECIAL" ? "SPECIAL" : "NORMAL";
  if (contentSummary !== undefined) data.contentSummary = contentSummary?.trim() || null;

  if (sellerProfileId !== undefined) {
    if (sellerProfileId) {
      const profile = await prisma.billingProfile.findUnique({ where: { id: sellerProfileId } });
      if (profile) {
        data.sellerProfileId = profile.id;
        data.sellerName = profile.name;
        data.sellerTaxId = profile.taxId || null;
        data.sellerBankName = profile.bankName || null;
        data.sellerBankAccount = profile.bankAccount || null;
        data.sellerAddress = profile.address || null;
        data.sellerPhone = profile.phone || null;
      }
    } else {
      data.sellerProfileId = null;
      data.sellerAddress = null;
      data.sellerPhone = null;
      if (sellerName !== undefined) data.sellerName = sellerName?.trim() || null;
      data.sellerTaxId = manualSellerTaxId?.trim() || null;
      data.sellerBankName = manualSellerBankName?.trim() || null;
      data.sellerBankAccount = manualSellerBankAccount?.trim() || null;
    }
  } else if (sellerName !== undefined) {
    data.sellerName = sellerName?.trim() || null;
  }

  if (buyerOrganizationId !== undefined) data.buyerOrganizationId = buyerOrganizationId || null;
  if (buyerOrganizationName !== undefined) data.buyerOrganizationName = buyerOrganizationName?.trim() || "";
  if (buyerTaxId !== undefined) data.buyerTaxId = buyerTaxId?.trim() || null;
  if (taxIdFromLookup !== undefined) data.buyerTaxIdFromLookup = !!taxIdFromLookup;

  if (data.buyerOrganizationId && !data.buyerTaxId && buyerTaxId === undefined) {
    const existing = await prisma.externalOrderInvoiceRequest.findUnique({ where: { id }, select: { buyerTaxId: true } });
    if (!existing?.buyerTaxId) {
      return NextResponse.json({ error: "已选择单位但未填写税号" }, { status: 400 });
    }
  }

  const finalBuyerOrgId = (data.buyerOrganizationId as string) || undefined;
  const finalBuyerTaxId = (data.buyerTaxId as string) || undefined;
  const isFromLookup = taxIdFromLookup ?? invoice.buyerTaxIdFromLookup;
  if (finalBuyerOrgId && finalBuyerTaxId && !isFromLookup) {
    const org = await prisma.organization.findUnique({ where: { id: finalBuyerOrgId }, select: { taxId: true } });
    if (org && !org.taxId) {
      await prisma.organization.update({ where: { id: finalBuyerOrgId }, data: { taxId: finalBuyerTaxId } });
    }
  }

  if (items !== undefined) {
    const itemRows = items.filter((it) => it.itemName?.trim());
    data.totalAmount = itemRows.reduce((sum, it) => sum + (it.amount || 0), 0);
    await prisma.externalOrderInvoiceItem.deleteMany({ where: { invoiceRequestId: id } });
    if (itemRows.length > 0) {
      await prisma.externalOrderInvoiceItem.createMany({
        data: itemRows.map((it, i) => ({
          invoiceRequestId: id, sortOrder: i,
          itemName: it.itemName.trim(), spec: it.spec?.trim() || null,
          unit: it.unit?.trim() || null, quantity: it.quantity ?? null,
          amount: it.amount || 0,
        })),
      });
    }
  }

  if (Object.keys(data).length === 0 && items === undefined) {
    return NextResponse.json({ error: "无更新内容" }, { status: 400 });
  }

  const updated = await prisma.externalOrderInvoiceRequest.update({
    where: { id }, data,
    include: { items: { orderBy: { sortOrder: "asc" } }, createdBy: { select: { id: true, name: true } } },
  });

  await syncInvoiceAndCoverageOrders(id, invoice.externalOrderId, invoice.orderId);
  return NextResponse.json({ invoice: updated });
}
