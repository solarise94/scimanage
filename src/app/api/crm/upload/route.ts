import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { getMediaDir, type MediaOwnerType } from "@/lib/crm/media";

const MAX_MB = parseInt(process.env.CRM_VISIT_PHOTO_MAX_MB || "10", 10);

const ALLOWED_MIME_PREFIXES = ["image/", "audio/"];
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".webm", ".ogg", ".mp3", ".m4a", ".wav", ".aac"]);

const EXT_MIME: Record<string, string> = {
  ".webm": "audio/webm", ".ogg": "audio/ogg", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
  ".wav": "audio/wav", ".aac": "audio/aac",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif",
};

function isAllowedMime(mime: string): boolean {
  return ALLOWED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

function isAudioMime(mime: string): boolean {
  return mime.startsWith("audio/");
}

async function validateOwner(ownerType: string, ownerId: string, userId: string, role: string): Promise<{ ok: boolean; error: string; status: number }> {
  if (ownerType === "checkin") {
    const checkin = await prisma.crmVisitCheckin.findUnique({ where: { id: ownerId } });
    if (!checkin) return { ok: false, error: "Checkin not found", status: 404 };
    if (checkin.userId !== userId && role !== "ADMIN") return { ok: false, error: "Forbidden", status: 403 };
    return { ok: true, error: "", status: 200 };
  }
  if (ownerType === "interaction") {
    const interaction = await prisma.crmInteraction.findUnique({ where: { id: ownerId } });
    if (!interaction) return { ok: false, error: "Interaction not found", status: 404 };
    if (interaction.createdByUserId !== userId && role !== "ADMIN") return { ok: false, error: "Forbidden", status: 403 };
    return { ok: true, error: "", status: 200 };
  }
  return { ok: false, error: "Invalid ownerType", status: 400 };
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const ownerId = (formData.get("ownerId") as string) || (formData.get("checkinId") as string) || null;
  const ownerType = (formData.get("ownerType") as MediaOwnerType) || (formData.get("checkinId") ? "checkin" : null);

  if (!file || !ownerId || !ownerType) {
    return NextResponse.json({ error: "file, ownerId, and ownerType are required" }, { status: 400 });
  }

  if (file.size > MAX_MB * 1024 * 1024) {
    return NextResponse.json({ error: `文件大小不能超过 ${MAX_MB}MB` }, { status: 400 });
  }

  const ext = path.extname(file.name).toLowerCase() || ".jpg";
  if (!ALLOWED_EXT.has(ext)) {
    return NextResponse.json({ error: "不支持的文件格式" }, { status: 400 });
  }

  const mime = file.type || EXT_MIME[ext] || "application/octet-stream";
  if (mime && !isAllowedMime(mime)) {
    return NextResponse.json({ error: "不支持的文件格式" }, { status: 400 });
  }

  const auth = await validateOwner(ownerType, ownerId, session.user.id, session.user.role);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const dir = getMediaDir(ownerId, ownerType);
  await mkdir(dir, { recursive: true });

  const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  const filepath = path.join(dir, filename);

  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(filepath, buffer);

  const url = `/uploads/${ownerType === "interaction" ? "interactions" : "crm"}/${ownerId}/${filename}`;
  const audio = isAudioMime(mime);

  if (audio) {
    return NextResponse.json({
      media: { id: "", ownerId, url, mimeType: mime, size: file.size, createdAt: new Date().toISOString() },
      audio: true,
      ownerType,
    }, { status: 201 });
  }

  // Photos only for checkins
  if (ownerType === "checkin") {
    const media = await prisma.crmVisitMedia.create({
      data: {
        checkinId: ownerId,
        url,
        mimeType: mime,
        size: file.size,
      },
    });

    await prisma.crmVisitCheckin.update({
      where: { id: ownerId },
      data: { photoCount: { increment: 1 } },
    });

    return NextResponse.json({ media, audio: false, ownerType }, { status: 201 });
  }

  return NextResponse.json({
    media: { id: "", ownerId: ownerId, url, mimeType: mime, size: file.size, createdAt: new Date().toISOString() },
    audio: false,
    ownerType,
  }, { status: 201 });
}
