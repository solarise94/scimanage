import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { businessActorFromSessionUser } from "@/lib/application/actor";
import { ApplicationError } from "@/lib/application/errors";
import {
  assertOrderInvoiceListRouteRole,
  queryOrderInvoicesForActor,
} from "@/lib/finance/application/query-order-invoices";
import { prepareInvoiceDraftForActor } from "@/lib/finance/application/prepare-invoice-draft";
import { centsToYuan, yuanToCents } from "@/lib/finance/money";
import { prisma } from "@/lib/prisma";
import { mapOrderInvoiceRequestWriteError } from "@/lib/finance/order-invoice-request-write";

export async function GET(req: NextRequest) {
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

  const url = req.nextUrl;
  const search = url.searchParams.get("search")?.trim() || "";
  const status = url.searchParams.get("status")?.trim() || "";
  const hasRedAdjustment = (url.searchParams.get("hasRedAdjustment")?.trim() || "") as
    | ""
    | "true"
    | "false";
  const missingActualInvoiceNo = (url.searchParams.get("missingActualInvoiceNo")?.trim() || "") as
    | ""
    | "true";
  const orderId = url.searchParams.get("orderId")?.trim() || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));

  const actor = businessActorFromSessionUser(session.user);

  try {
    const result = await queryOrderInvoicesForActor(actor, {
      search: search || undefined,
      status: status || undefined,
      hasRedAdjustment,
      missingActualInvoiceNo,
      orderId: orderId || undefined,
      page,
      pageSize,
    });

    return NextResponse.json({
      invoices: result.invoices.map((inv) => ({
        ...inv,
        totalAmount: centsToYuan(inv.totalAmount),
        items: inv.items.map((it) => ({ ...it, amount: centsToYuan(it.amount) })),
        orderCoverage: inv.orderCoverage.map((c) => ({ ...c, amount: centsToYuan(c.amount) })),
      })),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
    });
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }
}

export async function POST(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const {
    orderId, coverageAllocations,
    contactName, sellerProfileId,
    sellerName,
    buyerOrganizationId, buyerOrganizationName, buyerTaxId,
    invoiceType, contentSummary, remark, items, taxIdFromLookup,
    allowCrossOrgInvoice,
  } = body as Record<string, unknown>;

  if (!orderId || typeof orderId !== "string") {
    return NextResponse.json({ error: "orderId is required" }, { status: 400 });
  }

  // 解析 coverageAllocations（新契约）
  const rawAllocations = Array.isArray(coverageAllocations) ? coverageAllocations : [];
  const parsedAllocations: Array<{ orderId: string; amountCents: number }> = [];
  for (const a of rawAllocations) {
    if (!a || typeof a !== "object") continue;
    const oid = (a as Record<string, unknown>).orderId;
    const amt = (a as Record<string, unknown>).amountCents;
    if (typeof oid !== "string" || typeof amt !== "number" || !Number.isFinite(amt) || amt <= 0) {
      return NextResponse.json({ error: "coverageAllocations 每项需包含 orderId 与正整数 amountCents" }, { status: 400 });
    }
    parsedAllocations.push({ orderId: oid, amountCents: Math.round(amt) });
  }

  const itemRows = (Array.isArray(items) ? items : []).filter((it: Record<string, unknown>) => (it.itemName as string)?.trim());
  const totalAmount = itemRows.reduce((sum: number, it: Record<string, unknown>) => sum + yuanToCents(Number(it.amount) || 0), 0);
  if (totalAmount <= 0) {
    return NextResponse.json({ error: "发票金额必须大于 0" }, { status: 400 });
  }

  if (!buyerOrganizationName || !(buyerOrganizationName as string).trim()) {
    return NextResponse.json({ error: "对方公司名称不能为空" }, { status: 400 });
  }

  try {
    const result = await prepareInvoiceDraftForActor(
      businessActorFromSessionUser(session.user),
      {
        mainOrderId: orderId,
        coverageAllocations: parsedAllocations,
        buyerOrganizationId: (buyerOrganizationId as string) || null,
        buyerOrganizationName: (buyerOrganizationName as string).trim(),
        buyerTaxId: (buyerTaxId as string)?.trim() || null,
        buyerTaxIdFromLookup: !!taxIdFromLookup,
        sellerProfileId: (sellerProfileId as string) || null,
        sellerName: (sellerName as string)?.trim() || null,
        invoiceType: invoiceType === "SPECIAL" ? "SPECIAL" : "NORMAL",
        contactName: (contactName as string)?.trim() || null,
        contentSummary: (contentSummary as string)?.trim() || null,
        remark: (remark as string)?.trim() || null,
        items: itemRows.map((it: Record<string, unknown>) => ({
          itemName: (it.itemName as string).trim(),
          spec: (it.spec as string)?.trim() || null,
          unit: (it.unit as string)?.trim() || null,
          quantity: it.quantity != null ? Number(it.quantity) : null,
          amountCents: yuanToCents(Number(it.amount) || 0),
        })),
        allowCrossOrgInvoice: !!allowCrossOrgInvoice,
      },
    );

    // 重新读取完整记录用于响应
    const full = await prisma.externalOrderInvoiceRequest.findUnique({
      where: { id: result.invoice.id },
      include: {
        items: { orderBy: { sortOrder: "asc" } },
        createdBy: { select: { id: true, name: true } },
        orderCoverage: { include: { order: { select: { id: true, orderNo: true } } } },
      },
    });

    if (!full) {
      return NextResponse.json({ invoice: { ...result.invoice, totalAmount: centsToYuan(result.invoice.totalAmount), items: [] } }, { status: 201 });
    }

    return NextResponse.json({
      invoice: {
        ...full,
        totalAmount: centsToYuan(full.totalAmount),
        items: full.items.map((it) => ({ ...it, amount: centsToYuan(it.amount) })),
        orderCoverage: full.orderCoverage.map((c) => ({ ...c, amount: centsToYuan(c.amount) })),
      },
    }, { status: 201 });
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.httpStatus });
    }
    const mapped = mapOrderInvoiceRequestWriteError(err);
    if (mapped) {
      return NextResponse.json(mapped.body, { status: mapped.status });
    }
    throw err;
  }
}
