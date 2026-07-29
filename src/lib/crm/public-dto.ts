/**
 * Public DTO helpers for CRM objects returned to the browser.
 *
 * Phase E contract：Customer 锚点模型与全部旧 `*CustomerId*` 列已物理删除，
 * DB 查询结果不再携带旧锚点键，以下函数全部为直通实现；保留函数签名以避免改调用方。
 */

/** Profile list/detail payload（直通）。 */
export function toPublicProfile<T extends Record<string, unknown>>(profile: T) {
  return profile;
}

/** Relation row payload（直通）：端点使用 fromProfileId/toProfileId + 展示名。 */
export function toPublicRelation<T extends Record<string, unknown>>(relation: T) {
  return relation;
}

/** Order payload（直通）：运行时只认 Order.profileId。 */
export function toPublicOrder<T extends Record<string, unknown>>(order: T): T {
  return order;
}

/** Application payload（直通）：运行时只认 createdCrmProfileId。 */
export function toPublicApplication<T extends Record<string, unknown>>(
  application: T | null | undefined,
) {
  return application;
}

export function toPublicFollowUpProfile(profile: {
  id: string;
  name: string | null;
  customerCode: string | null;
  [key: string]: unknown;
}) {
  return {
    id: profile.id,
    name: profile.name,
    customerCode: profile.customerCode,
  };
}
