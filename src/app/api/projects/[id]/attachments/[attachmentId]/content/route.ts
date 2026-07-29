import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { canReadProject } from "@/lib/permissions";
import { StagingError } from "@/lib/staging-common";
import { readOwnedReadyAttachment } from "@/lib/projects/application/project-attachments";

/** 仅图片可内联预览；PDF/Office/其余一律按附件下载，不在浏览器内联（防 XSS/脚本内联）。 */
const INLINEABLE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

function contentDisposition(mimeType: string, filename: string): string {
  const encoded = encodeURIComponent(filename).replace(/'/g, "%27");
  if (INLINEABLE_MIME.has(mimeType)) {
    return `inline; filename*=UTF-8''${encoded}`;
  }
  return `attachment; filename*=UTF-8''${encoded}`;
}

/**
 * 私有项目附件内容端点：同源、逐次鉴权（canReadProject）。
 * 历史公开附件不走此端点（仍按原静态 url）。
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, attachmentId } = await params;

  const canRead = await canReadProject(id, session.user.id, session.user.role);
  if (!canRead) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const { buffer, filename, mimeType } = await readOwnedReadyAttachment({
      projectId: id,
      attachmentId,
    });

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(buffer.length),
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": contentDisposition(mimeType, filename),
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    if (error instanceof StagingError) {
      return NextResponse.json({ error: error.message }, { status: error.httpStatus });
    }
    console.error(error);
    return NextResponse.json({ error: "Failed to read attachment" }, { status: 500 });
  }
}
