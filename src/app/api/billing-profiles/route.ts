import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isRepresentative } from "@/lib/permissions";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isRepresentative(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const includeArchived = req.nextUrl.searchParams.get("includeArchived") === "1";
  const profiles = await prisma.billingProfile.findMany({
    where: includeArchived ? {} : { archived: false },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  });

  return NextResponse.json({ profiles });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { name, taxId, bankName, bankAccount, address, phone, legalRepresentative, isDefault } = body as {
    name?: string;
    taxId?: string;
    bankName?: string;
    bankAccount?: string;
    address?: string;
    phone?: string;
    legalRepresentative?: string;
    isDefault?: boolean;
  };

  if (!name?.trim()) {
    return NextResponse.json({ error: "名称不能为空" }, { status: 400 });
  }

  // If setting as default, clear other defaults first
  if (isDefault) {
    await prisma.billingProfile.updateMany({
      where: { isDefault: true },
      data: { isDefault: false },
    });
  }

  const profile = await prisma.billingProfile.create({
    data: {
      name: name.trim(),
      taxId: taxId?.trim() || null,
      bankName: bankName?.trim() || null,
      bankAccount: bankAccount?.trim() || null,
      address: address?.trim() || null,
      phone: phone?.trim() || null,
      legalRepresentative: legalRepresentative?.trim() || null,
      isDefault: !!isDefault,
    },
  });

  return NextResponse.json({ profile }, { status: 201 });
}
