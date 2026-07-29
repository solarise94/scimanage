import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * Validate a representative magic link token WITHOUT consuming it.
 * Read-only — does not create a session, does not clear the token.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");

  if (!token) {
    return NextResponse.json({ valid: false, reason: "MISSING" }, { status: 400 });
  }

  const rep = await prisma.representative.findUnique({
    where: { token },
    select: { id: true, email: true, archived: true, tokenExpiresAt: true },
  });

  if (!rep) {
    console.log(`[MAGIC_LINK] action=validate suffix=${token.slice(-6)} result=INVALID`);
    return NextResponse.json({ valid: false, reason: "INVALID" });
  }

  if (rep.archived) {
    console.log(`[MAGIC_LINK] action=validate rep=${rep.email} suffix=${token.slice(-6)} result=ARCHIVED`);
    return NextResponse.json({ valid: false, reason: "ARCHIVED" });
  }

  if (!rep.tokenExpiresAt || rep.tokenExpiresAt < new Date()) {
    console.log(`[MAGIC_LINK] action=validate rep=${rep.email} suffix=${token.slice(-6)} result=EXPIRED`);
    return NextResponse.json({ valid: false, reason: "EXPIRED", expiresAt: rep.tokenExpiresAt?.toISOString() });
  }

  console.log(`[MAGIC_LINK] action=validate rep=${rep.email} suffix=${token.slice(-6)} result=ok`);
  return NextResponse.json({
    valid: true,
    expiresAt: rep.tokenExpiresAt.toISOString(),
  });
}
