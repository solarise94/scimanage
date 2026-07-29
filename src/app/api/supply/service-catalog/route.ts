import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isSupplyChainBlocked } from "@/lib/supply-chain/permissions";
import { isValidServiceCategory, isValidServiceDomain } from "@/lib/supply-chain/constants";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isSupplyChainBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const category = url.searchParams.get("category")?.trim() || "";
  const active = url.searchParams.get("active");

  const where: Record<string, unknown> = {};
  if (category) where.category = category;
  if (active !== null && active !== undefined) where.active = active === "true";

  const items = await prisma.serviceCatalog.findMany({
    where,
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });

  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { serviceKey, name, category, domain, aliasesJson, description, active } = body as Record<string, unknown>;

  if (!serviceKey || typeof serviceKey !== "string") {
    return NextResponse.json({ error: "serviceKey 必填" }, { status: 400 });
  }
  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "name 必填" }, { status: 400 });
  }
  if (category && !isValidServiceCategory(category as string)) {
    return NextResponse.json({ error: "无效服务类别" }, { status: 400 });
  }
  if (domain && !isValidServiceDomain(domain as string)) {
    return NextResponse.json({ error: "无效业务域" }, { status: 400 });
  }

  const existing = await prisma.serviceCatalog.findUnique({ where: { serviceKey: serviceKey as string } });
  if (existing) {
    return NextResponse.json({ error: `serviceKey 已存在：${serviceKey}` }, { status: 409 });
  }

  const item = await prisma.serviceCatalog.create({
    data: {
      serviceKey: serviceKey as string,
      name: name as string,
      category: (category as string) || "SERVICE",
      domain: (domain as string) || null,
      aliasesJson: aliasesJson ? String(aliasesJson) : null,
      description: (description as string) || null,
      active: active !== false,
    },
  });

  return NextResponse.json({ item }, { status: 201 });
}
