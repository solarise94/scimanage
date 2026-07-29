import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertCrmProfileAccess } from "@/lib/crm/permissions";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  try {
    await assertCrmProfileAccess(id, session.user.id, session.user.role);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "NOT_FOUND") return NextResponse.json({ error: "Profile not found" }, { status: 404 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const addresses = await prisma.crmCustomerAddress.findMany({
    where: { profileId: id },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
  });

  return NextResponse.json({ addresses });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  try {
    await assertCrmProfileAccess(id, session.user.id, session.user.role);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "NOT_FOUND") return NextResponse.json({ error: "Profile not found" }, { status: 404 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { label, addressText, province, city, district, lat, lng, accuracy, sourceType, isPrimary } = body;

  if (isPrimary) {
    await prisma.crmCustomerAddress.updateMany({
      where: { profileId: id, isPrimary: true },
      data: { isPrimary: false },
    });
  }

  const address = await prisma.crmCustomerAddress.create({
    data: {
      profileId: id,
      label: label || "默认",
      addressText: addressText || null,
      province: province || null,
      city: city || null,
      district: district || null,
      lat: lat ?? null,
      lng: lng ?? null,
      accuracy: accuracy ?? null,
      sourceType: sourceType || "MANUAL",
      isPrimary: isPrimary || false,
    },
  });

  return NextResponse.json({ address }, { status: 201 });
}
