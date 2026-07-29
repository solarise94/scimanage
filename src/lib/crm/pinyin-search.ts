/**
 * Pinyin fuzzy search for Chinese customer names.
 *
 * When Prisma `contains` returns too few results, this module provides
 * a fallback that matches the search query against pinyin initials of
 * customer names (e.g. "zsy" matches "张三阳").
 *
 * Uses `pinyin-match` for efficient pinyin initial matching.
 */

import PinyinMatch from "pinyin-match";

export interface PinyinSearchable {
  id: string;
  name: string;
  customerCode?: string;
  organization?: string | null;
  principal?: string | null;
}

/**
 * Filter items whose `name` matches the search query via pinyin initials.
 * Returns only items NOT already present in `existingIds`.
 */
export function filterByPinyin<T extends PinyinSearchable>(
  items: T[],
  search: string,
  existingIds: Set<string>,
): T[] {
  if (!search) return [];
  const lowerSearch = search.toLowerCase();
  return items.filter((item) => {
    if (existingIds.has(item.id)) return false;
    return PinyinMatch.match(item.name, lowerSearch) !== false;
  });
}
