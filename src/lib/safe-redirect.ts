/**
 * Validate and sanitize a redirect target to prevent open redirect attacks.
 *
 * Accepts:
 *   - Simple relative paths like /dashboard, /projects/123
 *   - Same-origin absolute URLs (canonicalized back to relative)
 *
 * Rejects:
 *   - Protocol-relative URLs (//evil.com)
 *   - Backslash attacks (/\evil.com — browsers normalize \ to /)
 *   - Cross-origin absolute URLs
 *   - javascript: / data: schemes
 */
function isSafeRelativePath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\");
}

function getCurrentOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin;
}

export function getSafeRedirect(
  raw: string | null | undefined,
  fallback = "/dashboard",
  origin = getCurrentOrigin(),
): string {
  if (!raw) return fallback;

  // Fast path: simple relative paths
  if (isSafeRelativePath(raw)) {
    return raw;
  }

  if (!origin) return fallback;

  // Canonicalize full URLs through the URL parser, then re-check
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin) return fallback;
    const path = `${url.pathname}${url.search}${url.hash}`;
    if (!isSafeRelativePath(path)) return fallback;
    return path;
  } catch {
    return fallback;
  }
}
