/**
 * User management role constants and policies.
 *
 * These constants are the single source of truth for which roles the user
 * management subsystem accepts. They are intentionally separate from the
 * client-safe predicates in `src/lib/role-guards.ts` (which cover all roles)
 * because user management only creates and edits internal USER / ADMIN accounts.
 */

/** All known roles in the system. Used for validation / display only. */
export const KNOWN_USER_ROLES = [
  "ADMIN",
  "USER",
  "REPRESENTATIVE",
  "REGIONAL_MANAGER",
] as const;

/** Roles that an ADMIN can create via user management. */
export const ADMIN_CREATABLE_USER_ROLES = ["ADMIN", "USER"] as const;

/** Roles that an ADMIN can set when editing an existing internal user. */
export const ADMIN_EDITABLE_USER_ROLES = ["ADMIN", "USER"] as const;

/** Roles managed by sales lifecycle, not user management. */
export const SALES_MANAGED_ROLES = ["REPRESENTATIVE", "REGIONAL_MANAGER"] as const;

export type UserRole = (typeof KNOWN_USER_ROLES)[number];
export type AdminCreatableRole = (typeof ADMIN_CREATABLE_USER_ROLES)[number];

export function isKnownRole(role: unknown): role is UserRole {
  return typeof role === "string" && (KNOWN_USER_ROLES as readonly string[]).includes(role);
}

export function isAdminCreatableRole(role: unknown): role is AdminCreatableRole {
  return (
    typeof role === "string" &&
    (ADMIN_CREATABLE_USER_ROLES as readonly string[]).includes(role)
  );
}

export function isAdminEditableRole(role: unknown): boolean {
  return (
    typeof role === "string" &&
    (ADMIN_EDITABLE_USER_ROLES as readonly string[]).includes(role)
  );
}

export function isSalesManagedRole(role: unknown): boolean {
  return (
    typeof role === "string" &&
    (SALES_MANAGED_ROLES as readonly string[]).includes(role)
  );
}
