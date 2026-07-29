/**
 * Phase 6 — server-side hard read-only policy for the OpenAI-compatible facade
 * (execution plan §8.4 / design §10.8 / §11).
 *
 * Two independent hard gates, BOTH enforced server-side (never just in the
 * prompt / tool list):
 *
 *  Layer 1 (Runner, tool injection): an OPENAI_COMPAT run only ever injects
 *    public manifest tools whose `kind` is discovery or context. The model
 *    literally never sees propose/preview/workflow/confirm tools.
 *
 *  Layer 2 (public executor, enforcement): even if the model hand-crafts a
 *    publicToolKey for a write tool (propose/preview/workflow/confirm), the
 *    executor refuses with 403 BEFORE the facade handler runs. The trusted
 *    AgentRun.source is read from the DB (never from the request body), so a
 *    forged `source` field has no effect.
 *
 * Native CHAT runs are completely unaffected by both layers.
 *
 * Constraints:
 *  - this module is Prisma-free (it consumes an already-resolved `source`);
 *    the actual DB read of AgentRun.source happens in the public executor's
 *    application-service helper (getExecutionContextFromAgentRun) so route /
 *    facade code never touches Prisma directly (agent-boundary scanner).
 *  - canonical service scope gate (id AND actorScope) remains the FINAL
 *    permission boundary; this policy only narrows the tool surface.
 *  - no new DB token table, no new npm dependency.
 */
import type { PublicToolKind, PublicToolManifestEntry } from "@/lib/agent-actions/public/manifest";
import {
  PUBLIC_TOOL_MANIFEST,
  getPublicToolManifestEntry,
} from "@/lib/agent-actions/public/manifest";

/**
 * AgentRun.source value produced by the OpenAI-compatible facade. It is a plain
 * string (AgentRun.source is `String @default("CHAT")`); we keep the literal
 * here as the single source of truth for the gate comparisons.
 */
export const OPENAI_COMPAT_RUN_SOURCE = "OPENAI_COMPAT" as const;

/**
 * Trusted tool-injection policies. The runner accepts one of these; CHAT runs
 * keep the default (`native`) which injects the full internal-action tool list
 * exactly as before.
 */
export type AgentToolPolicy = "native" | "openai_read_only";

/** Manifest kinds permitted for a read-only (OPENAI_COMPAT) run. */
export const OPENAI_COMPAT_ALLOWED_KINDS: ReadonlySet<PublicToolKind> = new Set<PublicToolKind>([
  "discovery",
  "context",
]);

/** Manifest kinds explicitly denied for a read-only (OPENAI_COMPAT) run. */
export const OPENAI_COMPAT_DENIED_KINDS: ReadonlySet<PublicToolKind> = new Set<PublicToolKind>([
  "propose",
  "preview",
  "workflow",
  "preview_then_confirm_generate",
]);

/**
 * Layer 1 — does this manifest entry pass the read-only injection filter?
 * Used by the runner when toolPolicy === "openai_read_only".
 */
export function isAllowedForReadOnlyRun(entry: PublicToolManifestEntry): boolean {
  return OPENAI_COMPAT_ALLOWED_KINDS.has(entry.kind);
}

/**
 * Layer 2 (pre-check) — given a trusted AgentRun.source (read from DB) and a
 * model-submitted publicToolKey, decide whether the tool is executable.
 *
 * Returns a denial reason string when the tool must be refused (403), or null
 * when it may proceed to the normal public-executor security gates.
 *
 * NOTE: this reads the source from the caller (the executor resolves it from
 * the DB via getExecutionContextFromAgentRun); it never trusts a request-body
 * `source` field. A CHAT run is never gated here (returns null).
 */
export function checkReadOnlyPolicyForPublicTool(
  trustedSource: string,
  publicToolKey: string,
): { denied: true; reason: string } | { denied: false } {
  if (trustedSource !== OPENAI_COMPAT_RUN_SOURCE) {
    // Native CHAT (or any future non-read-only source) is NOT gated here.
    return { denied: false };
  }
  const entry = getPublicToolManifestEntry(publicToolKey);
  if (!entry) {
    // Unknown key — let the public executor's own UNKNOWN_PUBLIC_TOOL gate handle it.
    return { denied: false };
  }
  if (!isAllowedForReadOnlyRun(entry)) {
    return {
      denied: true,
      reason:
        `OpenAI-compatible runs are read-only: public tool "${publicToolKey}" ` +
        `(kind "${entry.kind}") is not permitted. Only discovery/context tools may execute.`,
    };
  }
  return { denied: false };
}

/**
 * Convenience: enumerate the publicToolKeys that an OPENAI_COMPAT run is
 * allowed to see. The runner uses this to build the read-only tool surface
 * (Layer 1). Pure / deterministic.
 */
export function readOnlyAllowedPublicToolKeys(): string[] {
  return PUBLIC_TOOL_MANIFEST.filter(isAllowedForReadOnlyRun).map((e) => e.publicTool);
}

/**
 * Layer 1 tool specs (name/description/input_schema) for a read-only run.
 * The runner injects exactly these into the model. Pure / deterministic.
 */
export function readOnlyPublicToolSpecs(): Array<{
  name: string;
  description: string;
  input_schema: PublicToolManifestEntry["publicInput"];
}> {
  return PUBLIC_TOOL_MANIFEST.filter(isAllowedForReadOnlyRun).map((entry) => ({
    name: entry.publicTool,
    description: entry.description,
    input_schema: entry.publicInput,
  }));
}
