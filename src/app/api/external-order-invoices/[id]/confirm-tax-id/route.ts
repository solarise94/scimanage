import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const invoice = await prisma.externalOrderInvoiceRequest.findUnique({
    where: { id },
    select: {
      buyerOrganizationId: true,
      buyerTaxId: true,
      buyerTaxIdFromLookup: true,
    },
  });

  if (!invoice) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!invoice.buyerOrganizationId || !invoice.buyerTaxId) {
    return NextResponse.json({ error: "无可同步的税号" }, { status: 400 });
  }

  const org = await prisma.organization.findUnique({
    where: { id: invoice.buyerOrganizationId },
    select: { taxId: true },
  });

  if (!org) return NextResponse.json({ error: "单位不存在" }, { status: 404 });

  if (org.taxId) {
    await prisma.externalOrderInvoiceRequest.update({
      where: { id },
      data: { buyerTaxIdFromLookup: false },
    });
    if (org.taxId === invoice.buyerTaxId) {
      return NextResponse.json({ ok: true, message: "单位已有相同税号，已清除标记" });
    }
    return NextResponse.json({
      ok: true,
      conflict: true,
      message: `单位已有税号 ${org.taxId}，与发票税号 ${invoice.buyerTaxId} 不一致，已清除标记但未覆盖主数据`,
      existingTaxId: org.taxId,
    });
  }

  await prisma.$transaction([
    prisma.organization.update({
      where: { id: invoice.buyerOrganizationId },
      data: { taxId: invoice.buyerTaxId },
    }),
    prisma.externalOrderInvoiceRequest.update({
      where: { id },
      data: { buyerTaxIdFromLookup: false },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
