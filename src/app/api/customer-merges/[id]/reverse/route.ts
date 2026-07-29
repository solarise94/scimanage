import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { reverseMerge } from "@/lib/customers/customer-merge";

/** POST /api/customer-merges/[id]/reverse — reverse a merge */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const currentUser = await prisma.user.findUnique({ where: { id: session.user.id }, select: { id: true, role: true } });
  if (!currentUser || currentUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const reason = body.reason || "管理员撤销";

  try {
    await reverseMerge(id, currentUser.id, reason);
    return NextResponse.json({ reversed: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "撤销失败" }, { status: 400 });
  }
}
