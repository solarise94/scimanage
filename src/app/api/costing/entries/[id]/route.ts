import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { centsToYuan, yuanToCents } from "@/lib/finance/money";
import {
  isValidCostStatus,
  COST_STATUS,
} from "@/lib/costing/constants";
import { updateCostEntry, cancelCostEntry } from "@/lib/costing/entries";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();
  const { amount, status, remark } = body as Record<string, unknown>;

  if (amount !== undefined && amount !== null && Number(amount) <= 0) {
    return NextResponse.json({ error: "金额必须为正数" }, { status: 400 });
  }
  if (status !== undefined && status !== null && !isValidCostStatus(status as string)) {
    return NextResponse.json({ error: `无效成本状态：${status}` }, { status: 400 });
  }

  try {
    const updated = await updateCostEntry({
      entryId: id,
      amount: amount !== undefined ? yuanToCents(Number(amount)) : undefined,
      status: status as never | undefined,
      remark: (remark as string) || undefined,
      actorUserId: session.user.id,
    });
    return NextResponse.json({
      entry: { ...updated, amount: centsToYuan(updated.amount) },
    });
  } catch (e) {
    if (e instanceof Error && e.message === "NOT_FOUND") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw e;
  }
}

/**
 * DELETE — 取消 CostEntry（status → CANCELLED，不物理删除）。
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const url = req.nextUrl;
  const reason = url.searchParams.get("reason") || undefined;

  try {
    const updated = await cancelCostEntry({
      entryId: id,
      actorUserId: session.user.id,
      reason: reason || undefined,
    });
    return NextResponse.json({
      entry: { ...updated, amount: centsToYuan(updated.amount) },
      cancelled: updated.status === COST_STATUS.CANCELLED,
    });
  } catch (e) {
    if (e instanceof Error && e.message === "NOT_FOUND") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw e;
  }
}
