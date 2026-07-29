import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { prisma } from "@/lib/prisma";
import { assertInvoiceNotOccupied } from "@/lib/finance/order-invoices";
import { releaseInvoiceClaimsForRequest } from "@/lib/finance/invoice-claims";
import { syncOrderInvoiceStatus } from "@/lib/external-order";
import { sendInvoiceAdjustedEmail } from "@/lib/business-email/notify";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const invoice = await prisma.externalOrderInvoiceRequest.findUnique({
    where: { id },
    include: {
      order: { select: { id: true, orderNo: true } },
      orderCoverage: { select: { orderId: true } },
    },
  });

  if (!invoice) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (invoice.status !== "ISSUED") {
    return NextResponse.json({ error: "只有已开票的发票才能冲红" }, { status: 400 });
  }

  // §9.1: Check invoice occupation before allowing RED
  try {
    await assertInvoiceNotOccupied(id);
  } catch (err: unknown) {
    const e = err as { status?: number; body?: unknown };
    if (e.status === 409) {
      return NextResponse.json(e.body, { status: 409 });
    }
    throw err;
  }

  const body = await req.json();
  const { reason } = body as Record<string, unknown>;
  if (!reason || !(reason as string).trim()) {
    return NextResponse.json({ error: "冲红原因不能为空" }, { status: 400 });
  }

  // Check if already has a red or reissue adjustment
  const existingAdjustment = await prisma.invoiceAdjustment.findFirst({
    where: { originalInvoiceId: id },
  });
  if (existingAdjustment?.kind === "RED") {
    return NextResponse.json({ error: "该发票已冲红，不能重复冲红" }, { status: 400 });
  }
  if (existingAdjustment?.kind === "REISSUE") {
    return NextResponse.json({ error: "该发票已重开，请先取消重开后再冲红" }, { status: 400 });
  }

  try {
    const adjustment = await prisma.$transaction(async (tx) => {
      const created = await tx.invoiceAdjustment.create({
        data: {
          kind: "RED",
          reason: (reason as string).trim(),
          originalInvoiceId: id,
          createdById: session.user.id,
        },
      });
      // 冲红后票号/文件可按「仅有效发票判重」语义被新申请重用
      await releaseInvoiceClaimsForRequest(tx, id);
      return created;
    });

    // Sync legacy ExternalOrder.invoiceStatus for all touched orders（与 POST/REISSUE 路径一致）
    const touchedOrderIds = [
      ...(invoice.orderId ? [invoice.orderId] : []),
      ...invoice.orderCoverage.map((c) => c.orderId),
    ];
    for (const oid of [...new Set(touchedOrderIds)]) {
      const ord = await prisma.order.findUnique({
        where: { id: oid },
        select: { legacyExternalOrderId: true },
      });
      const legacyId = ord?.legacyExternalOrderId ?? null;
      if (legacyId) {
        await syncOrderInvoiceStatus(prisma, legacyId, oid);
      }
      await syncOrderInvoiceStatus(prisma, oid, oid);
    }

    // 邮件 F：发票冲红，通知财务部（fail-closed，不阻塞）
    await sendInvoiceAdjustedEmail({
      invoiceId: id,
      kind: "RED",
      reason: (reason as string).trim(),
      operatorName: session.user.name || "管理员",
    });

    return NextResponse.json({ adjustment }, { status: 201 });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002") {
      return NextResponse.json({ error: "该发票已冲红或已重开" }, { status: 409 });
    }
    throw err;
  }
}
