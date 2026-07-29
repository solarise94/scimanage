import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getOrderScopeWhere } from "@/lib/orders/permissions";
import { ORDER_SOURCE } from "@/lib/orders/constants";
import { getInvoicesForOrder } from "@/lib/finance/order-invoices";
import { TsvLedgerExporter, finalReceivableCents, type LedgerExportRow } from "@/lib/orders/contract-ledger-export";

export const dynamic = "force-dynamic";

/**
 * GET /api/orders/export/contract-ledger?format=tsv
 * 导出合同台账 44 列 TSV。默认导出 source=CONTRACT_LEDGER 订单，
 * 也可用 ?source=ALL 导出全部可见订单（仅 ADMIN）。
 * 超过 EXPORT_ROW_CAP 行时截断，并在响应头 X-Export-Truncated 标记总数。
 */
const EXPORT_ROW_CAP = 20000;

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const format = searchParams.get("format") || "tsv";
  if (format !== "tsv") {
    return NextResponse.json({ error: "暂只支持 format=tsv（飞书导出 §11.3 预留）" }, { status: 400 });
  }
  const sourceParam = searchParams.get("source");
  const exportAll = sourceParam === "ALL";
  if (exportAll && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "仅管理员可导出全部订单" }, { status: 403 });
  }

  const scopeWhere = await getOrderScopeWhere(session.user.id, session.user.role, prisma, session.user.department);
  const where: Record<string, unknown> = {
    deleted: false,
  };
  if (!exportAll) where.source = ORDER_SOURCE.CONTRACT_LEDGER;
  const and: unknown[] = [];
  if (scopeWhere) and.push(scopeWhere);
  if (and.length > 0) where.AND = and;

  const totalCount = await prisma.order.count({ where });

  const orders = await prisma.order.findMany({
    where,
    select: {
      id: true,
      externalOrderNo: true,
      title: true,
      category: true,
      status: true,
      totalAmount: true,
      commissionPaid: true,
      quarterlyBonus: true,
      financeNote: true,
      orderedAt: true,
      deliveredAt: true,
      buyerOrgNameSnapshot: true,
      buyerNameSnapshot: true,
      projectLinks: {
        select: {
          isPrimary: true,
          project: {
            select: {
              projectNo: true,
              orderNumber: true,
              organization: true,
              client: true,
              representative: true,
              techSupport: true,
              projectType: true,
              projectContent: true,
              quantity: true,
              procurementSource: true,
              brand: true,
              status: true,
              startDate: true,
              deliveredAt: true,
              terminatedAt: true,
              budgetAmount: true,
              budgetCost: true,
              contractAttachments: { select: { fileName: true }, take: 1 },
            },
          },
        },
      },
      receipts: {
        where: { deleted: false },
        select: { amount: true, receivedAt: true, remark: true },
        orderBy: { receivedAt: "asc" },
      },
      financeCosts: {
        where: { costType: "PROJECT_COST" },
        select: { amount: true },
      },
    },
    orderBy: { externalOrderNo: "asc" },
    take: EXPORT_ROW_CAP,
  });

  // 使用统一发票聚合 helper，确保覆盖 OrderInvoiceCoverage / ExternalOrderInvoiceCoverage / direct 四种来源
  const orderInvoices = await Promise.all(
    orders.map(async (o) => ({ orderId: o.id, invoices: await getInvoicesForOrder(o.id) })),
  );
  const invoiceMap = new Map(orderInvoices.map((x) => [x.orderId, x.invoices]));

  const rows: LedgerExportRow[] = orders.map((o) => {
    const primaryLink = o.projectLinks.find((l) => l.isPrimary) ?? o.projectLinks[0];
    const proj = primaryLink?.project;
    // 父记录：非主关联（isPrimary=false）指向的项目编号
    const parentLink = o.projectLinks.find((l) => !l.isPrimary && l.project?.projectNo !== proj?.projectNo);
    const realCostCents = o.financeCosts.reduce((s, c) => s + c.amount, 0);
    // 有真实成本记录时用真实和（即使为 0）；无记录时回退预算成本
    const costCents = o.financeCosts.length > 0 ? realCostCents : (proj?.budgetCost ?? null);
    const amountCents = proj?.budgetAmount ?? o.totalAmount ?? null;
    const projType = proj?.projectType ?? o.category ?? null;
    // AN 总应收 = 项目金额；AO 交付应收 = 交付分期（统一走 export lib 的口径，避免分叉）
    const finalRecv = finalReceivableCents(amountCents, projType);
    const invoices = invoiceMap.get(o.id) ?? [];
    return {
      projectNo: o.externalOrderNo ?? proj?.projectNo ?? null,
      orderNumber: proj?.orderNumber ?? null,
      organization: proj?.organization ?? o.buyerOrgNameSnapshot ?? null,
      client: proj?.client ?? o.buyerNameSnapshot ?? null,
      representative: proj?.representative ?? null,
      techSupport: proj?.techSupport ?? null,
      projectType: projType,
      projectContent: proj?.projectContent ?? o.title ?? null,
      quantity: proj?.quantity ?? null,
      procurementSource: proj?.procurementSource ?? null,
      brand: proj?.brand ?? null,
      status: proj?.status ?? null,
      startDate: proj?.startDate ?? o.orderedAt ?? null,
      deliveredAt: proj?.deliveredAt ?? o.deliveredAt ?? null,
      terminatedAt: proj?.terminatedAt ?? null,
      projectAmountCents: amountCents,
      projectCostCents: costCents,
      commissionPaidCents: o.commissionPaid ?? null,
      quarterlyBonusCents: o.quarterlyBonus ?? null,
      remark: o.financeNote ?? null,
      receiptRemark: o.receipts[0]?.remark ?? null,
      sellerName: invoices.find((i) => i.sellerName)?.sellerName ?? null,
      buyerInvoiceOrgName: invoices[0]?.buyerOrganizationName ?? proj?.organization ?? o.buyerOrgNameSnapshot ?? null,
      invoices: invoices.map((i) => ({
        amountCents: i.allocatedAmount,
        issuedAt: i.actualIssuedAt,
        invoiceNo: i.actualInvoiceNo,
      })),
      receipts: o.receipts.map((r) => ({
        amountCents: r.amount,
        receivedAt: r.receivedAt,
        account: r.remark ?? null,
      })),
      totalReceivableCents: amountCents,
      finalReceivableCents: finalRecv,
      totalPayableCents: costCents,
      attachmentFileName: proj?.contractAttachments[0]?.fileName ?? null,
      parentProjectNo: parentLink?.project?.projectNo ?? null,
    };
  });

  const exporter = new TsvLedgerExporter();
  const out = exporter.export(rows);
  const truncated = totalCount > EXPORT_ROW_CAP;

  const headers: Record<string, string> = {
    "Content-Type": "text/tab-separated-values; charset=utf-8",
    "Content-Disposition": `attachment; filename="contract-ledger-${out.rowCount}rows.tsv"`,
    "X-Export-Total": String(totalCount),
  };
  if (truncated) {
    headers["X-Export-Truncated"] = `${out.rowCount}/${totalCount}`;
  }

  return new NextResponse(out.content ?? "", { status: 200, headers });
}
