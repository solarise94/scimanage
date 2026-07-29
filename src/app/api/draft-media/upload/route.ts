import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isRepresentative } from "@/lib/permissions";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { getDraftMediaDir, sweepExpiredMedia } from "@/lib/draft/media";

// Prefix-based matching to handle codec params (e.g. "audio/webm;codecs=opus")
const ALLOWED_PREFIXES = [
  "image/png", "image/jpeg", "image/webp",
  "audio/webm", "audio/ogg", "audio/wav", "audio/mp3", "audio/mpeg",
  "audio/m4a", "audio/mp4", "audio/aac", "audio/x-m4a",
];
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

function isAllowedType(mimeType: string): boolean {
  const base = mimeType.split(";")[0].trim().toLowerCase();
  return ALLOWED_PREFIXES.includes(base);
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isRepresentative(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "缺少文件" }, { status: 400 });
    }

    if (!isAllowedType(file.type)) {
      return NextResponse.json({ error: "仅支持图片（PNG/JPEG/WebP）和音频（WebM/OGG/WAV/MP3/M4A）" }, { status: 400 });
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: "文件大小不能超过 10MB" }, { status: 400 });
    }

    const userId = session.user.id;
    const nonce = randomBytes(4).toString("hex");
    const timestamp = Date.now();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
    const fileName = `${timestamp}_${nonce}_${safeName}`;
    const dir = getDraftMediaDir(userId);
    await mkdir(dir, { recursive: true });

    const buffer = Buffer.from(await file.arrayBuffer());
    const filePath = join(dir, fileName);
    await writeFile(filePath, buffer);

    // Non-blocking: sweep expired files on each upload
    sweepExpiredMedia().catch(() => {});

    return NextResponse.json({
      fileId: `${userId}_${timestamp}_${nonce}`,
      mimeType: file.type,
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "上传失败" }, { status: 500 });
  }
}
