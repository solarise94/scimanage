import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";
import { StagingError } from "@/lib/staging-common";
import {
  getOwnedAgentAttachment,
  verifyAttachmentIntegrity,
} from "@/lib/agent-attachments/staging";

const INLINEABLE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

function contentDisposition(mimeType: string, filename: string): string {
  const encoded = encodeURIComponent(filename).replace(/'/g, "%27");
  if (INLINEABLE_MIME.has(mimeType)) return `inline; filename*=UTF-8''${encoded}`;
  return `attachment; filename*=UTF-8''${encoded}`;
}

/**
 * 通用附件 staging 内容端点：owner 鉴权，逐次校验所有权与完整性。
 * 永不返回 storageKey；图片可内联，PDF/Office/文本一律下载。
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const denied = requireAgentAccess(session);
  if (denied) return denied;

  const { id } = await params;
  try {
    const staging = await getOwnedAgentAttachment({ stagingId: id, userId: session!.user.id, requireActive: true });
    const buffer = await verifyAttachmentIntegrity({ staging });

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": staging.mimeType,
        "Content-Length": String(buffer.length),
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": contentDisposition(staging.mimeType, staging.originalName),
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (err) {
    if (err instanceof StagingError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.httpStatus });
    }
    console.error("[agent-attachments] content failed:", err);
    return NextResponse.json({ error: "读取失败" }, { status: 500 });
  }
}
