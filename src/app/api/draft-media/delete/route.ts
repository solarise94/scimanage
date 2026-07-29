import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { resolveDraftMediaPath, deleteDraftMediaFile } from "@/lib/draft/media";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { fileId } = await req.json();
    if (!fileId || typeof fileId !== "string") {
      return NextResponse.json({ error: "缺少 fileId" }, { status: 400 });
    }

    const userId = session.user.id;
    const filePath = await resolveDraftMediaPath(fileId, userId);
    if (!filePath) {
      // File already gone or doesn't belong to user — treat as success
      return NextResponse.json({ ok: true });
    }

    await deleteDraftMediaFile(filePath);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "删除失败" }, { status: 500 });
  }
}
