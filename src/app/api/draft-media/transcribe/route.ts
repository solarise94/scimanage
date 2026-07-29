import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isRepresentative } from "@/lib/permissions";
import { resolveDraftMediaPath, deleteDraftMediaFile } from "@/lib/draft/media";
import { getVisionProvider, isDraftAIConfigured } from "@/lib/draft/providers";

const VISION_PROMPT =
  "提取图片中所有文字信息，包括表格数据、数字、日期、人名、机构名。不要总结，不要猜测，只提取可见内容。保留原始格式。";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isRepresentative(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isDraftAIConfigured()) {
    return NextResponse.json({ error: "AI 未配置" }, { status: 503 });
  }

  let filePath: string | null = null;
  try {
    const { fileId } = await req.json();
    if (!fileId || typeof fileId !== "string") {
      return NextResponse.json({ error: "缺少 fileId" }, { status: 400 });
    }

    const userId = session.user.id;
    filePath = await resolveDraftMediaPath(fileId, userId);
    if (!filePath) {
      return NextResponse.json({ error: "文件不存在或无权访问" }, { status: 404 });
    }

    const vision = getVisionProvider();
    const result = await vision.extractText({ imageUrl: filePath, prompt: VISION_PROMPT });

    return NextResponse.json({ text: result.text });
  } catch (error) {
    console.error("图片 OCR 失败:", error);
    const msg = error instanceof Error ? error.message : "识别失败";
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    // Always clean up temp file, whether success or failure
    if (filePath) await deleteDraftMediaFile(filePath);
  }
}
