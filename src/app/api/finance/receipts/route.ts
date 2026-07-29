import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { isFinanceBlocked } from "@/lib/finance/permissions";
import { getOrderScopeWhere } from "@/lib/orders/permissions";
import { buildReceivedAtDayRange, parseReceivedAtInput } from "@/lib/finance/receipt-date";
import { prisma } from "@/lib/prisma";
import { yuanToCents, centsToYuan } from "@/lib/finance/money";
import { ApplicationError } from "@/lib/application/errors";
import {
  AllocationReceiptError,
  createReceiptForActor,
} from "@/lib/finance/application/create-receipt";
import {
  ReceiptMissingProfileError,
  requireOrderProfileIdForReceipt,
} from "@/lib/finance/receipt-profile";

async function resolveOrderAndCheckScope(
  userId: string,
  role: string,
  department: string,
  orderId: string,
): Promise<{ valid: boolean; profileId: string | null }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, profileId: true },
  });
  if (!order) return { valid: false, profileId: null };

  if (role === "ADMIN") return { valid: true, profileId: order.profileId };

  const orderScope = await getOrderScopeWhere(userId, role, prisma, department);
  if (!orderScope) return { valid: false, profileId: null };
  const inScope = await prisma.order.count({ where: { id: orderId, AND: [orderScope] } });
  if (inScope === 0) return { valid: false, profileId: null };

  return { valid: true, profileId: order.profileId };
}

