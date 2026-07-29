/**
 * Normalize organization names for consistent matching.
 * Handles: invisible format chars, NFKC, full/half-width, whitespace, common punctuation, parentheses.
 *
 * Matching-key contract ({@link normalizeOrgName}):
 *   strip Cf → NFKC → Chinese parens → fold whitespace → trim
 * Used by Organization.normalizedName / OrganizationAlias.normalizedAlias,
 * organization-resolver exact match, list API keySearch, and unicode backfill.
 *
 * Lookup ({@link normalizeOrganizationLookupText}) adds zh-CN lowercase for
 * UI substring search; it must not diverge on NFKC / invisible handling.
 */

/** Strip Unicode format characters (Cf) and combining grapheme joiner. */
export function stripInvisibleFormatCharacters(input: string): string {
  return input.replace(/[\p{Cf}\u034f]/gu, "");
}

/**
 * Search/lookup normalization: same base as matching key + zh-CN lower.
 * Used by UI/API substring search.
 */
export function normalizeOrganizationLookupText(input: string): string {
  return normalizeOrgName(input).toLocaleLowerCase("zh-CN");
}

/** True when haystack contains needle after {@link normalizeOrganizationLookupText}. */
export function organizationLookupIncludes(haystack: string, needle: string): boolean {
  const n = normalizeOrganizationLookupText(needle);
  if (!n) return true;
  return normalizeOrganizationLookupText(haystack).includes(n);
}

/** List invisible / suspicious code points as U+XXXX for diagnostics (read-only UI). */
export function listInvisibleUnicodeCodePoints(input: string): string[] {
  const out: string[] = [];
  for (const ch of input) {
    const cp = ch.codePointAt(0);
    if (cp == null) continue;
    if (/\p{Cf}/u.test(ch) || cp === 0x034f || cp === 0x00a0) {
      out.push(`U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
    }
  }
  return out;
}

export function hasInvisibleUnicodeCharacters(input: string): boolean {
  return listInvisibleUnicodeCodePoints(input).length > 0;
}

/**
 * Matching-key normalization for Organization.normalizedName / alias keys.
 * Must stay identical across resolver, API search key, and backfill scripts.
 */
export function normalizeOrgName(input: string): string {
  let s = stripInvisibleFormatCharacters(input)
    .normalize("NFKC")
    .trim();

  // Chinese parentheses → ASCII (NFKC does not map these)
  s = s.replace(/（/g, "(").replace(/）/g, ")");

  // Collapse all Unicode whitespace (incl. NBSP / ideographic space after NFKC)
  s = s.replace(/\p{White_Space}+/gu, " ");

  return s.trim();
}

/**
 * Normalize organization SITE (校区/院区/园区) names. Stricter than
 * {@link normalizeOrgName}: it inherits the base normalization, then additionally:
 *  - strips parenthetical notes:        "医学院(主校区)"      → "医学院"
 *  - normalizes the trailing near-synonym suffixes 院区/分校 → 校区,
 *    consuming any space before the suffix: " 滨文 院区 "   → "滨文校区"
 *  - PRESERVES the middle dot "·" — it is a hierarchy marker, so
 *    "紫金港校区·药学院" stays distinct from "紫金港校区".
 *
 * Deterministic and pure: same input always yields the same output, and it
 * performs only textual normalization (no semantic judgement). Used to compute
 * `OrganizationSite.normalizedSiteName`, which is part of the unique key
 * `@@unique([organizationId, normalizedSiteName])`.
 */
export function normalizeSiteName(input: string): string {
  let s = normalizeOrgName(input);

  // Strip parenthetical notes, e.g. "医学院(主校区)" → "医学院".
  s = s.replace(/\([^)]*\)/g, "");

  // Re-collapse whitespace that paren removal may have left behind.
  s = s.replace(/\p{White_Space}+/gu, " ").trim();

  // Normalize the trailing near-synonym suffixes 院区/分校 → 校区, consuming any
  // preceding whitespace so "滨文 院区" → "滨文校区". Only the end-of-string suffix
  // is touched; an internal "院区" before a "·" hierarchy marker is preserved.
  s = s.replace(/\s*(?:院区|分校)$/, "校区");

  return s.trim();
}
