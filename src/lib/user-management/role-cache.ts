/**
 * 30-second TTL user auth context cache for JWT session callbacks.
 *
 * ## Why
 * The JWT callback in `src/lib/auth.ts` runs on every request. Without caching
 * it would issue a DB query per request. With a 30s TTL + active invalidation
 * on role/department writes, the cost drops to "at most one query per active user per 30s".
 *
 * ## Scope
 * This cache serves session role + department synchronisation. Sensitive management
 * write endpoints (user management, region-managers) always bypass the cache and
 * query the database directly — see `requireCurrentAdmin()` in `permissions.ts`.
 *
 * ## Active invalidation
 * Every application path that mutates `User.role` or `User.department` must call
 * `invalidateUserAuthContext` after the transaction commits:
 * - User management PUT (role or department change)
 * - Region-manager create / archive / restore (any branch, unconditional)
 *
 * If a role/department is changed by directly editing SQLite, the stale value
 * survives at most 30 seconds — this is an explicitly accepted operational window.
 */

import { prisma } from "@/lib/prisma";

const TTL_MS = 30_000;
const MAX_ENTRIES = 500;

interface CachedAuthContext {
  role: string;
  department: string;
  /** false means user does not exist */
  exists: boolean;
  expiresAt: number;
}

const cache = new Map<string, CachedAuthContext>();

function evictExpired() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
}

/**
 * Look up the current auth context (role + department) for a user, using a 30s TTL cache.
 * On cache miss queries the database.
 */
export async function getCachedUserAuthContext(userId: string): Promise<{
  role: string | null;
  department: string | null;
  exists: boolean;
}> {
  const now = Date.now();

  const cached = cache.get(userId);
  if (cached && cached.expiresAt > now) {
    return {
      role: cached.exists ? cached.role : null,
      department: cached.exists ? cached.department : null,
      exists: cached.exists,
    };
  }

  // Cache miss — query DB
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, department: true },
  });

  const entry: CachedAuthContext = user
    ? { role: user.role, department: user.department, exists: true, expiresAt: now + TTL_MS }
    : { role: "", department: "", exists: false, expiresAt: now + TTL_MS };

  // Evict expired entries before inserting, to keep within max size
  evictExpired();
  if (cache.size >= MAX_ENTRIES) {
    // Evict the oldest entry (first inserted) as a simple LRU-ish fallback
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(userId, entry);

  return {
    role: entry.exists ? entry.role : null,
    department: entry.exists ? entry.department : null,
    exists: entry.exists,
  };
}

/**
 * @deprecated Use {@link getCachedUserAuthContext} instead.
 * Kept for backward compatibility during migration.
 */
export async function getCachedUserRole(userId: string): Promise<{
  role: string | null;
  exists: boolean;
}> {
  const ctx = await getCachedUserAuthContext(userId);
  return { role: ctx.role, exists: ctx.exists };
}

/**
 * Invalidate the cached auth context for a specific user.
 * Must be called after any transaction that changes `User.role` or `User.department`.
 */
export function invalidateUserAuthContext(userId: string): void {
  cache.delete(userId);
}

/**
 * @deprecated Use {@link invalidateUserAuthContext} instead.
 */
export function invalidateUserRole(userId: string): void {
  cache.delete(userId);
}

/**
 * Invalidate all cached auth contexts. Intended for testing.
 */
export function invalidateAllAuthContexts(): void {
  cache.clear();
}

/**
 * @deprecated Use {@link invalidateAllAuthContexts} instead.
 */
export function invalidateAllRoles(): void {
  cache.clear();
}