export async function GET(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (isFinanceBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const orderId = url.searchParams.get("orderId")?.trim();
  const profileId = url.searchParams.get("profileId")?.trim();
  const projectId = url.searchParams.get("projectId")?.trim();
  const source = url.searchParams.get("source")?.trim();
  const dateFrom = url.searchParams.get("dateFrom")?.trim();
  const dateTo = url.searchParams.get("dateTo")?.trim();
  const search = url.searchParams.get("search")?.trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));
  const includeDeleted = url.searchParams.get("includeDeleted") === "1" && session.user.role === "ADMIN";
  const deletedOnly = url.searchParams.get("deletedOnly") === "1" && session.user.role === "ADMIN";
  const hasAllocations = url.searchParams.get("hasAllocations") === "1";
  const unassignedOnly = url.searchParams.get("unassignedOnly") === "1";

  // 旧 *CustomerId 系查询参数一律 400（键名枚举，避免在源码里引用已废弃契约）。
  const legacyKey = [...url.searchParams.keys()].find((k) => /customerids?$/i.test(k));
  if (legacyKey) {
    return NextResponse.json({ error: `请使用 profileId（不再接受 ${legacyKey}）` }, { status: 400 });
  }
  if (unassignedOnly && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // If projectId is passed, resolve to order IDs via OrderProjectLink
  let resolvedOrderIds: string[] | null = null;
  if (projectId) {
    const links = await prisma.orderProjectLink.findMany({
      where: { projectId },
      select: { orderId: true },
    });
    resolvedOrderIds = links.map((l) => l.orderId);
    if (resolvedOrderIds.length === 0) {
      resolvedOrderIds = ["__NO_MATCH__"];
    }
  }

  if (session.user.role !== "ADMIN") {
    // Validate specific ID filters against scope
    if (orderId) {
      const { valid } = await resolveOrderAndCheckScope(session.user.id, session.user.role, session.user.department, orderId);
      if (!valid) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const andConditions: Record<string, unknown>[] = [];
  // Filters for specific orders must cover both legacy 1-to-1 AND allocation-based
  // receipts (which have orderId=NULL but allocations.some.orderId = X).
  if (orderId) {
    andConditions.push({
      OR: [
        { orderId },
        { allocations: { some: { orderId } } },
      ],
    });
  }
  if (profileId) {
    andConditions.push({
      OR: [
        { profileId },
        { allocations: { some: { order: { profileId } } } },
      ],
    });
  }
  if (resolvedOrderIds) {
    andConditions.push({
      OR: [
        { orderId: { in: resolvedOrderIds } },
        { allocations: { some: { orderId: { in: resolvedOrderIds } } } },
      ],
    });
  }
  if (source) andConditions.push({ source });
  if (search) {
    andConditions.push({
      OR: [
        { profile: { name: { contains: search } } },
        { order: { orderNo: { contains: search } } },
        { order: { externalOrderNo: { contains: search } } },
      ],
    });
  }
  if (dateFrom || dateTo) {
    try {
      const receivedAtFilter = buildReceivedAtDayRange(dateFrom, dateTo);
      andConditions.push({ receivedAt: receivedAtFilter });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Invalid date";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  // Non-ADMIN: scope by order visibility.
  // Must cover both legacy 1-to-1 (receipt.orderId) and allocation-based
  // receipts (receipt.orderId=NULL but allocations.some.orderId in scope).
  // Allocation-based receipts are only visible when EVERY allocation order
  // is in scope, matching the detail API semantics.
  if (session.user.role !== "ADMIN") {
    if (orderId) {
      const { valid } = await resolveOrderAndCheckScope(session.user.id, session.user.role, session.user.department, orderId);
      if (!valid) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const orderScope = await getOrderScopeWhere(session.user.id, session.user.role, prisma, session.user.department);
    if (!orderScope) return NextResponse.json({ receipts: [], total: 0, page, pageSize });

    const scopedOrders = await prisma.order.findMany({
      where: orderScope,
      select: { id: true },
    });
    const scopedOrderIds = scopedOrders.map((o) => o.id);
    if (scopedOrderIds.length === 0) return NextResponse.json({ receipts: [], total: 0, page, pageSize });

    andConditions.push({
      OR: [
        // Legacy 1-to-1 receipt: the direct orderId is in scope and there are no allocations.
        { orderId: { in: scopedOrderIds }, allocations: { none: {} } },
        // Allocation-based receipt: EVERY allocation order must be in scope.
        {
          allocations: { some: {} },
          NOT: {
            allocations: { some: { orderId: { notIn: scopedOrderIds } } },
          },
        },
      ],
    });
  }

  // Voucher filter: only receipts with allocations
  if (hasAllocations) {
    andConditions.push({ allocations: { some: {} } });
  }

  // Unassigned filter: receipts not linked to any order (direct or via allocations)
  if (unassignedOnly) {
    andConditions.push({
      AND: [{ orderId: null }, { allocations: { none: {} } }],
    });
  }

  // Deletion filter: non-ADMIN always sees only non-deleted; ADMIN can toggle
  if (deletedOnly) {
    andConditions.push({ deleted: true });
  } else if (!includeDeleted) {
    andConditions.push({ deleted: false });
  }

  const where: Record<string, unknown> = andConditions.length === 1
    ? andConditions[0]
    : (andConditions.length > 0 ? { AND: andConditions } : {});

  const [receipts, total] = await Promise.all([
    prisma.financeReceipt.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        amount: true,
        orderId: true,
        receivedAt: true,
        source: true,
        remark: true,
        deleted: true,
        deletedAt: true,
        deletedById: true,
        deleteReason: true,
        profileId: true,
        profile: { select: { id: true, name: true } },
        order: { select: { id: true, orderNo: true, externalOrderNo: true } },
        createdBy: { select: { id: true, name: true } },
        allocations: {
          select: {
            id: true,
            invoiceId: true,
            orderId: true,
            amount: true,
            invoice: { select: { actualInvoiceNo: true } },
            order: { select: { orderNo: true } },
          },
        },
      },
    }),
    prisma.financeReceipt.count({ where }),
  ]);

  // Resolve deletedBy user names
  const deletedByIds = [...new Set(receipts.map((r) => r.deletedById).filter(Boolean))] as string[];
  const deletedByUsers = deletedByIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: deletedByIds } }, select: { id: true, name: true } })
    : [];
  const deletedByNameMap = new Map(deletedByUsers.map((u) => [u.id, u.name]));

  const result = receipts.map((r) => {
    const orderAmount = orderId
      ? (r.orderId === orderId
          ? centsToYuan(r.amount)
          : centsToYuan(r.allocations.reduce((s, a) => s + (a.orderId === orderId ? a.amount : 0), 0)))
      : null;
    return {
      ...r,
      profile: r.profile ? { id: r.profile.id, name: r.profile.name ?? null } : null,
      customer: null,
      amount: centsToYuan(r.amount),
      allocations: r.allocations.map((a) => ({ ...a, amount: centsToYuan(a.amount) })),
      deletedByName: r.deletedById ? (deletedByNameMap.get(r.deletedById) || null) : null,
      allocationCount: r.allocations.length,
      orderAmount,
    };
  });

  return NextResponse.json({ receipts: result, total, page, pageSize });
}

