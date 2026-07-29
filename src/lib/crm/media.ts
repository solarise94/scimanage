import path from "path";
import { existsSync } from "fs";

const AUDIO_EXTS = new Set([".webm", ".ogg", ".mp3", ".m4a", ".wav", ".aac"]);

export type MediaOwnerType = "checkin" | "interaction";

export function getMediaDir(ownerId: string, ownerType: MediaOwnerType = "checkin"): string {
  const dirName = ownerType === "interaction" ? "interactions" : "crm";
  return path.join(process.cwd(), "public", "uploads", dirName, ownerId);
}

export function validateVoiceUrl(voiceUrl: string, ownerId: string, ownerType: MediaOwnerType = "checkin"): boolean {
  if (!voiceUrl.startsWith("/")) return false;
  const dirName = ownerType === "interaction" ? "interactions" : "crm";
  const expectedPrefix = `/uploads/${dirName}/${ownerId}/`;
  if (!voiceUrl.startsWith(expectedPrefix)) return false;

  const filename = voiceUrl.slice(expectedPrefix.length);
  if (!filename || filename.includes("/") || filename.includes("..")) return false;

  const ext = path.extname(filename).toLowerCase();
  if (!AUDIO_EXTS.has(ext)) return false;

  const filePath = path.join(process.cwd(), "public", voiceUrl.slice(1));
  return existsSync(filePath);
}

export function resolveFilePath(voiceUrl: string, ownerId: string, ownerType: MediaOwnerType = "checkin"): string | null {
  if (!validateVoiceUrl(voiceUrl, ownerId, ownerType)) return null;
  return path.join(process.cwd(), "public", voiceUrl.slice(1));
}

// Backward-compatible wrappers for existing checkin-only code
export function validateCheckinVoiceUrl(voiceUrl: string, checkinId: string): boolean {
  return validateVoiceUrl(voiceUrl, checkinId, "checkin");
}

export function resolveCheckinFilePath(voiceUrl: string, checkinId: string): string | null {
  return resolveFilePath(voiceUrl, checkinId, "checkin");
}

export function getCheckinDir(checkinId: string): string {
  return getMediaDir(checkinId, "checkin");
}
