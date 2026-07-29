import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { yuanToCents, centsToYuan } from "@/lib/finance/money";
import {
  isSupplyChainBlocked,
  getInquiryScopeWhere,
  assertOrderVisibleForSupplyChain,
} from "@/lib/supply-chain/permissions";
import { isValidInquiryStatus } from "@/lib/supply-chain/constants";
import { resolveActorDepartmentOrNull } from "@/lib/department";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isSupplyChainBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const supplierId = url.searchParams.get("supplierId")?.trim() || "";
  const orderId = url.searchParams.get("orderId")?.trim() || "";
  const status = url.searchParams.get("status")?.trim() || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));

  const andConditions: Record<string, unknown>[] = [];

  // 非 ADMIN：可见条件 = 关联订单在 Order scope 内 OR 同部门的无订单询价。
  // 设计 §6.5：Inquiry 按自身 departmentSnapshot 过滤；getInquiryScopeWhere
  // 已覆盖 orderId=null 的同部门询价，无需再 OR createdById（会放宽跨部门）。
  if (session.user.role !== "ADMIN") {
    const scopeWhere = await getInquiryScopeWhere(session.user.id, session.user.role, session.user.department);
    if (scopeWhere) andConditions.push(scopeWhere);
  }

  if (supplierId) andConditions.push({ supplierId });
  if (orderId) andConditions.push({ orderId });
  if (status) andConditions.push({ status });

  const where = andConditions.length === 1 ? andConditions[0] : { AND: andConditions };

  const [inquiries, total] = await Promise.all([
    prisma.supplierInquiry.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true } },
      },
      orderBy: { occurredAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.supplierInquiry.count({ where }),
  ]);

  const inquiriesYuan = inquiries.map((i) => ({
    ...i,
    targetPrice: i.targetPrice != null ? centsToYuan(i.targetPrice) : null,
    responsePrice: i.responsePrice != null ? centsToYuan(i.responsePrice) : null,
    finalPrice: i.finalPrice != null ? centsToYuan(i.finalPrice) : null,
  }));

  return NextResponse.json({
    inquiries: inquiriesYuan,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isSupplyChainBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const {
    supplierId, orderId, orderLineId, quoteId,
    requestedItem, requestedSpec, quantity,
    targetPrice, contactMethod, note, rawText,
  } = body as Record<string, unknown>;

  if (!supplierId) return NextResponse.json({ error: "supplierId 必填" }, { status: 400 });
  if (!requestedItem) return NextResponse.json({ error: "requestedItem 必填" }, { status: 400 });

  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId as string } });
  if (!supplier) return NextResponse.json({ error: "供应商不存在" }, { status: 400 });

  // ── 关联资源校验（防越权绑定）──────────────────────────────────
  // orderId：非 ADMIN 必须在用户 scope 内。表单当前不传 orderId，
  // 但 API 可被直接调用，USER 可借 createdById=自己 维护一条越权关联。
  let resolvedOrderId = (orderId as string) || null;
  let resolvedOrderDepartment: string | null = null;
  if (resolvedOrderId) {
    const visible = await assertOrderVisibleForSupplyChain(session.user.id, session.user.role, resolvedOrderId, session.user.department);
    if (!visible) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const ord = await prisma.order.findUnique({
      where: { id: resolvedOrderId },
      select: { departmentSnapshot: true },
    });
    if (!ord) return NextResponse.json({ error: "订单不存在" }, { status: 400 });
    resolvedOrderDepartment = ord.departmentSnapshot;
  }

  // orderLineId：如果同时传了 orderId，必须属于该订单；否则校验存在性并回填 orderId。
  // 不回填会产生「有关联订单行但没有关联订单」的询价，导致订单 scope 和订单筛选无法覆盖。
  const orderLineIdStr = (orderLineId as string) || null;
  if (orderLineIdStr) {
    const ol = await prisma.orderLine.findUnique({
      where: { id: orderLineIdStr },
      select: { orderId: true },
    });
    if (!ol) return NextResponse.json({ error: "订单行不存在" }, { status: 400 });
    if (resolvedOrderId && ol.orderId !== resolvedOrderId) {
      return NextResponse.json({ error: "订单行不属于该订单" }, { status: 400 });
    }
    // orderLine 反查出的订单也必须在 scope 内（orderId 为空时补校验）
    if (!resolvedOrderId) {
      const visible = await assertOrderVisibleForSupplyChain(session.user.id, session.user.role, ol.orderId, session.user.department);
      if (!visible) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      // 回填：只传 orderLineId 时，用订单行的 orderId 落库，保证订单维度可查
      resolvedOrderId = ol.orderId;
      const ord = await prisma.order.findUnique({
        where: { id: resolvedOrderId },
        select: { departmentSnapshot: true },
      });
      if (!ord) return NextResponse.json({ error: "订单不存在" }, { status: 400 });
      resolvedOrderDepartment = ord.departmentSnapshot;
    }
  }

  // quoteId：必须属于所选 supplierId。
  const quoteIdStr = (quoteId as string) || null;
  if (quoteIdStr) {
    const quote = await prisma.supplierQuote.findUnique({
      where: { id: quoteIdStr },
      select: { supplierId: true },
    });
    if (!quote) return NextResponse.json({ error: "报价不存在" }, { status: 400 });
    if (quote.supplierId !== supplierId) {
      return NextResponse.json({ error: "报价不属于该供应商" }, { status: 400 });
    }
  }

  // 部门归属快照解析（设计 §4.2 表 / §7.2）：
  // 有关联订单继承订单部门；无订单时取 actor 部门。
  // 设计 §7.3：Inquiry 关联 Order 时同部门（scope 已含，ADMIN 也校验落值一致）。
  // Fail-closed（设计 §6.1）：actor 部门无法权威解析时拒绝写入（400），
  // 不静默降级 FIELD_SALES（否则会创建错误部门的询价快照）。
  let inquiryDepartment: string;
  if (resolvedOrderDepartment) {
    inquiryDepartment = resolvedOrderDepartment;
  } else {
    const creatorDept = await resolveActorDepartmentOrNull(session.user.id);
    if (!creatorDept) {
      return NextResponse.json({ error: "无法解析当前用户部门" }, { status: 400 });
    }
    inquiryDepartment = creatorDept;
  }

  const inquiry = await prisma.supplierInquiry.create({
    data: {
      supplierId: supplierId as string,
      orderId: resolvedOrderId,
      orderLineId: orderLineIdStr,
      quoteId: quoteIdStr,
      departmentSnapshot: inquiryDepartment,
      status: "OPEN",
      requestedItem: requestedItem as string,
      requestedSpec: (requestedSpec as string) || null,
      quantity: quantity != null ? Number(quantity) : null,
      targetPrice: targetPrice != null ? yuanToCents(Number(targetPrice)) : null,
      contactMethod: (contactMethod as string) || null,
      note: (note as string) || null,
      rawText: (rawText as string) || null,
      createdById: session.user.id,
    },
  });

  return NextResponse.json({
    inquiry: {
      ...inquiry,
      targetPrice: inquiry.targetPrice != null ? centsToYuan(inquiry.targetPrice) : null,
    },
  }, { status: 201 });
}