export async function POST(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  // Intentionally audit-friendly: USER can create receipts, but only ADMIN can edit/delete later.
  if (session.user.role !== "ADMIN" && session.user.role !== "USER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const {
    orderId,
    amount,
    receivedAt,
    source,
    remark,
    allocations,
    organizationId,
  } = body;

  // ─── Allocation branch (new: payment voucher matching) ───
  if (allocations && Array.isArray(allocations) && allocations.length > 0) {
    // §6.2: reject 1-to-1 fields when allocations present
    if (orderId) {
      return NextResponse.json({ error: "使用 allocations 时不能同时传 orderId" }, { status: 400 });
    }
    if (body.externalOrderInvoiceRequestId) {
      return NextResponse.json({ error: "使用 allocations 时不能同时传 externalOrderInvoiceRequestId" }, { status: 400 });
    }
    if (body.projectInvoiceId) {
      return NextResponse.json({ error: "使用 allocations 时不能同时传 projectInvoiceId" }, { status: 400 });
    }
    return handleAllocationReceipt(session.user.id, session.user.role, {
      amount,
      receivedAt,
      source,
      remark,
      organizationId,
      allocations,
    });
  }

  // ─── Legacy 1-to-1 branch (existing) ───
  if (!orderId || typeof orderId !== "string") {
    return NextResponse.json({ error: "回款必须关联订单" }, { status: 400 });
  }
  if (!amount || typeof amount !== "number" || amount <= 0) {
    return NextResponse.json({ error: "金额必须大于 0" }, { status: 400 });
  }

  const { valid, profileId: orderProfileId } = await resolveOrderAndCheckScope(session.user.id, session.user.role, session.user.department, orderId);
  if (!valid) return NextResponse.json({ error: "Forbidden: 订单不可见或不存在" }, { status: 403 });

  let profileId: string;
  try {
    profileId = requireOrderProfileIdForReceipt(orderProfileId);
  } catch (err) {
    if (err instanceof ReceiptMissingProfileError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const receipt = await prisma.financeReceipt.create({
    data: {
      orderId,
      profileId,
      amount: yuanToCents(amount),
      receivedAt: parseReceivedAtInput(receivedAt),
      source: source || "MANUAL",
      remark: remark?.trim() || null,
      createdById: session.user.id,
    },
    include: {
      profile: { select: { id: true, name: true } },
      order: { select: { id: true, orderNo: true } },
    },
  });

  return NextResponse.json({
    receipt: {
      ...receipt,
      profile: receipt.profile ? { id: receipt.profile.id, name: receipt.profile.name ?? null } : null,
      customer: null,
      amount: centsToYuan(receipt.amount),
    },
  }, { status: 201 });
}

// ─── Allocation Receipt Handler ─────────────────────────────────

async function handleAllocationReceipt(
  userId: string,
  role: string,
  body: {
    amount?: number;
    receivedAt?: string;
    source?: string;
    remark?: string;
    organizationId?: string;
    allocations: Array<{ invoiceId: string; amount: number }>;
  },
) {
  const { amount, receivedAt, source, remark, organizationId, allocations } = body;

  if (!amount || typeof amount !== "number" || amount <= 0) {
    return NextResponse.json({ error: "金额必须大于 0" }, { status: 400 });
  }
  if (!Array.isArray(allocations) || allocations.length === 0) {
    return NextResponse.json({ error: "allocations 不能为空" }, { status: 400 });
  }
  if (!organizationId || typeof organizationId !== "string") {
    return NextResponse.json({ error: "凭证匹配必须提供 organizationId（付款机构）" }, { status: 400 });
  }

  const actor = { userId, role };

  try {
    const result = await createReceiptForActor(
      actor,
      {
        amountYuan: amount,
        receivedAt,
        source,
        remark,
        organizationId,
        allocations: allocations.map((a) => ({
          invoiceId: a.invoiceId,
          amountYuan: a.amount,
        })),
      },
      { invocation: { channel: "web" } },
    );

    return NextResponse.json({
      receipt: {
        id: result.receipt.id,
        amount: centsToYuan(result.receipt.amountCents),
        receivedAt: result.receipt.receivedAt.toISOString(),
        source: result.receipt.source,
      },
      allocations: result.allocations.map((a) => ({
        invoiceId: a.invoiceId,
        orderId: a.orderId,
        amount: centsToYuan(a.amountCents),
        newOutstanding: centsToYuan(a.newOutstandingCents),
      })),
      crossOrder: result.crossOrder,
      orderBreakdown: result.orderBreakdown.map((row) => ({
        orderId: row.orderId,
        sum: centsToYuan(row.sumCents),
      })),
    }, { status: 201 });
  } catch (err: unknown) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    if (err instanceof AllocationReceiptError) {
      return NextResponse.json(err.body || { error: err.message }, { status: err.status });
    }
    if (err instanceof ReceiptMissingProfileError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
