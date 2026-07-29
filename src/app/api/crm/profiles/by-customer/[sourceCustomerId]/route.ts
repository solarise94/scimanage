import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

/**
 * W5.1：按 sourceCustomerId 查 Profile 已退役。
 * 请使用 GET /api/crm/profiles/[profileId]。
 */
function gone() {
  return NextResponse.json(
    {
      error: "Gone",
      message: "GET /api/crm/profiles/by-customer/:sourceCustomerId 已退役，请使用 /api/crm/profiles/:profileId",
    },
    { status: 410 },
  );
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return gone();
}

export async function PATCH() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return gone();
}

export async function PUT() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return gone();
}

export async function DELETE() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return gone();
}
