import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { yuanToCents, centsToYuan } from "@/lib/finance/money";
import { getQuoteSelect } from "@/lib/supply-chain/permissions";
import { isValidQuoteStatus } from "@/lib/supply-chain/constants";
import { computeNextRefreshAt, recalcSupplierQuoteTimes } from "@/lib/supply-chain/quote-refresh";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const existing = await prisma.supplierQuote.findUnique({
    where: { id },
    include: { supplier: { select: { quoteUpdateCycleDays: true } } },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  // 识别字段不可变：supplierId / serviceKey / itemName 不接受修改
  const {
    listPrice, quotedPrice, negotiatedPrice, floorPriceHint, discountRate,
    leadDays, validFrom, validTo, updateCycleDays, status, remark,
  } = body as Record<string, unknown>;

  if (status !== undefined && status !== null && !isValidQuoteStatus(status as string)) {
    return NextResponse.json({ error: "无效报价状态" }, { status: 400 });
  }

  const now = new Date();
  const data: Record<string, unknown> = { lastUpdatedAt: now };
  if (listPrice !== undefined) {
    if (Number(listPrice) <= 0) return NextResponse.json({ error: "目录价必须为正数" }, { status: 400 });
    data.listPrice = yuanToCents(Number(listPrice));
  }
  if (quotedPrice !== undefined) {
    if (Number(quotedPrice) <= 0) return NextResponse.json({ error: "报价必须为正数" }, { status: 400 });
    data.quotedPrice = yuanToCents(Number(quotedPrice));
  }
  if (negotiatedPrice !== undefined) {
    data.negotiatedPrice = negotiatedPrice != null ? yuanToCents(Number(negotiatedPrice)) : null;
  }
  if (floorPriceHint !== undefined) {
    data.floorPriceHint = floorPriceHint != null ? yuanToCents(Number(floorPriceHint)) : null;
  }
  if (discountRate !== undefined) data.discountRate = discountRate != null ? Number(discountRate) : null;
  if (leadDays !== undefined) data.leadDays = leadDays != null ? Number(leadDays) : null;
  if (validFrom !== undefined) data.validFrom = validFrom ? new Date(validFrom as string) : null;
  if (validTo !== undefined) data.validTo = validTo ? new Date(validTo as string) : null;
  if (updateCycleDays !== undefined) data.updateCycleDays = updateCycleDays != null ? Number(updateCycleDays) : null;
  if (status !== undefined) data.status = status;
  if (remark !== undefined) data.remark = remark;

  // 重算 nextRefreshAt（基于更新后的字段值）
  const finalValidTo = data.validTo !== undefined ? (data.validTo as Date | null) : existing.validTo;
  const finalUpdateCycle = data.updateCycleDays !== undefined ? (data.updateCycleDays as number | null) : existing.updateCycleDays;
  data.nextRefreshAt = computeNextRefreshAt({
    lastUpdatedAt: now,
    validTo: finalValidTo,
    updateCycleDays: finalUpdateCycle,
    supplierQuoteUpdateCycleDays: existing.supplier.quoteUpdateCycleDays,
  });

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.supplierQuote.update({
      where: { id },
      data,
      select: getQuoteSelect(session.user.role),
    });
    // 同事务内重算供应商报价时间聚合
    await recalcSupplierQuoteTimes(tx, existing.supplierId);
    return result;
  });

  return NextResponse.json({
    quote: {
      ...updated,
      listPrice: centsToYuan(updated.listPrice),
      quotedPrice: centsToYuan(updated.quotedPrice),
      negotiatedPrice: updated.negotiatedPrice != null ? centsToYuan(updated.negotiatedPrice) : null,
      floorPriceHint: "floorPriceHint" in updated && updated.floorPriceHint != null ? centsToYuan(updated.floorPriceHint) : null,
    },
  });
}
