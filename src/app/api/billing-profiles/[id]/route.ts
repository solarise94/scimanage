import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isRepresentative } from "@/lib/permissions";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isRepresentative(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const profile = await prisma.billingProfile.findUnique({ where: { id } });
  if (!profile) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ profile });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const existing = await prisma.billingProfile.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const { name, taxId, bankName, bankAccount, address, phone, legalRepresentative, isDefault, archived } = body as {
    name?: string;
    taxId?: string;
    bankName?: string;
    bankAccount?: string;
    address?: string;
    phone?: string;
    legalRepresentative?: string;
    isDefault?: boolean;
    archived?: boolean;
  };

  // If setting as default, clear other defaults first
  if (isDefault && !existing.isDefault) {
    await prisma.billingProfile.updateMany({
      where: { isDefault: true, id: { not: id } },
      data: { isDefault: false },
    });
  }

  const data: Record<string, unknown> = {};
  if (name !== undefined) data.name = name.trim() || existing.name;
  if (taxId !== undefined) data.taxId = taxId.trim() || null;
  if (bankName !== undefined) data.bankName = bankName.trim() || null;
  if (bankAccount !== undefined) data.bankAccount = bankAccount.trim() || null;
  if (address !== undefined) data.address = address.trim() || null;
  if (phone !== undefined) data.phone = phone.trim() || null;
  if (legalRepresentative !== undefined) data.legalRepresentative = legalRepresentative.trim() || null;
  if (isDefault !== undefined) data.isDefault = !!isDefault;
  if (archived !== undefined) data.archived = !!archived;

  const profile = await prisma.billingProfile.update({ where: { id }, data });
  return NextResponse.json({ profile });
}
