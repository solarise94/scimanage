import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertCrmProfileAccess } from "@/lib/crm/permissions";
import { reverseGeocode } from "@/lib/crm/geocode";

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

  const checkins = await prisma.crmVisitCheckin.findMany({
    where: { profileId: id },
    include: {
      media: true,
      user: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ checkins });
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
  const { lat, lng, accuracy } = body;

  let addressSnapshot: string | null = null;
  let mapProvider: string | null = null;

  if (lat != null && lng != null) {
    const geo = await reverseGeocode(lat, lng);
    if (geo.result) {
      addressSnapshot = geo.result.address;
      mapProvider = "amap";
    }
  }

  const checkin = await prisma.crmVisitCheckin.create({
    data: {
      profileId: id,
      userId: session.user.id,
      lat: lat ?? null,
      lng: lng ?? null,
      accuracy: accuracy ?? null,
      addressSnapshot,
      mapProvider,
      status: "DRAFT",
    },
    include: {
      media: true,
      user: { select: { id: true, name: true } },
    },
  });

  return NextResponse.json({ checkin }, { status: 201 });
}
