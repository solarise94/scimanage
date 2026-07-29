import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { prisma } from "@/lib/prisma";
import { getFinanceProfileScopeWhere, getFinanceProjectScopeWhere } from "@/lib/finance/permissions";
import { yuanToCents, centsToYuan } from "@/lib/finance/money";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (session.user.role !== "ADMIN" && session.user.role !== "USER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();
  const { amount, refundedAt, remark, settledByReceiptId } = body;

  if (!amount || typeof amount !== "number" || amount <= 0) {
    return NextResponse.json({ error: "退款金额必须大于 0" }, { status: 400 });
  }
  if (!settledByReceiptId || typeof settledByReceiptId !== "string") {
    return NextResponse.json({ error: "请先选择对应回款记录后再退款" }, { status: 400 });
  }

  // Scope check for non-ADMIN (read-only, outside transaction)
  if (session.user.role !== "ADMIN") {
    const advance = await prisma.financeAdvance.findUnique({
      where: { id },
      select: { profileId: true, projectId: true },
    });
    if (!advance) return NextResponse.json({ error: "垫付记录不存在" }, { status: 404 });
    const [profileScope, projScope] = await Promise.all([
      getFinanceProfileScopeWhere(session.user.id, session.user.role),
      getFinanceProjectScopeWhere(session.user.id, session.user.role),
    ]);
    const custOk = !profileScope || (advance.profileId && profileScope.id.in.includes(advance.profileId));
    const projOk = !projScope || (advance.projectId && projScope.id.in.includes(advance.projectId));
    if (!custOk && !projOk) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Atomic: validate advance + receipt + refunds, create refund, update status
  try {
    const refund = await prisma.$transaction(async (tx) => {
      const advance = await tx.financeAdvance.findUnique({
        where: { id },
        include: { refunds: { select: { amount: true, settledByReceiptId: true } } },
      });
      if (!advance) throw new Error("垫付记录不存在");
      if (advance.status === "REFUNDED") throw new Error("该垫付已全额退款，无法再退");
      if (advance.status === "WRITTEN_OFF") throw new Error("该垫付已核销，无法退款");

      const receipt = await tx.financeReceipt.findUnique({
        where: { id: settledByReceiptId },
        select: { id: true, amount: true, orderId: true, projectId: true, profileId: true, deleted: true },
      });
      if (!receipt) throw new Error("回款记录不存在");
      if (receipt.deleted) throw new Error("该回款记录已删除，不能用于垫付退款结算");

      // Entity consistency: order-first cascading match.
      // If advance has an order, receipt must belong to that same order.
      // Only downgrade to project/customer when advance lacks an order link.
      if (advance.orderId) {
        if (!receipt.orderId || receipt.orderId !== advance.orderId) {
          throw new Error("垫付关联了订单，退款必须使用同一订单的回款");
        }
      } else if (advance.projectId) {
        if (!receipt.projectId || receipt.projectId !== advance.projectId) {
          throw new Error("垫付关联了项目，退款必须使用同一项目的回款");
        }
      } else if (advance.profileId) {
        if (!receipt.profileId || receipt.profileId !== advance.profileId) {
          throw new Error("垫付关联了客户，退款必须使用同一客户的回款");
        }
      } else {
        throw new Error("垫付无关联实体，无法匹配回款");
      }

      // Receipt total refunded check — query ALL refunds globally for this receipt
      const allReceiptRefunds = await tx.financeAdvanceRefund.findMany({
        where: { settledByReceiptId },
        select: { amount: true },
      });
      const receiptTotalRefunded = allReceiptRefunds.reduce((sum, r) => sum + r.amount, 0);
      if (receiptTotalRefunded + amount > receipt.amount) {
        const available = receipt.amount - receiptTotalRefunded;
        throw new Error(`该回款剩余可退金额不足（可用 ¥${available.toLocaleString()}）`);
      }

      // Advance total refunded check
      const totalRefunded = advance.refunds.reduce((sum, r) => sum + r.amount, 0);
      if (totalRefunded + amount > advance.amount) {
        const remaining = advance.amount - totalRefunded;
        throw new Error(`退款总额不能超过垫付金额（剩余可退 ¥${remaining.toLocaleString()}）`);
      }

      const created = await tx.financeAdvanceRefund.create({
        data: {
          advanceId: id,
          settledByReceiptId,
          amount: yuanToCents(amount),
          refundedAt: refundedAt ? new Date(refundedAt) : new Date(),
          remark: remark?.trim() || null,
          createdById: session.user.id,
        },
      });

      const newTotal = totalRefunded + amount;
      let newStatus = advance.status;
      if (newTotal >= advance.amount) {
        newStatus = "REFUNDED";
      } else if (newTotal > 0) {
        newStatus = "PARTIAL_REFUNDED";
      }

      await tx.financeAdvance.update({
        where: { id },
        data: { status: newStatus, settledByReceiptId },
      });

      return created;
    });

    return NextResponse.json({ refund: { ...refund, amount: centsToYuan(refund.amount) } }, { status: 201 });
  } catch (e: unknown) {
    if (e instanceof Error) {
      if (e.message === "垫付记录不存在") return NextResponse.json({ error: e.message }, { status: 404 });
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
