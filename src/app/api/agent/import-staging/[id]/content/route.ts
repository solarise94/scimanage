import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
  getOwnedImportStaging,
  readImportStagingBuffer,
} from "@/lib/import-staging";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden", code: "IMPORT_REQUEST_FORBIDDEN" }, { status: 403 });
  }

  try {
    const { id } = await params;
    const staging = await getOwnedImportStaging({
      stagingFileId: id,
      userId: session.user.id,
      requireActive: false,
    });

    // 不依赖 opportunistic sweep：只要 expiresAt 已过或终态就拒绝
    if (
      staging.expiresAt.getTime() <= Date.now()
      || staging.status === "EXPIRED"
      || staging.status === "FAILED"
    ) {
      return NextResponse.json({ error: "staging 已过期", code: "IMPORT_STAGING_EXPIRED" }, { status: 410 });
    }

    const buffer = await readImportStagingBuffer(staging);
    const body = new Uint8Array(buffer);

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": staging.mimeType,
        "Content-Length": String(buffer.length),
        "Content-Disposition": `inline; filename="${encodeURIComponent(staging.originalName)}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && "httpStatus" in err) {
      const e = err as { code: string; message: string; httpStatus: number };
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.httpStatus });
    }
    console.error("[import-staging] content failed:", err);
    return NextResponse.json({ error: "读取失败" }, { status: 500 });
  }
}
