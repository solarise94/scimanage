import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { prisma } from "@/lib/prisma";
import { yuanToCents, centsToYuan } from "@/lib/finance/money";
import {
  isSupplierPaymentBlocked,
  getSupplierPaymentScopeWhere,
} from "@/lib/finance/supplier-permissions";
import { registerSupplierPayment, PaymentError } from "@/lib/finance/supplier-payments";

export async function GET(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (isSupplierPaymentBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const supplierId = url.searchParams.get("supplierId")?.trim() || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));

  const andConditions: Record<string, unknown>[] = [];

  if (session.user.role !== "ADMIN") {
    const scopeWhere = await getSupplierPaymentScopeWhere(session.user.id, session.user.role, session.user.department);
    // 设计 §6.5：FinancePayment 按自身 departmentSnapshot 过滤。
    if (scopeWhere) andConditions.push(scopeWhere);
  }

  if (supplierId) andConditions.push({ supplierId });

  const where = andConditions.length === 1 ? andConditions[0] : { AND: andConditions };

  const [payments, total] = await Promise.all([
    prisma.financePayment.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true } },
        allocations: {
          include: {
            payable: { select: { id: true, amount: true, orderId: true } },
          },
        },
      },
      orderBy: { paidAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.financePayment.count({ where }),
  ]);

  return NextResponse.json({
    payments: payments.map((p) => ({
      ...p,
      amount: centsToYuan(p.amount),
      allocations: p.allocations.map((a) => ({
        ...a,
        amount: centsToYuan(a.amount),
        payable: a.payable ? { ...a.payable, amount: centsToYuan(a.payable.amount) } : null,
      })),
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
}

/**
 * POST — 登记一笔供应商付款并分摊到多笔应付。
 * body: { supplierId, amount, paidAt?, method?, voucherNo?, voucherUrl?, remark?, allocations: [{ payableId, amount }] }
 */
export async function POST(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const {
    supplierId, amount, paidAt, method, voucherNo, voucherUrl, remark, allocations,
  } = body as Record<string, unknown>;

  if (!supplierId) return NextResponse.json({ error: "supplierId 必填" }, { status: 400 });
  if (amount == null || Number(amount) <= 0) {
    return NextResponse.json({ error: "付款金额必须为正数" }, { status: 400 });
  }
  if (!Array.isArray(allocations) || allocations.length === 0) {
    return NextResponse.json({ error: "分摊明细必填" }, { status: 400 });
  }

  // 转换分摊金额
  const normalizedAllocations = allocations.map((a) => {
    const item = a as Record<string, unknown>;
    return {
      payableId: item.payableId as string,
      amount: yuanToCents(Number(item.amount)),
    };
  });

  try {
    const result = await registerSupplierPayment({
      supplierId: supplierId as string,
      amount: yuanToCents(Number(amount)),
      paidAt: paidAt ? new Date(paidAt as string) : undefined,
      method: (method as string) || undefined,
      voucherNo: (voucherNo as string) || undefined,
      voucherUrl: (voucherUrl as string) || undefined,
      remark: (remark as string) || undefined,
      allocations: normalizedAllocations,
      actorUserId: session.user.id,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof PaymentError) {
      const statusMap: Record<string, number> = {
        OVER_ALLOCATED: 400,
        NOT_FOUND: 404,
        SUPPLIER_MISMATCH: 400,
        PAYABLE_CANCELLED: 400,
        // 设计 §7.3：跨部门分摊被拒
        DEPARTMENT_MISMATCH: 409,
      };
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: statusMap[e.code] ?? 400 },
      );
    }
    throw e;
  }
}
