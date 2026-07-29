import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rep = await prisma.representative.findFirst({
    where: { email: session.user.email || "", archived: false },
    select: { id: true, name: true, email: true },
  });

  if (!rep) {
    return NextResponse.json({ error: "Representative not found" }, { status: 404 });
  }

  return NextResponse.json({ representativeId: rep.id, name: rep.name, email: rep.email });
}
