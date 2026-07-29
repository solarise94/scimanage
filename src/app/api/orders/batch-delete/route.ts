import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface SkippedEntry {
  orderId: string;
  orderNo: string;
  reason: string;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const rawIds = body.orderIds as string[];

  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return NextResponse.json({ error: "orderIds must be a non-empty array" }, { status: 400 });
  }

  if (rawIds.length > 200) {
    return NextResponse.json({ error: "一次最多删除 200 条订单" }, { status: 400 });
  }

  const orderIds = [...new Set(rawIds)];

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: {
      id: true,
      orderNo: true,
      deleted: true,
      legacyExternalOrderId: true,
      invoiceRequests: {
        where: { status: { not: "CANCELLED" } },
        select: { id: true, status: true },
      },
      invoiceCoverage: {
        where: { invoiceRequest: { status: { not: "CANCELLED" } } },
        select: { id: true },
      },
      receipts: { where: { deleted: false }, select: { id: true } },
      financeCosts: { select: { id: true } },
    },
  });

  const foundIds = new Set(orders.map((o) => o.id));
  const skipped: SkippedEntry[] = [];

  // Missing IDs
  for (const id of orderIds) {
    if (!foundIds.has(id)) {
      skipped.push({ orderId: id, orderNo: id, reason: "订单不存在或已不可用" });
    }
  }

  // Collect legacy externalOrderIds for batch lookup
  const legacyIds = orders
    .filter((o) => o.legacyExternalOrderId)
    .map((o) => o.legacyExternalOrderId!);

  // Batch-check legacy invoice chains
  const legacyDirectInvoices: Map<string, string> = new Map(); // order.id → statuses
  const legacyCoverageInvoices: Map<string, string> = new Map();

  if (legacyIds.length > 0) {
    const legacyDirects = await prisma.externalOrderInvoiceRequest.findMany({
      where: { externalOrderId: { in: legacyIds }, status: { not: "CANCELLED" } },
      select: { externalOrderId: true, status: true },
    });

    const legacyIdToOrderId = new Map<string, string>();
    for (const o of orders) {
      if (o.legacyExternalOrderId) legacyIdToOrderId.set(o.legacyExternalOrderId, o.id);
    }

    for (const row of legacyDirects) {
      if (!row.externalOrderId) continue;
      const oid = legacyIdToOrderId.get(row.externalOrderId);
      if (oid) {
        const prev = legacyDirectInvoices.get(oid) || "";
        legacyDirectInvoices.set(oid, prev ? `${prev}, ${row.status}` : row.status);
      }
    }

    const legacyCovs = await prisma.externalOrderInvoiceCoverage.findMany({
      where: {
        externalOrderId: { in: legacyIds },
        invoiceRequest: { status: { not: "CANCELLED" } },
      },
      select: { externalOrderId: true, invoiceRequest: { select: { status: true } } },
    });

    for (const row of legacyCovs) {
      if (!row.externalOrderId) continue;
      const oid = legacyIdToOrderId.get(row.externalOrderId);
      if (oid) {
        const prev = legacyCoverageInvoices.get(oid) || "";
        legacyCoverageInvoices.set(oid, prev ? `${prev}, ${row.invoiceRequest.status}` : row.invoiceRequest.status);
      }
    }
  }

  const deletable: string[] = [];

  for (const o of orders) {
    if (o.deleted) {
      skipped.push({ orderId: o.id, orderNo: o.orderNo, reason: "已删除" });
      continue;
    }
    if (o.invoiceRequests.length > 0) {
      const statuses = o.invoiceRequests.map((r) => r.status).join(", ");
      skipped.push({ orderId: o.id, orderNo: o.orderNo, reason: `存在未取消的开票申请 (${statuses})` });
      continue;
    }
    if (o.invoiceCoverage.length > 0) {
      skipped.push({ orderId: o.id, orderNo: o.orderNo, reason: "存在有效发票覆盖记录" });
      continue;
    }
    if (legacyDirectInvoices.has(o.id)) {
      skipped.push({ orderId: o.id, orderNo: o.orderNo, reason: `存在 legacy 开票申请 (${legacyDirectInvoices.get(o.id)})` });
      continue;
    }
    if (legacyCoverageInvoices.has(o.id)) {
      skipped.push({ orderId: o.id, orderNo: o.orderNo, reason: `存在 legacy 发票覆盖记录 (${legacyCoverageInvoices.get(o.id)})` });
      continue;
    }
    if (o.receipts.length > 0) {
      skipped.push({ orderId: o.id, orderNo: o.orderNo, reason: "存在回款记录" });
      continue;
    }
    if (o.financeCosts.length > 0) {
      skipped.push({ orderId: o.id, orderNo: o.orderNo, reason: "存在成本记录" });
      continue;
    }
    deletable.push(o.id);
  }

  if (deletable.length > 0) {
    await prisma.order.updateMany({
      where: { id: { in: deletable } },
      data: {
        deleted: true,
        deletedAt: new Date(),
        archived: true,
        financeTreatment: "EXCLUDED",
      },
    });
  }

  return NextResponse.json({
    deletedCount: deletable.length,
    skipped,
  });
}
