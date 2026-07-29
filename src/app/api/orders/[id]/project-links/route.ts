import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isOrderAccessBlocked, getOrderScopeWhere } from "@/lib/orders/permissions";
import { centsToYuan } from "@/lib/finance/money";
import {
  businessActorFromSessionUser,
  buildInvocationContext,
} from "@/lib/application/actor";
import { ApplicationError } from "@/lib/application/errors";
import {
  linkOrderToProjectForActor,
  OrderCustomerConflictError,
} from "@/lib/orders/application/link-order-project";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isOrderAccessBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const order = await prisma.order.findUnique({ where: { id }, select: { id: true } });
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (session.user.role !== "ADMIN") {
    const scopeWhere = await getOrderScopeWhere(session.user.id, session.user.role, prisma, session.user.department);
    if (scopeWhere) {
      const inScope = await prisma.order.count({ where: { id, AND: [scopeWhere] } });
      if (inScope === 0) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const links = await prisma.orderProjectLink.findMany({
    where: { orderId: id },
    include: {
      project: { select: { id: true, name: true, status: true, profileId: true } },
      createdBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    links: links.map((l) => ({
      ...l,
      allocatedAmount: l.allocatedAmount != null ? centsToYuan(l.allocatedAmount) : null,
    })),
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: orderId } = await params;
  const body = await req.json();
  const { projectId, treatment, allocatedAmount, isPrimary, note } = body as Record<string, unknown>;

  const actor = businessActorFromSessionUser(session.user);
  const invocation = buildInvocationContext({ channel: "web" });

  let result;
  try {
    result = await linkOrderToProjectForActor(actor, invocation, {
      orderId,
      projectId: typeof projectId === "string" ? projectId : "",
      treatment: typeof treatment === "string" ? treatment : null,
      allocatedAmount: allocatedAmount != null ? Number(allocatedAmount) : null,
      moneyUnit: "yuan",
      isPrimary: isPrimary === true,
      note: typeof note === "string" ? note : null,
    });
  } catch (err) {
    if (err instanceof OrderCustomerConflictError) {
      return NextResponse.json({
        error: err.message,
        orderProfileId: err.orderProfileId,
        projectProfileId: err.projectProfileId,
      }, { status: 409 });
    }
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }

  const link = result.link;
  return NextResponse.json({
    link: {
      ...link,
      allocatedAmount: link.allocatedAmount != null ? centsToYuan(link.allocatedAmount) : null,
    },
  }, { status: 201 });
}
