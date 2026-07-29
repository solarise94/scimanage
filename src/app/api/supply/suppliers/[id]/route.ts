import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  isSupplyChainBlocked,
  getSupplierSelect,
} from "@/lib/supply-chain/permissions";
import { isValidSupplierStatus, isValidSupplierCategory } from "@/lib/supply-chain/constants";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isSupplyChainBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const supplier = await prisma.supplier.findUnique({
    where: { id },
    select: {
      ...getSupplierSelect(session.user.role),
      contacts: true,
      capabilities: { where: { active: true } },
    },
  });

  if (!supplier) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ supplier });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const existing = await prisma.supplier.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const {
    name, shortName, status, category, region,
    contactName, phone, email, wechat, address, contactNote,
    paymentCycle, defaultLeadDays, quoteUpdateCycleDays,
    rating, qualityScore, deliveryScore, priceScore,
    tagsJson, preferenceNote, riskNote, archived,
  } = body as Record<string, unknown>;

  if (status !== undefined && status !== null && !isValidSupplierStatus(status as string)) {
    return NextResponse.json({ error: "无效供应商状态" }, { status: 400 });
  }
  if (category !== undefined && category !== null && category !== "" && !isValidSupplierCategory(category as string)) {
    return NextResponse.json({ error: "无效供应商类别" }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  if (name !== undefined) {
    data.name = name;
    data.normalizedName = (name as string).toLowerCase().trim();
  }
  if (shortName !== undefined) data.shortName = shortName;
  if (status !== undefined) data.status = status;
  if (category !== undefined) data.category = category || null;
  if (region !== undefined) data.region = region;
  if (contactName !== undefined) data.contactName = contactName;
  if (phone !== undefined) data.phone = phone;
  if (email !== undefined) data.email = email;
  if (wechat !== undefined) data.wechat = wechat;
  if (address !== undefined) data.address = address;
  if (contactNote !== undefined) data.contactNote = contactNote;
  if (paymentCycle !== undefined) data.paymentCycle = paymentCycle;
  if (defaultLeadDays !== undefined) data.defaultLeadDays = defaultLeadDays != null ? Number(defaultLeadDays) : null;
  if (quoteUpdateCycleDays !== undefined) data.quoteUpdateCycleDays = quoteUpdateCycleDays != null ? Number(quoteUpdateCycleDays) : null;
  if (rating !== undefined) data.rating = rating != null ? Number(rating) : null;
  if (qualityScore !== undefined) data.qualityScore = qualityScore != null ? Number(qualityScore) : null;
  if (deliveryScore !== undefined) data.deliveryScore = deliveryScore != null ? Number(deliveryScore) : null;
  if (priceScore !== undefined) data.priceScore = priceScore != null ? Number(priceScore) : null;
  if (tagsJson !== undefined) data.tagsJson = tagsJson ? String(tagsJson) : null;
  if (preferenceNote !== undefined) data.preferenceNote = preferenceNote;
  if (riskNote !== undefined) data.riskNote = riskNote;
  if (archived !== undefined) data.archived = archived;

  const updated = await prisma.supplier.update({
    where: { id },
    data,
    select: getSupplierSelect(session.user.role),
  });

  return NextResponse.json({ supplier: updated });
}
