import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isSupplyChainBlocked } from "@/lib/supply-chain/permissions";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isSupplyChainBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const supplier = await prisma.supplier.findUnique({ where: { id }, select: { id: true } });
  if (!supplier) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Phase 2：支持 productSkuId / serviceKey 筛选
  const productSkuId = req.nextUrl.searchParams.get("productSkuId")?.trim() || "";
  const serviceKey = req.nextUrl.searchParams.get("serviceKey")?.trim() || "";
  const where: Record<string, unknown> = { supplierId: id };
  if (productSkuId) where.productSkuId = productSkuId;
  else if (serviceKey) where.serviceKey = serviceKey;

  const capabilities = await prisma.supplierCapability.findMany({
    where,
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
  });

  return NextResponse.json({ capabilities });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const supplier = await prisma.supplier.findUnique({ where: { id }, select: { id: true } });
  if (!supplier) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const {
    productSkuId, supplierSkuCode, serviceKey, itemName, spec, sampleType, species, platform, active, note,
  } = body as Record<string, unknown>;

  // Phase 2：productSkuId 优先（兼容期 serviceKey fallback，至少一个非空）
  if (!productSkuId && (!serviceKey || typeof serviceKey !== "string")) {
    return NextResponse.json({ error: "productSkuId 或 serviceKey 至少必填一个" }, { status: 400 });
  }
  if (!itemName || typeof itemName !== "string") {
    return NextResponse.json({ error: "itemName 必填" }, { status: 400 });
  }

  // Phase 2：productSkuId 优先校验；无则回退 legacy serviceKey
  if (productSkuId) {
    const sku = await prisma.productSku.findUnique({
      where: { id: productSkuId as string },
      select: { id: true, skuCode: true, status: true, purchasable: true },
    });
    if (!sku) {
      return NextResponse.json({ error: `产品 SKU 不存在：${productSkuId}` }, { status: 400 });
    }
    if (sku.status !== "ACTIVE" || !sku.purchasable) {
      return NextResponse.json({ error: `SKU ${sku.skuCode} 不可采购` }, { status: 400 });
    }
  } else if (serviceKey) {
    const catalog = await prisma.serviceCatalog.findUnique({ where: { serviceKey: serviceKey as string } });
    if (!catalog || !catalog.active) {
      return NextResponse.json({ error: "无效或已停用的 serviceKey" }, { status: 400 });
    }
  }

  // 去重校验：supplierId + (productSkuId | serviceKey) + spec 组合唯一
  const dupWhere: Record<string, unknown> = { supplierId: id };
  if (productSkuId) {
    dupWhere.productSkuId = productSkuId;
  } else {
    dupWhere.serviceKey = serviceKey;
  }
  if (spec) {
    dupWhere.spec = spec;
  } else {
    dupWhere.spec = null;
  }
  const duplicate = await prisma.supplierCapability.findFirst({ where: dupWhere });
  if (duplicate) {
    return NextResponse.json({ error: "该产品/SKU+规格组合已存在" }, { status: 409 });
  }

  const capability = await prisma.supplierCapability.create({
    data: {
      supplierId: id,
      productSkuId: productSkuId ? (productSkuId as string) : null,
      supplierSkuCode: supplierSkuCode ? (supplierSkuCode as string) : null,
      serviceKey: serviceKey ? (serviceKey as string) : null,
      itemName,
      spec: (spec as string) || null,
      sampleType: (sampleType as string) || null,
      species: (species as string) || null,
      platform: (platform as string) || null,
      active: active !== undefined ? Boolean(active) : true,
      note: (note as string) || null,
    },
  });

  return NextResponse.json({ capability }, { status: 201 });
}
