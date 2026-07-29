import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { recomputeCostSnapshot } from "@/lib/costing/recompute";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { subjectType, subjectId } = body as Record<string, unknown>;

  if (!["ORDER", "PROJECT", "CUSTOMER"].includes(subjectType as string)) {
    return NextResponse.json({ error: "subjectType 必须为 ORDER / PROJECT / CUSTOMER" }, { status: 400 });
  }
  if (!subjectId) return NextResponse.json({ error: "subjectId 必填" }, { status: 400 });

  const result = await recomputeCostSnapshot({
    subjectType: subjectType as "ORDER" | "PROJECT" | "CUSTOMER",
    subjectId: subjectId as string,
  });

  return NextResponse.json({ recomputed: true, ...result });
}
