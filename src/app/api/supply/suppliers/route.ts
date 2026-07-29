import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  isSupplyChainBlocked,
  getSupplierSelect,
} from "@/lib/supply-chain/permissions";
import { isValidSupplierStatus, isValidSupplierCategory } from "@/lib/supply-chain/constants";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isSupplyChainBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const search = url.searchParams.get("search")?.trim() || "";
  const status = url.searchParams.get("status")?.trim() || "";
  const category = url.searchParams.get("category")?.trim() || "";
  const archived = url.searchParams.get("archived");
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));

  const andConditions: Record<string, unknown>[] = [];
  if (search) {
    andConditions.push({
      OR: [
        { name: { contains: search } },
        { normalizedName: { contains: search.toLowerCase() } },
        { shortName: { contains: search } },
        { contactName: { contains: search } },
        { phone: { contains: search } },
      ],
    });
  }
  if (status) andConditions.push({ status });
  if (category) andConditions.push({ category });
  if (archived !== null && archived !== undefined) {
    andConditions.push({ archived: archived === "true" });
  } else {
    andConditions.push({ archived: false });
  }

  const where = andConditions.length === 1 ? andConditions[0] : { AND: andConditions };

  const [suppliers, total] = await Promise.all([
    prisma.supplier.findMany({
      where,
      select: getSupplierSelect(session.user.role),
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.supplier.count({ where }),
  ]);

  return NextResponse.json({
    suppliers,
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
    name, shortName, status, category, region,
    contactName, phone, email, wechat, address, contactNote,
    paymentCycle, defaultLeadDays, quoteUpdateCycleDays,
    rating, qualityScore, deliveryScore, priceScore,
    tagsJson, preferenceNote, riskNote,
  } = body as Record<string, unknown>;

  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "name 必填" }, { status: 400 });
  }
  if (status && !isValidSupplierStatus(status as string)) {
    return NextResponse.json({ error: "无效供应商状态" }, { status: 400 });
  }
  if (category && !isValidSupplierCategory(category as string)) {
    return NextResponse.json({ error: "无效供应商类别" }, { status: 400 });
  }

  const supplier = await prisma.supplier.create({
    data: {
      name,
      normalizedName: (name as string).toLowerCase().trim(),
      shortName: (shortName as string) || null,
      status: (status as string) || "ACTIVE",
      category: (category as string) || null,
      region: (region as string) || null,
      contactName: (contactName as string) || null,
      phone: (phone as string) || null,
      email: (email as string) || null,
      wechat: (wechat as string) || null,
      address: (address as string) || null,
      contactNote: (contactNote as string) || null,
      paymentCycle: (paymentCycle as string) || null,
      defaultLeadDays: defaultLeadDays != null ? Number(defaultLeadDays) : null,
      quoteUpdateCycleDays: quoteUpdateCycleDays != null ? Number(quoteUpdateCycleDays) : null,
      rating: rating != null ? Number(rating) : null,
      qualityScore: qualityScore != null ? Number(qualityScore) : null,
      deliveryScore: deliveryScore != null ? Number(deliveryScore) : null,
      priceScore: priceScore != null ? Number(priceScore) : null,
      tagsJson: tagsJson ? String(tagsJson) : null,
      preferenceNote: (preferenceNote as string) || null,
      riskNote: (riskNote as string) || null,
    },
  });

  return NextResponse.json({ supplier }, { status: 201 });
}
