import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isRepresentative } from "@/lib/permissions";
import { centsToYuan } from "@/lib/finance/money";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isRepresentative(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const search = url.searchParams.get("search")?.trim() || "";
  const platform = url.searchParams.get("platform")?.trim() || "";
  const invoiceStatus = url.searchParams.get("invoiceStatus")?.trim() || "";
  const duplicateStatus = url.searchParams.get("duplicateStatus")?.trim() || "";
  const customerMatchStatus = url.searchParams.get("customerMatchStatus")?.trim() || "";
  const dateFrom = url.searchParams.get("dateFrom")?.trim() || "";
  const dateTo = url.searchParams.get("dateTo")?.trim() || "";
  const exportAll = url.searchParams.get("exportAll") === "1";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = exportAll ? undefined : Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));

  const where: Record<string, unknown> = {};

  if (search) {
    where.OR = [
      { externalOrderNo: { contains: search } },
      { receiverName: { contains: search } },
      { receiverPhone: { contains: search } },
      { productNamesRaw: { contains: search } },
      { receiverAddress: { contains: search } },
    ];
  }
  if (platform) where.platform = platform;
  if (invoiceStatus) where.invoiceStatus = invoiceStatus;
  if (duplicateStatus) where.duplicateStatus = duplicateStatus;
  if (customerMatchStatus) where.customerMatchStatus = customerMatchStatus;
  if (dateFrom || dateTo) {
    const orderAtFilter: Record<string, Date> = {};
    if (dateFrom) orderAtFilter.gte = new Date(dateFrom);
    if (dateTo) orderAtFilter.lte = new Date(dateTo + "T23:59:59.999Z");
    where.orderAt = orderAtFilter;
  }

  const [orders, total] = await Promise.all([
    prisma.externalOrder.findMany({
      where,
      orderBy: [{ orderAt: "desc" }, { createdAt: "desc" }],
      ...(exportAll ? {} : { skip: (page - 1) * pageSize!, take: pageSize }),
      select: {
        id: true, source: true, platform: true, externalOrderNo: true,
        storeName: true, receiverName: true, receiverPhone: true,
        productNamesRaw: true, itemCount: true, paidAmount: true,
        orderAt: true, invoiceStatus: true, createdAt: true,
        duplicateStatus: true, duplicateGroupId: true, mergedIntoId: true,
        // Profile-only：不再读 customerId 旧列与 Customer→crmProfile 反查；customer DTO 恒 null
        customerMatchStatus: true, customerMatchScore: true, customerMatchReason: true,
        orderUser: true, receiverAddress: true,
        financeCategory: true, financeTreatment: true, financeAmountOverride: true,
        projectId: true, project: { select: { id: true, name: true } },
      },
    }),
    prisma.externalOrder.count({ where }),
  ]);

  return NextResponse.json({
    orders: orders.map((o) => ({
      ...o,
      customer: null,
      paidAmount: o.paidAmount != null ? centsToYuan(o.paidAmount) : null,
      financeAmountOverride: o.financeAmountOverride != null ? centsToYuan(o.financeAmountOverride) : null,
    })),
    total, page, pageSize,
  });
}
