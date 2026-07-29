import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { prisma } from "@/lib/prisma";
import { yuanToCents, centsToYuan } from "@/lib/finance/money";
import { isValidPayableStatus } from "@/lib/finance/supplier-finance-constants";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const existing = await prisma.financePayable.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const { amount, dueAt, note, status } = body as Record<string, unknown>;

  if (amount !== undefined && Number(amount) <= 0) {
    return NextResponse.json({ error: "金额必须为正数" }, { status: 400 });
  }
  if (status !== undefined && status !== null && !isValidPayableStatus(status as string)) {
    return NextResponse.json({ error: "无效付款状态" }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  if (amount !== undefined) data.amount = yuanToCents(Number(amount));
  if (dueAt !== undefined) data.dueAt = dueAt ? new Date(dueAt as string) : null;
  if (note !== undefined) data.note = note;
  if (status !== undefined) data.status = status;

  const updated = await prisma.financePayable.update({
    where: { id },
    data,
    include: { supplier: { select: { id: true, name: true } } },
  });

  return NextResponse.json({
    payable: {
      ...updated,
      amount: centsToYuan(updated.amount),
      paidAmount: centsToYuan(updated.paidAmount),
    },
  });
}
