import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { yuanToCents, centsToYuan } from "@/lib/finance/money";
import {
  isSupplyChainBlocked,
  getQuoteSelect,
} from "@/lib/supply-chain/permissions";
import { isValidQuoteStatus } from "@/lib/supply-chain/constants";
import { computeNextRefreshAt, recalcSupplierQuoteTimes } from "@/lib/supply-chain/quote-refresh";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isSupplyChainBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const supplierId = url.searchParams.get("supplierId")?.trim() || "";
  const productSkuId = url.searchParams.get("productSkuId")?.trim() || "";
  const serviceKey = url.searchParams.get("serviceKey")?.trim() || "";
  const status = url.searchParams.get("status")?.trim() || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));

  const andConditions: Record<string, unknown>[] = [
    { supplier: { archived: false } },
  ];
  if (supplierId) andConditions.push({ supplierId });
  // Phase 2：productSkuId 优先筛选；serviceKey 作为 legacy fallback。
  if (productSkuId) andConditions.push({ productSkuId });
  else if (serviceKey) andConditions.push({ serviceKey });
  if (status) andConditions.push({ status });

  const where = { AND: andConditions };

  const select = getQuoteSelect(session.user.role);

  const [quotes, total] = await Promise.all([
    prisma.supplierQuote.findMany({
      where,
      select,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.supplierQuote.count({ where }),
  ]);

  // 金额转元（出参）
  const quotesYuan = quotes.map((q) => ({
    ...q,
    listPrice: centsToYuan(q.listPrice),
    quotedPrice: centsToYuan(q.quotedPrice),
    negotiatedPrice: q.negotiatedPrice != null ? centsToYuan(q.negotiatedPrice) : null,
    floorPriceHint: "floorPriceHint" in q && q.floorPriceHint != null ? centsToYuan(q.floorPriceHint) : null,
  }));

  return NextResponse.json({
    quotes: quotesYuan,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const {
    supplierId, productSkuId, supplierSkuCode, serviceKey, itemName, spec, unit, minQuantity,
    listPrice, quotedPrice, negotiatedPrice, floorPriceHint, discountRate,
    leadDays, validFrom, validTo, updateCycleDays, status, source, sourceRef, remark,
  } = body as Record<string, unknown>;

  if (!supplierId) return NextResponse.json({ error: "supplierId 必填" }, { status: 400 });
  // Phase 2：productSkuId 是新事实源（兼容期 serviceKey 作为 legacy fallback，至少一个非空）
  if (!productSkuId && !serviceKey) {
    return NextResponse.json({ error: "productSkuId 或 serviceKey 至少必填一个" }, { status: 400 });
  }
  if (!itemName) return NextResponse.json({ error: "itemName 必填" }, { status: 400 });
  if (listPrice == null || Number(listPrice) <= 0) {
    return NextResponse.json({ error: "目录价必须为正数" }, { status: 400 });
  }
  if (quotedPrice == null || Number(quotedPrice) <= 0) {
    return NextResponse.json({ error: "报价必须为正数" }, { status: 400 });
  }

  // 校验 status
  const finalStatus = (status as string) || "ACTIVE";
  if (!isValidQuoteStatus(finalStatus)) {
    return NextResponse.json({ error: `无效的 status: ${finalStatus}` }, { status: 400 });
  }

  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId as string } });
  if (!supplier) return NextResponse.json({ error: "供应商不存在" }, { status: 400 });

  // Phase 2：productSkuId 优先校验（ACTIVE + purchasable）；无则回退 legacy serviceKey。
  if (productSkuId) {
    const sku = await prisma.productSku.findUnique({
      where: { id: productSkuId as string },
      select: { id: true, skuCode: true, status: true, purchasable: true },
    });
    if (!sku) {
      return NextResponse.json({ error: `产品 SKU 不存在：${productSkuId}` }, { status: 400 });
    }
    if (sku.status !== "ACTIVE" || !sku.purchasable) {
      return NextResponse.json({ error: `SKU ${sku.skuCode} 不可采购，不能创建报价` }, { status: 400 });
    }
  } else if (serviceKey) {
    // legacy fallback：校验 serviceKey 存在于 ServiceCatalog 且启用
    const service = await prisma.serviceCatalog.findUnique({
      where: { serviceKey: serviceKey as string },
      select: { id: true, active: true },
    });
    if (!service) {
      return NextResponse.json({ error: `服务项 ${serviceKey} 不存在` }, { status: 400 });
    }
    if (!service.active) {
      return NextResponse.json({ error: `服务项 ${serviceKey} 已停用，不能创建报价` }, { status: 400 });
    }
  }

  const now = new Date();
  const validToDate = validTo ? new Date(validTo as string) : null;
  const updateCycle = updateCycleDays != null ? Number(updateCycleDays) : null;
  const nextRefreshAt = computeNextRefreshAt({
    lastUpdatedAt: now,
    validTo: validToDate,
    updateCycleDays: updateCycle,
    supplierQuoteUpdateCycleDays: supplier.quoteUpdateCycleDays,
  });

  const quote = await prisma.$transaction(async (tx) => {
    const created = await tx.supplierQuote.create({
      data: {
        supplierId: supplierId as string,
        productSkuId: productSkuId ? (productSkuId as string) : null,
        supplierSkuCode: supplierSkuCode ? (supplierSkuCode as string) : null,
        serviceKey: serviceKey ? (serviceKey as string) : null,
        itemName: itemName as string,
        spec: (spec as string) || null,
        unit: (unit as string) || null,
        minQuantity: minQuantity != null ? Number(minQuantity) : null,
        listPrice: yuanToCents(Number(listPrice)),
        quotedPrice: yuanToCents(Number(quotedPrice)),
        negotiatedPrice: negotiatedPrice != null ? yuanToCents(Number(negotiatedPrice)) : null,
        floorPriceHint: floorPriceHint != null ? yuanToCents(Number(floorPriceHint)) : null,
        discountRate: discountRate != null ? Number(discountRate) : null,
        leadDays: leadDays != null ? Number(leadDays) : null,
        validFrom: validFrom ? new Date(validFrom as string) : null,
        validTo: validToDate,
        lastUpdatedAt: now,
        updateCycleDays: updateCycle,
        nextRefreshAt,
        status: finalStatus,
        source: (source as string) || "MANUAL",
        sourceRef: (sourceRef as string) || null,
        remark: (remark as string) || null,
        createdById: session.user.id,
      },
      select: getQuoteSelect(session.user.role),
    });

    // 同事务内重算供应商报价时间聚合
    await recalcSupplierQuoteTimes(tx, supplierId as string);

    return created;
  });

  return NextResponse.json({
    quote: {
      ...quote,
      listPrice: centsToYuan(quote.listPrice),
      quotedPrice: centsToYuan(quote.quotedPrice),
      negotiatedPrice: quote.negotiatedPrice != null ? centsToYuan(quote.negotiatedPrice) : null,
      floorPriceHint: "floorPriceHint" in quote && quote.floorPriceHint != null ? centsToYuan(quote.floorPriceHint) : null,
    },
  }, { status: 201 });
}
