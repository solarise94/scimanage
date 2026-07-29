import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await req.json().catch(() => ({}));

  // Temporarily disabled: the old "long-unvisited -> RECALL_CANDIDATE" pool
  // workflow conflicts with the current binding-derived representative model.
  // Lifecycle warning/dormant stage scan remains available at /api/crm/lifecycle/scan.
  return NextResponse.json({
    markedCount: 0,
    disabled: true,
    message: "长期未拜访进入客户流转池已暂时关闭",
  });
}
