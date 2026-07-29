import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { prisma } from "@/lib/prisma";
import { yuanToCents, centsToYuan } from "@/lib/finance/money";
import {
  isSupplierPaymentBlocked,
  getSupplierPaymentScopeWhere,
} from "@/lib/finance/supplier-permissions";
import { isValidPayableStatus } from "@/lib/finance/supplier-finance-constants";
import { resolveActorDepartmentOrNull } from "@/lib/department";

export async function GET(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (isSupplierPaymentBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const supplierId = url.searchParams.get("supplierId")?.trim() || "";
  const orderId = url.searchParams.get("orderId")?.trim() || "";
  const status = url.searchParams.get("status")?.trim() || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));

  const andConditions: Record<string, unknown>[] = [];

  if (session.user.role !== "ADMIN") {
    const scopeWhere = await getSupplierPaymentScopeWhere(session.user.id, session.user.role, session.user.department);
    if (scopeWhere) andConditions.push(scopeWhere);
  }

  if (supplierId) andConditions.push({ supplierId });
  if (orderId) andConditions.push({ orderId });
  if (status) andConditions.push({ status });

  const where = andConditions.length === 1 ? andConditions[0] : { AND: andConditions };

  const [payables, total] = await Promise.all([
    prisma.financePayable.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true } },
        order: { select: { id: true, orderNo: true, title: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.financePayable.count({ where }),
  ]);

  return NextResponse.json({
    payables: payables.map((p) => ({
      ...p,
      amount: centsToYuan(p.amount),
      paidAmount: centsToYuan(p.paidAmount),
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
}

export async function POST(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { supplierId, orderId, projectId, amount, dueAt, note } = body as Record<string, unknown>;

  if (!supplierId) return NextResponse.json({ error: "supplierId 必填" }, { status: 400 });
  if (amount == null || Number(amount) <= 0) {
    return NextResponse.json({ error: "金额必须为正数" }, { status: 400 });
  }

  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId as string } });
  if (!supplier) return NextResponse.json({ error: "供应商不存在" }, { status: 400 });

  // 部门归属快照解析（设计 §4.2 / §7.2）：
  // 有关联订单继承订单部门；否则取 actor 部门。
  // Fail-closed（设计 §6.1）：actor 部门无法权威解析时拒绝写入（400），
  // 不静默降级 FIELD_SALES（否则会创建错误部门的应付快照）。
  let payableDepartment: string;
  const resolvedOrderId = (orderId as string) || null;
  if (resolvedOrderId) {
    const ord = await prisma.order.findUnique({
      where: { id: resolvedOrderId },
      select: { departmentSnapshot: true },
    });
    if (!ord) return NextResponse.json({ error: "订单不存在" }, { status: 400 });
    payableDepartment = ord.departmentSnapshot;
  } else {
    const creatorDept = await resolveActorDepartmentOrNull(session.user.id);
    if (!creatorDept) {
      return NextResponse.json({ error: "无法解析当前用户部门" }, { status: 400 });
    }
    payableDepartment = creatorDept;
  }

  const payable = await prisma.financePayable.create({
    data: {
      supplierId: supplierId as string,
      orderId: resolvedOrderId,
      projectId: (projectId as string) || null,
      amount: yuanToCents(Number(amount)),
      paidAmount: 0,
      status: "UNPAID",
      dueAt: dueAt ? new Date(dueAt as string) : null,
      note: (note as string) || null,
      departmentSnapshot: payableDepartment,
      sourceType: "MANUAL",
      sourceKey: `manual:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdById: session.user.id,
    },
    include: {
      supplier: { select: { id: true, name: true } },
    },
  });

  return NextResponse.json({
    payable: {
      ...payable,
      amount: centsToYuan(payable.amount),
      paidAmount: centsToYuan(payable.paidAmount),
    },
  }, { status: 201 });
}
