/**
 * Phase 6 — authentication for the OpenAI-compatible read-only facade
 * (execution plan §8.3 / design §11).
 *
 * Design goals:
 *  - endpoint is disabled by default (404) until AGENT_OPENAI_COMPAT_ENABLED=true.
 *  - a missing API key is treated as "disabled" (404), NOT a 500 — so an
 *    unconfigured prod deployment never accidentally exposes an unauthenticated
 *    endpoint (fail-closed, design §11.2 / §11.3).
 *  - the API key is compared in constant time (crypto.timingSafeEqual) to avoid
 *    timing side-channels.
 *  - the key comes ONLY from env/secrets (AGENT_OPENAI_COMPAT_API_KEY); never
 *    from the request body, query, or a DB token table.
 *  - the trusted BusinessActor is resolved live from AGENT_OPENAI_COMPAT_USER_ID
 *    via resolveCurrentBusinessActor() — role/department are refreshed from the
 *    DB every request. body.user / token-carried role snapshots are NEVER trusted.
 *
 * No new DB token table, no new npm dependency.
 */
import { timingSafeEqual } from "crypto";
import type { BusinessActor } from "@/lib/application/actor";
import { resolveCurrentBusinessActor } from "@/lib/application/actor";

/** Default facade model id (product facade; hides the underlying MiniMax model). */
export const DEFAULT_OPENAI_COMPAT_MODEL_ID = "scimanage-agent" as const;

/**
 * Env-like record accepted by the config readers. Uses a permissive shape so
 * tests can pass partial env objects; production passes `process.env`.
 */
export type OpenAiCompatEnv = Record<string, string | undefined>;

export interface OpenAiCompatConfig {
  enabled: boolean;
  /** Configured API key (empty string when not set). */
  apiKey: string;
  /** Configured bound user id (empty string when not set). */
  userId: string;
  /** Facade model id (defaults to scimanage-agent). */
  modelId: string;
}

/**
 * Read the facade configuration from the environment. Pure (no I/O).
 *
 * Notes:
 *  - `enabled` is true ONLY when the flag is explicitly truthy AND both
 *    API_KEY and USER_ID are non-empty. This is the fail-closed contract: a
 *    misconfigured endpoint returns 404, never an unauthenticated 200.
 */
export function readOpenAiCompatConfig(env: OpenAiCompatEnv = process.env): OpenAiCompatConfig {
  const flagRaw = (env.AGENT_OPENAI_COMPAT_ENABLED ?? "").trim().toLowerCase();
  const enabledFlag =
    flagRaw === "true" || flagRaw === "1" || flagRaw === "yes" || flagRaw === "on";
  const apiKey = (env.AGENT_OPENAI_COMPAT_API_KEY ?? "").trim();
  const userId = (env.AGENT_OPENAI_COMPAT_USER_ID ?? "").trim();
  const modelId = (env.AGENT_OPENAI_COMPAT_MODEL_ID ?? "").trim() || DEFAULT_OPENAI_COMPAT_MODEL_ID;
  // Fail-closed: flag alone is not enough; key + user must be configured.
  const enabled = enabledFlag && apiKey.length > 0 && userId.length > 0;
  return { enabled, apiKey, userId, modelId };
}

/**
 * Constant-time string comparison. Returns false when lengths differ (length
 * itself is not secret here; content is). Guards against timing attacks on the
 * API key while never throwing on malformed input.
 */
export function safeEqualSecret(expected: string, candidate: string): boolean {
  if (expected.length === 0) return false;
  if (expected.length !== candidate.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(candidate));
  } catch {
    return false;
  }
}

export type OpenAiCompatAuthResult =
  | { ok: true; actor: BusinessActor; config: OpenAiCompatConfig }
  | { ok: false; status: 404 | 401; code: string; error: string };

/**
 * Authenticate an OpenAI-compatible request.
 *
 * Flow:
 *  1. resolve config (env). disabled / misconfigured → 404.
 *  2. extract Bearer token from Authorization header. missing → 401.
 *  3. constant-time compare. mismatch → 401.
 *  4. resolve the live BusinessActor for the configured USER_ID. The actor's
 *     role/department are refreshed from the DB; body.user is ignored entirely.
 *
 * Returns a discriminated result so routes can map cleanly to HTTP 404/401.
 */
export async function authenticateOpenAiCompatRequest(
  authorizationHeader: string | null | undefined,
  env: OpenAiCompatEnv = process.env,
): Promise<OpenAiCompatAuthResult> {
  const config = readOpenAiCompatConfig(env);
  if (!config.enabled) {
    // Disabled (or misconfigured: flag on but key/user missing). Fail-closed 404
    // so the endpoint is invisible to callers rather than leaking auth state.
    return {
      ok: false,
      status: 404,
      code: "OPENAI_COMPAT_DISABLED",
      error: "Not Found",
    };
  }

  const presented = extractBearerToken(authorizationHeader);
  if (presented === null) {
    return {
      ok: false,
      status: 401,
      code: "MISSING_API_KEY",
      error: "Missing Authorization Bearer token",
    };
  }
  if (!safeEqualSecret(config.apiKey, presented)) {
    return {
      ok: false,
      status: 401,
      code: "INVALID_API_KEY",
      error: "Invalid API key",
    };
  }

  // Resolve the live actor from the configured USER_ID. Role/department come
  // straight from User row; body.user / token role snapshots are never trusted.
  try {
    const actor = await resolveCurrentBusinessActor({
      userId: config.userId,
      channel: "agent",
    });
    return { ok: true, actor, config };
  } catch {
    // The configured user no longer exists / is archived. Fail-closed 401.
    return {
      ok: false,
      status: 401,
      code: "ACTOR_UNRESOLVABLE",
      error: "Configured facade actor could not be resolved",
    };
  }
}

/** Extract the raw token from an `Authorization: Bearer <token>` header. */
export function extractBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}
