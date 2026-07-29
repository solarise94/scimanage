import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { isFinanceBlocked } from "@/lib/finance/permissions";
import { getOrderScopeWhere } from "@/lib/orders/permissions";
import { getTodayLocalDateInput } from "@/lib/finance/date-input";
import { prisma } from "@/lib/prisma";
import { centsToYuan } from "@/lib/finance/money";

function escapeCsv(value: unknown): string {
  const str = value == null ? "" : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function GET(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (isFinanceBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const search = url.searchParams.get("search")?.trim();
  const hasAllocations = url.searchParams.get("hasAllocations") === "1";

  const andConditions: Record<string, unknown>[] = [{ deleted: false }];

  if (search) {
    andConditions.push({
      OR: [
        { customer: { crmProfile: { name: { contains: search } } } },
        { order: { orderNo: { contains: search } } },
        { order: { externalOrderNo: { contains: search } } },
      ],
    });
  }

  if (hasAllocations) {
    andConditions.push({ allocations: { some: {} } });
  }

  // Scope for non-ADMIN.
  // Allocation-based receipts are only exported when EVERY allocation order
  // is in scope, matching the list/detail API semantics.
  if (session.user.role !== "ADMIN") {
    const orderScope = await getOrderScopeWhere(session.user.id, session.user.role, prisma, session.user.department);
    if (!orderScope) {
      return new Response("到款日期,回款金额,来源,客户,订单号,发票号,核销发票数,核销明细,备注\n", {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=receipts.csv",
        },
      });
    }
    const scopedOrders = await prisma.order.findMany({
      where: orderScope,
      select: { id: true },
    });
    const scopedOrderIds = scopedOrders.map((o) => o.id);
    if (scopedOrderIds.length === 0) {
      return new Response("到款日期,回款金额,来源,客户,订单号,发票号,核销发票数,核销明细,备注\n", {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=receipts.csv",
        },
      });
    }
    andConditions.push({
      OR: [
        // Legacy 1-to-1 receipt: direct orderId in scope and no allocations.
        { orderId: { in: scopedOrderIds }, allocations: { none: {} } },
        // Allocation-based receipt: every allocation order must be in scope.
        {
          allocations: { some: {} },
          NOT: {
            allocations: { some: { orderId: { notIn: scopedOrderIds } } },
          },
        },
      ],
    });
  }

  const where = andConditions.length === 1 ? andConditions[0] : { AND: andConditions };

  const receipts = await prisma.financeReceipt.findMany({
    where,
    orderBy: { receivedAt: "desc" },
    select: {
      receivedAt: true,
      amount: true,
      source: true,
      remark: true,
      profile: { select: { name: true } },
      order: { select: { orderNo: true } },
      externalOrderInvoiceRequest: { select: { actualInvoiceNo: true } },
      allocations: {
        select: {
          amount: true,
          invoice: { select: { actualInvoiceNo: true } },
          order: { select: { orderNo: true } },
        },
      },
    },
  });

  const SOURCE_LABELS: Record<string, string> = {
    MANUAL: "人工录入",
    BANK: "银行转账",
    PINGOODMICE_ORDER: "平台订单",
    OTHER: "其他",
  };

  function uniqueJoin(values: (string | null | undefined)[], sep = "; "): string {
    return [...new Set(values.filter((v): v is string => !!v))].join(sep);
  }

  const BOM = "\uFEFF";
  const header = ["到款日期", "回款金额", "来源", "客户", "订单号", "发票号", "核销发票数", "核销明细", "备注"];
  const rows = receipts.map((r) => {
    const orderNo = r.order?.orderNo || uniqueJoin(r.allocations.map((a) => a.order?.orderNo));
    const invoiceNo = r.externalOrderInvoiceRequest?.actualInvoiceNo || uniqueJoin(r.allocations.map((a) => a.invoice?.actualInvoiceNo));
    const allocationDetail = r.allocations.length > 0
      ? uniqueJoin(
          r.allocations.map((a) =>
            `${a.order?.orderNo || "-"}/${a.invoice?.actualInvoiceNo || "-"}:${centsToYuan(a.amount)}`,
          ),
        )
      : "";
    return [
      new Date(r.receivedAt).toLocaleDateString("zh-CN"),
      centsToYuan(r.amount),
      SOURCE_LABELS[r.source] || r.source,
      r.profile?.name || "",
      orderNo,
      invoiceNo,
      r.allocations.length,
      allocationDetail,
      r.remark || "",
    ];
  });

  const csv = BOM + [header, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=receipts-${getTodayLocalDateInput()}.csv`,
    },
  });
}
