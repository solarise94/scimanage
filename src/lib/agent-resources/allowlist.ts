/**
 * Route allowlist shared by the Agent resource resolver and the view-intents
 * apply route.  Kept here (not inside the route file) so both the server route
 * and any client-side navigation guard reference the same source of truth.
 *
 * These are *list root paths* only — detail pages are reached through the
 * entity resolver (`resolveEntityLocation`), not through this allowlist.
 */
export const NAV_ROUTE_ALLOWLIST = [
  /^\/agent$/,
  /^\/projects$/,
  /^\/orders$/,
  /^\/crm\/customers$/,
  /^\/crm\/follow-ups$/,
  /^\/finance\/invoices$/,
  /^\/tickets$/,
] as const;

export function isAllowedNavigateRoute(route: string): boolean {
  return NAV_ROUTE_ALLOWLIST.some((pattern) => pattern.test(route));
}
