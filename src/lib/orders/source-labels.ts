/**
 * Unified source-label helpers for order imports.
 *
 * Internal `source` codes (MANUAL, PINGOODMICE, OTHER_IMPORT) are stable
 * and MUST NOT be exposed in UI. Use these functions for all user-facing
 * source display so brand names stay out of pages, menus, and exports.
 */

const INTERNAL_LABELS: Record<string, string> = {
  MANUAL: "手动",
  PINGOODMICE: "平台导入",
  OTHER_IMPORT: "外部导入",
  CONTRACT_LEDGER: "合同台账",
};

const PUBLIC_LABELS: Record<string, string> = {
  MANUAL: "手动",
  PINGOODMICE: "平台导入",
  OTHER_IMPORT: "外部导入",
  CONTRACT_LEDGER: "合同台账",
};

/** Internal label for admin-only / debugging contexts (may still reference the raw code). */
export function getOrderSourceLabel(source: string): string {
  return INTERNAL_LABELS[source] || source;
}

/** Public-facing label: never exposes brand names. */
export function getOrderSourcePublicLabel(source: string): string {
  return PUBLIC_LABELS[source] || "外部导入";
}

function looksLikeDebugImportRemark(sourceRemark: string): boolean {
  return /^file=.*;sheet=.*;tag=.*$/.test(sourceRemark.trim());
}

/**
 * Best-effort display label for an order's source:
 * prefers user-facing sourcePlatform, avoids exposing debug import metadata,
 * and otherwise falls back to the public label.
 */
export function getOrderSourceDisplay(
  source: string,
  sourcePlatform?: string | null,
  sourceRemark?: string | null,
): string {
  if (sourcePlatform?.trim()) return sourcePlatform.trim();
  if (sourceRemark?.trim() && !looksLikeDebugImportRemark(sourceRemark)) {
    return sourceRemark.trim();
  }
  return getOrderSourcePublicLabel(source);
}
