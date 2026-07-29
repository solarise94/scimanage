import type { FormFieldSchema } from "./form-schemas/types";

const SEARCH_CONFIDENCE_THRESHOLD = 0.6;

export function shouldSearch(
  fieldSchema: FormFieldSchema,
  value: unknown,
  confidence: number,
): boolean {
  if (!fieldSchema.searchable) return false;
  // Entity fields: skip search if already matched; allow search if unmatched (no candidates)
  if (fieldSchema.entityType && typeof value === "object" && value !== null) {
    const entity = value as { matched?: boolean; candidates?: unknown[] };
    if (entity.matched) return false;
    if (entity.candidates && entity.candidates.length > 0) return false;
    // Unmatched with no candidates — search might help
    return true;
  }
  if (!value || (typeof value === "string" && !value.trim())) return true;
  return confidence < SEARCH_CONFIDENCE_THRESHOLD;
}

export function buildSearchQuery(
  fieldKey: string,
  value: unknown,
): string {
  // Handle entity objects
  if (typeof value === "object" && value !== null && "name" in value) {
    const name = (value as { name?: string }).name || "";
    if (fieldKey === "organization" && name) return `${name} 机构 地址 官方信息`;
    return name;
  }
  const v = typeof value === "string" ? value.trim() : "";
  if (fieldKey === "organization" && v) {
    return `${v} 机构 地址 官方信息`;
  }
  return v;
}
