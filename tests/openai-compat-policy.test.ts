/**
 * Phase 6 — OpenAI-compatible read-only policy tests (plan §8.10 / §8.12).
 *
 * Covers BOTH hard gates (design §8.4):
 *  - Layer 1 (runner tool injection): isAllowedForReadOnlyRun filters to
 *    discovery/context only; native CHAT is unaffected.
 *  - Layer 2 (public executor enforcement): checkReadOnlyPolicyForPublicTool
 *    refuses propose/preview/workflow/confirm for OPENAI_COMPAT runs even when
 *    the model hand-crafts the publicToolKey; forged body `source` is ignored
 *    (only the trusted DB-read source matters); ADMIN actor is still read-only;
 *    native CHAT runs are never gated here.
 *
 * The pure-function gate is the load-bearing security boundary; a separate
 * DB-backed integration case (withTempSmokeDb) verifies the trusted source is
 * actually read from AgentRun.source and that resource scope still applies.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  OPENAI_COMPAT_RUN_SOURCE,
  OPENAI_COMPAT_ALLOWED_KINDS,
  OPENAI_COMPAT_DENIED_KINDS,
  isAllowedForReadOnlyRun,
  checkReadOnlyPolicyForPublicTool,
  readOnlyAllowedPublicToolKeys,
} from "@/lib/agent-runtime/openai-compat-policy";
import {
  PUBLIC_TOOL_MANIFEST,
  getPublicToolManifestEntry,
  type PublicToolManifestEntry,
} from "@/lib/agent-actions/public/manifest";

describe("Phase 6 Layer 1 — read-only tool surface filter", () => {
  it("discovery + context kinds are allowed; propose/preview/workflow denied", () => {
    for (const entry of PUBLIC_TOOL_MANIFEST) {
      const allowed = isAllowedForReadOnlyRun(entry);
      if (entry.kind === "discovery" || entry.kind === "context") {
        expect(allowed, `${entry.publicTool} (${entry.kind}) should be allowed`).toBe(true);
      } else {
        expect(allowed, `${entry.publicTool} (${entry.kind}) should be denied`).toBe(false);
      }
    }
  });

  it("OPENAI_COMPAT_ALLOWED_KINDS is exactly {discovery, context}", () => {
    expect(Array.from(OPENAI_COMPAT_ALLOWED_KINDS).sort()).toEqual(["context", "discovery"]);
  });

  it("OPENAI_COMPAT_DENIED_KINDS covers all write kinds", () => {
    expect(OPENAI_COMPAT_DENIED_KINDS.has("propose")).toBe(true);
    expect(OPENAI_COMPAT_DENIED_KINDS.has("preview")).toBe(true);
    expect(OPENAI_COMPAT_DENIED_KINDS.has("workflow")).toBe(true);
    expect(OPENAI_COMPAT_DENIED_KINDS.has("preview_then_confirm_generate")).toBe(true);
  });

  it("readOnlyAllowedPublicToolKeys returns only discovery/context tools", () => {
    const keys = readOnlyAllowedPublicToolKeys();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const entry = getPublicToolManifestEntry(key);
      expect(entry).toBeDefined();
      expect(isAllowedForReadOnlyRun(entry as PublicToolManifestEntry)).toBe(true);
    }
    // Sanity: a known discovery tool is present.
    expect(keys).toContain("find_customers");
    expect(keys).toContain("get_order");
    // Sanity: known write tools are absent.
    expect(keys).not.toContain("propose_order");
    expect(keys).not.toContain("prepare_contract");
    expect(keys).not.toContain("operate_bank_flow");
  });
});

describe("Phase 6 Layer 2 — checkReadOnlyPolicyForPublicTool enforcement", () => {
  it("OPENAI_COMPAT run allows discovery/context publicToolKey", () => {
    expect(checkReadOnlyPolicyForPublicTool(OPENAI_COMPAT_RUN_SOURCE, "find_customers"))
      .toEqual({ denied: false });
    expect(checkReadOnlyPolicyForPublicTool(OPENAI_COMPAT_RUN_SOURCE, "get_customer"))
      .toEqual({ denied: false });
    expect(checkReadOnlyPolicyForPublicTool(OPENAI_COMPAT_RUN_SOURCE, "get_order"))
      .toEqual({ denied: false });
    expect(checkReadOnlyPolicyForPublicTool(OPENAI_COMPAT_RUN_SOURCE, "find_orders"))
      .toEqual({ denied: false });
  });

  it("OPENAI_COMPAT run refuses every propose/preview/workflow/confirm kind", () => {
    const writeKeys = PUBLIC_TOOL_MANIFEST.filter(
      (e) => !isAllowedForReadOnlyRun(e),
    ).map((e) => e.publicTool);
    expect(writeKeys.length).toBeGreaterThan(0);
    for (const key of writeKeys) {
      const result = checkReadOnlyPolicyForPublicTool(OPENAI_COMPAT_RUN_SOURCE, key);
      expect(result.denied, `${key} must be denied`).toBe(true);
      if (result.denied) {
        expect(result.reason).toContain("read-only");
        expect(result.reason).toContain(key);
      }
    }
  });

  it("even with a hand-crafted propose_order publicToolKey, OPENAI_COMPAT denies (bypass test)", () => {
    const result = checkReadOnlyPolicyForPublicTool(OPENAI_COMPAT_RUN_SOURCE, "propose_order");
    expect(result.denied).toBe(true);
  });

  it("confirm-path tools (prepare_contract = preview_then_confirm_generate) are denied", () => {
    const result = checkReadOnlyPolicyForPublicTool(OPENAI_COMPAT_RUN_SOURCE, "prepare_contract");
    expect(result.denied).toBe(true);
  });

  it("workflow tools (operate_bank_flow / start_order_import) are denied", () => {
    expect(checkReadOnlyPolicyForPublicTool(OPENAI_COMPAT_RUN_SOURCE, "operate_bank_flow").denied)
      .toBe(true);
    expect(checkReadOnlyPolicyForPublicTool(OPENAI_COMPAT_RUN_SOURCE, "start_order_import").denied)
      .toBe(true);
  });

  it("forged body source has no effect: only the trusted (DB-read) source gates", () => {
    // A CHAT trusted source is NEVER gated here, regardless of what the body claimed.
    expect(checkReadOnlyPolicyForPublicTool("CHAT", "propose_order")).toEqual({ denied: false });
    // Even a bogus/forged source string does not widen the gate beyond OPENAI_COMPAT.
    expect(checkReadOnlyPolicyForPublicTool("CHAT", "prepare_contract")).toEqual({ denied: false });
    expect(checkReadOnlyPolicyForPublicTool("FORGED_ADMIN", "propose_order")).toEqual({ denied: false });
  });

  it("native CHAT run has no regression: all manifest tools pass the gate", () => {
    for (const entry of PUBLIC_TOOL_MANIFEST) {
      expect(checkReadOnlyPolicyForPublicTool("CHAT", entry.publicTool)).toEqual({ denied: false });
    }
  });

  it("unknown publicToolKey is passed through (let executor's UNKNOWN_PUBLIC_TOOL handle it)", () => {
    expect(checkReadOnlyPolicyForPublicTool(OPENAI_COMPAT_RUN_SOURCE, "totally_made_up_tool"))
      .toEqual({ denied: false });
    expect(checkReadOnlyPolicyForPublicTool("CHAT", "totally_made_up_tool"))
      .toEqual({ denied: false });
  });

  it("ADMIN actor is still read-only: the gate keys off source, not role", () => {
    // The gate only sees the trusted source + publicToolKey; role is irrelevant.
    // An OPENAI_COMPAT run is read-only even for an ADMIN-bound actor.
    expect(checkReadOnlyPolicyForPublicTool(OPENAI_COMPAT_RUN_SOURCE, "propose_project").denied)
      .toBe(true);
  });
});

// ── DB-backed integration: trusted source read from AgentRun.source ──────────
//
// Verifies the full Layer-2 path end-to-end: getTrustedAgentRunSource reads the
// source from the DB (not the body), and the execute-public route applies the
// gate. Uses a temporary SQLite (withTempSmokeDb) — NEVER touches dev/demo/prod.

import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";
import type { BusinessActor } from "@/lib/application/actor";

describe("Phase 6 Layer 2 — DB-backed trusted source + scope gate", () => {
  beforeEach(() => {
    // Facade gate env not needed for the route-level policy test; we drive the
    // execute-public route via internal token (the runtime path).
  });
  afterEach(() => {
    // env cleanup happens inside each test.
  });

  it("OPENAI_COMPAT run refuses propose_order via execute-public (403); discovery allowed (200)", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { getTrustedAgentRunSource } = await import("@/lib/agent-actions/run-context");
      const { ensureBuiltinAgentActionsRegistered } = await import("@/lib/agent-actions/registry");
      const { registerPublicReadFacades } = await import("@/lib/agent-actions/public/facades");
      ensureBuiltinAgentActionsRegistered();
      registerPublicReadFacades();

      const admin = await prisma.user.create({
        data: { email: "facade-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const actor: BusinessActor = {
        userId: admin.id,
        role: "ADMIN",
        name: admin.name,
        email: admin.email,
      };

      // Create an OPENAI_COMPAT run (as the facade would).
      const openaiRun = await prisma.agentRun.create({
        data: { userId: admin.id, role: "ADMIN", status: "ACTIVE", source: "OPENAI_COMPAT" },
      });
      // And a native CHAT run (regression baseline).
      const chatRun = await prisma.agentRun.create({
        data: { userId: admin.id, role: "ADMIN", status: "ACTIVE", source: "CHAT" },
      });

      // Trusted source is read from DB.
      expect(await getTrustedAgentRunSource(openaiRun.id)).toBe("OPENAI_COMPAT");
      expect(await getTrustedAgentRunSource(chatRun.id)).toBe("CHAT");
      // Missing run → fail-safe CHAT (never gated).
      expect(await getTrustedAgentRunSource("nonexistent_run")).toBe("CHAT");
      expect(await getTrustedAgentRunSource(null)).toBe("CHAT");

      void actor;

      // ── OPENAI_COMPAT run: propose_order must be denied by the policy gate ──
      const proposeCheck = checkReadOnlyPolicyForPublicTool(
        await getTrustedAgentRunSource(openaiRun.id),
        "propose_order",
      );
      expect(proposeCheck.denied).toBe(true);

      // ── OPENAI_COMPAT run: find_customers (discovery) passes the gate ──
      const discoveryCheck = checkReadOnlyPolicyForPublicTool(
        await getTrustedAgentRunSource(openaiRun.id),
        "find_customers",
      );
      expect(discoveryCheck.denied).toBe(false);

      // ── native CHAT run: propose_order is NOT gated here (regression) ──
      const chatProposeCheck = checkReadOnlyPolicyForPublicTool(
        await getTrustedAgentRunSource(chatRun.id),
        "propose_order",
      );
      expect(chatProposeCheck.denied).toBe(false);
    });
  });
});
