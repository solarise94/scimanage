import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isValidServiceCategory, isValidServiceDomain } from "@/lib/supply-chain/constants";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const existing = await prisma.serviceCatalog.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const { name, category, domain, aliasesJson, description, active } = body as Record<string, unknown>;

  if (category !== undefined && category !== null && !isValidServiceCategory(category as string)) {
    return NextResponse.json({ error: "无效服务类别" }, { status: 400 });
  }
  if (domain !== undefined && domain !== null && !isValidServiceDomain(domain as string)) {
    return NextResponse.json({ error: "无效业务域" }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  if (name !== undefined) data.name = name;
  if (category !== undefined) data.category = category;
  if (domain !== undefined) data.domain = domain || null;
  if (aliasesJson !== undefined) data.aliasesJson = aliasesJson ? String(aliasesJson) : null;
  if (description !== undefined) data.description = description;
  if (active !== undefined) data.active = active;

  const updated = await prisma.serviceCatalog.update({ where: { id }, data });
  return NextResponse.json({ item: updated });
}
