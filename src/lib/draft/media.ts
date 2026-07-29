/**
 * Draft media file resolution.
 * All draft images are stored under .draft-media/{userId}/ and referenced by fileId.
 * This module is the ONLY place that maps fileId → absolute path.
 */

import { join, normalize } from "path";
import { stat, unlink, readdir, rmdir } from "fs/promises";

let _draftMediaRoot: string;
function getDraftMediaRoot() {
  if (!_draftMediaRoot) {
    _draftMediaRoot = process.env.DRAFT_MEDIA_DIR
      || join(process.cwd(), ".draft-media");
  }
  return _draftMediaRoot;
}
const TTL_MS = 60 * 60 * 1000; // 1 hour

/** Build the storage directory for a user. */
export function getDraftMediaDir(userId: string): string {
  return join(getDraftMediaRoot(), userId);
}

/**
 * Resolve a fileId to an absolute file path with strict validation.
 * Returns null if the file doesn't exist or the path escapes the sandbox.
 */
export async function resolveDraftMediaPath(
  fileId: string,
  userId: string,
): Promise<string | null> {
  // fileId format: {userId}_{timestamp}_{nonce}
  const parts = fileId.split("_");
  if (parts.length < 3) return null;

  const fileUserId = parts[0];
  // Ensure the fileId belongs to this user
  if (fileUserId !== userId) return null;

  const timestamp = parts[1];
  const nonce = parts[2];
  if (!/^\d+$/.test(timestamp) || !/^[a-f0-9]+$/.test(nonce)) return null;

  const dir = getDraftMediaDir(userId);
  const prefix = `${timestamp}_${nonce}_`;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  const match = entries.find((e) => e.startsWith(prefix));
  if (!match) return null;

  const filePath = normalize(join(dir, match));
  const normalizedRoot = normalize(getDraftMediaRoot());

  // Path traversal guard
  if (!filePath.startsWith(normalizedRoot)) return null;

  try {
    await stat(filePath);
  } catch {
    return null;
  }

  return filePath;
}

/**
 * Delete a draft media file after processing.
 * Silently ignores missing files. Cleans up empty user directory.
 */
export async function deleteDraftMediaFile(filePath: string): Promise<void> {
  const normalizedRoot = normalize(getDraftMediaRoot());
  const normalizedPath = normalize(filePath);

  // Safety: only delete files under the draft media root
  if (!normalizedPath.startsWith(normalizedRoot)) return;

  try {
    await unlink(filePath);
  } catch {
    // File already gone — fine
  }

  // Try to clean up empty user directory
  const dir = join(filePath, "..");
  try {
    const remaining = await readdir(dir);
    if (remaining.length === 0) await rmdir(dir);
  } catch {
    // Not empty or already gone — fine
  }
}

/**
 * Sweep expired draft media files (older than TTL).
 * Runs opportunistically — call from upload route, non-blocking.
 */
export async function sweepExpiredMedia(): Promise<void> {
  const now = Date.now();
  let userDirs: string[];
  try {
    userDirs = await readdir(getDraftMediaRoot());
  } catch {
    return; // Root doesn't exist yet
  }

  for (const userDir of userDirs) {
    const dirPath = join(getDraftMediaRoot(), userDir);
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }

    for (const file of files) {
      // Extract timestamp from filename: {timestamp}_{nonce}_{safeName}
      const tsMatch = file.match(/^(\d+)_/);
      if (!tsMatch) continue;
      const fileTs = parseInt(tsMatch[1], 10);
      if (now - fileTs > TTL_MS) {
        const filePath = join(dirPath, file);
        await unlink(filePath).catch(() => {});
      }
    }

    // Clean up empty dir
    try {
      const remaining = await readdir(dirPath);
      if (remaining.length === 0) await rmdir(dirPath);
    } catch {
      // fine
    }
  }
}
