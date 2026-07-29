import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
  getOwnedStagingFile,
  readStagingFileBuffer,
} from "@/lib/finance/invoice-staging";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden", code: "INVOICE_REQUEST_FORBIDDEN" }, { status: 403 });
  }

  try {
    const { id } = await params;
    const staging = await getOwnedStagingFile({
      stagingFileId: id,
      userId: session.user.id,
      requireActive: false,
    });

    // 不依赖 opportunistic sweep：只要 expiresAt 已过就拒绝预览
    if (
      staging.expiresAt.getTime() <= Date.now()
      || staging.status === "EXPIRED"
      || staging.status === "SKIPPED"
    ) {
      return NextResponse.json({ error: "staging 已过期", code: "INVOICE_STAGING_EXPIRED" }, { status: 410 });
    }

    const buffer = await readStagingFileBuffer(staging.storageKey);
    const body = new Uint8Array(buffer);

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": staging.mimeType,
        "Content-Length": String(buffer.length),
        "Content-Disposition": `inline; filename="${encodeURIComponent(staging.originalFileName)}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && "httpStatus" in err) {
      const e = err as { code: string; message: string; httpStatus: number };
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.httpStatus });
    }
    console.error("[invoice-staging] content failed:", err);
    return NextResponse.json({ error: "读取失败" }, { status: 500 });
  }
}
