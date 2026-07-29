import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { centsToYuan } from "@/lib/finance/money";
import {
  isSupplyChainBlocked,
  getSupplyExecutionScopeWhere,
} from "@/lib/supply-chain/permissions";
import { PLAN_TYPE, isValidPlanType } from "@/lib/supply-chain/constants";
import {
  buildSupplyPlanCandidates,
  createSupplyPlanFromCandidate,
} from "@/lib/supply-chain/plan-builder";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isSupplyChainBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const orderId = url.searchParams.get("orderId")?.trim() || "";
  const status = url.searchParams.get("status")?.trim() || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));

  const andConditions: Record<string, unknown>[] = [];

  // Scope（非 ADMIN）—— SupplyPlan 从 Order scope 继承（设计 §6.5）
  const scopeWhere = await getSupplyExecutionScopeWhere(session.user.id, session.user.role, session.user.department);
  if (scopeWhere) andConditions.push(scopeWhere);

  if (orderId) andConditions.push({ orderId });
  if (status) andConditions.push({ status });

  const where = andConditions.length === 1 ? andConditions[0] : { AND: andConditions };

  const [plans, total] = await Promise.all([
    prisma.supplyPlan.findMany({
      where,
      include: {
        order: { select: { id: true, orderNo: true, title: true } },
        lines: {
          include: {
            supplier: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.supplyPlan.count({ where }),
  ]);

  const plansYuan = plans.map((p) => ({
    ...p,
    totalQuotedCost: centsToYuan(p.totalQuotedCost),
    totalLockedCost: p.totalLockedCost != null ? centsToYuan(p.totalLockedCost) : null,
    lines: p.lines.map((l) => ({
      ...l,
      unitCost: centsToYuan(l.unitCost),
      amount: centsToYuan(l.amount),
    })),
  }));

  return NextResponse.json({
    plans: plansYuan,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
}

/**
 * POST /api/supply/plans — 生成供应方案候选。
 *
 * body: { orderId, mode, constraints, action: "preview" | "create" }
 * - preview：只返回候选，不落库
 * - create：生成候选并创建草稿 SupplyPlan，返回 planId
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isSupplyChainBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { orderId, mode, constraints, action } = body as Record<string, unknown>;

  if (!orderId) return NextResponse.json({ error: "orderId 必填" }, { status: 400 });
  const planMode = (mode as string) || PLAN_TYPE.BALANCED;
  if (!isValidPlanType(planMode)) {
    return NextResponse.json({ error: `无效方案类型：${mode}` }, { status: 400 });
  }

  // 校验订单可见性（对象级 scope，防止越权枚举订单 ID 生成方案）
  const { assertOrderVisibleForSupplyChain } = await import("@/lib/supply-chain/permissions");
  const orderVisible = await assertOrderVisibleForSupplyChain(
    session.user.id,
    session.user.role,
    orderId as string,
    session.user.department,
  );
  if (!orderVisible) {
    return NextResponse.json({ error: "订单不在可见范围" }, { status: 403 });
  }

  try {
    const candidate = await buildSupplyPlanCandidates({
      orderId: orderId as string,
      mode: planMode,
      constraints: constraints as Record<string, unknown> | undefined,
    });

    if (action === "create") {
      if (!candidate.readyToLock) {
        return NextResponse.json({
          error: "方案尚未就绪，无法创建",
          blockingIssues: candidate.blockingIssues,
          candidate,
        }, { status: 400 });
      }
      const planId = await createSupplyPlanFromCandidate(candidate, session.user.id);
      return NextResponse.json({ planId, candidate }, { status: 201 });
    }

    // preview
    return NextResponse.json({ candidate });
  } catch (e) {
    if (e instanceof Error && e.message === "NOT_FOUND") {
      return NextResponse.json({ error: "订单不存在或已删除" }, { status: 404 });
    }
    const { ApplicationError } = await import("@/lib/application/errors");
    if (e instanceof ApplicationError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.httpStatus });
    }
    throw e;
  }
}
