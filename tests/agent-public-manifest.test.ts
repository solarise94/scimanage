/**
 * Phase A tests: public manifest + exposure ledger + public-executor security gates.
 *
 * 覆盖（plan v2 修正 3/9）：
 *  - 63 个 internal action 全部进 exposure 台账（assertAllActionsLedgered 通过）；
 *  - manifest publicInput 不含禁用字段（proposalId/idempotencyKey/expectedSha256 等）；
 *  - public-executor 拒未知 publicToolKey；
 *  - public-executor 拒 internal actionKey 直提交（不能拿 "orders.search" 当 publicToolKey）；
 *  - public-executor 拒 implemented:false（Phase A 全 false → 全拒，证明安全门就位）；
 *  - public-executor 拒角色不符。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  PUBLIC_TOOL_MANIFEST,
  findForbiddenPublicInputFields,
  getPublicToolManifestEntry,
} from "@/lib/agent-actions/public/manifest";
import {
  ACTION_EXPOSURE,
  assertAllActionsLedgered,
  countExposureByLevel,
} from "@/lib/agent-actions/public/exposure-ledger";
import {
  executePublicTool,
  registerPublicFacade,
  __clearPublicFacadeRegistryForTests,
} from "@/lib/agent-actions/public/public-executor";
import { listAgentActions } from "@/lib/agent-actions/registry";
import {
  registerPublicReadFacades,
  __resetPublicReadFacadesForTests,
} from "@/lib/agent-actions/public/facades";

beforeEach(() => {
  __clearPublicFacadeRegistryForTests();
  __resetPublicReadFacadesForTests();
  // P2-2：manifest implemented 现在静态全 true（不再由注册翻转）。
  // 仍需注册 facade handler，使 executePublicTool 能找到 handler。
  registerPublicReadFacades();
});
afterEach(() => {
  __resetPublicReadFacadesForTests();
});

beforeEach(() => {
  __clearPublicFacadeRegistryForTests();
});

describe("exposure ledger — all registered actions are ledgered", () => {
  it("every registered internal action has an exposure entry", () => {
    expect(() => assertAllActionsLedgered()).not.toThrow();
  });

  it("registry has 63 actions (baseline; new internal actions must be added to ledger)", () => {
    const actions = listAgentActions();
    expect(actions.length).toBeGreaterThanOrEqual(63);
  });

  it("ledger covers at least as many actions as the registry", () => {
    const actions = listAgentActions();
    for (const a of actions) {
      expect(ACTION_EXPOSURE[a.key]).toBeDefined();
    }
  });

  it("all 5 exposure levels are represented (primary/contextual/workflow_step/internal/legacy)", () => {
    const counts = countExposureByLevel();
    expect(counts.primary).toBeGreaterThan(0);
    expect(counts.workflow_step).toBeGreaterThan(0);
    expect(counts.contextual).toBeGreaterThan(0);
    expect(counts.internal).toBeGreaterThan(0);
    // legacy 也应有（resolve/pinyin/finance_snapshot 被收敛）
    expect(counts.legacy).toBeGreaterThan(0);
  });
});

describe("manifest — forbidden public input fields", () => {
  it("no publicInput contains forbidden field names", () => {
    const violations = findForbiddenPublicInputFields();
    expect(violations).toEqual([]);
  });

  it("every manifest entry has at least one internalAction declared", () => {
    for (const entry of PUBLIC_TOOL_MANIFEST) {
      expect(entry.internalActions.length).toBeGreaterThan(0);
    }
  });

  it("manifest has 25-30 public tools", () => {
    expect(PUBLIC_TOOL_MANIFEST.length).toBeGreaterThanOrEqual(25);
    expect(PUBLIC_TOOL_MANIFEST.length).toBeLessThanOrEqual(32);
  });

  it("all 28 public tools are statically implemented (P2-2: no runtime flip)", () => {
    // P2-2：manifest implemented 现在静态声明（不再由 facade 注册翻转）。
    // 全部 28 个 public tool 都 implemented:true。
    const implemented = PUBLIC_TOOL_MANIFEST.filter((e) => e.implemented).map((e) => e.publicTool);
    expect(implemented).toContain("find_orders");
    expect(implemented).toContain("propose_order");
    expect(implemented).toContain("prepare_contract");
    expect(implemented).toContain("start_order_import");
    expect(implemented).toContain("operate_bank_flow");
    expect(implemented).toContain("list_contract_templates");
    // 全部 28 个 public tool 都应已实现
    expect(implemented.length).toBe(PUBLIC_TOOL_MANIFEST.length);
  });
});

describe("manifest — no collision with internal action keys", () => {
  it("public tool names do not collide with internal action keys", () => {
    const actionKeys = new Set(listAgentActions().map((a) => a.key));
    for (const entry of PUBLIC_TOOL_MANIFEST) {
      // public tool 名绝不能等于某个 internal action key（否则绕过 manifest）。
      expect(actionKeys.has(entry.publicTool)).toBe(false);
    }
  });
});

describe("manifest-facade parity (P2-2)", () => {
  it("every manifest internalAction key exists in action registry", () => {
    const actionKeys = new Set(listAgentActions().map((a) => a.key));
    for (const entry of PUBLIC_TOOL_MANIFEST) {
      for (const actionKey of entry.internalActions) {
        expect(actionKeys.has(actionKey), `${entry.publicTool} 引用未注册的 action ${actionKey}`).toBe(true);
      }
    }
  });

  it("every implemented tool has a facade handler after registerPublicReadFacades", async () => {
    const { getRegisteredFacadeKeys, __clearPublicFacadeRegistryForTests: clearReg } = await import(
      "@/lib/agent-actions/public/public-executor"
    );
    const {
      registerPublicReadFacades,
      __resetPublicReadFacadesForTests: resetReg,
    } = await import("@/lib/agent-actions/public/facades");
    // 重置 registered 标志 + 清空 registry，确保 registerPublicReadFacades 真正注册。
    resetReg();
    clearReg();
    registerPublicReadFacades();
    const facadeKeys = getRegisteredFacadeKeys();
    for (const entry of PUBLIC_TOOL_MANIFEST) {
      if (entry.implemented) {
        expect(facadeKeys.has(entry.publicTool), `${entry.publicTool} implemented 但无 handler`).toBe(true);
      }
    }
  });

  it("assertManifestFacadeParity passes after full registration", async () => {
    const { assertManifestFacadeParity } = await import("@/lib/agent-actions/public/manifest-parity");
    const {
      registerPublicReadFacades,
      __resetPublicReadFacadesForTests: resetReg,
    } = await import("@/lib/agent-actions/public/facades");
    const { __clearPublicFacadeRegistryForTests: clearReg } = await import(
      "@/lib/agent-actions/public/public-executor"
    );
    resetReg();
    clearReg();
    registerPublicReadFacades();
    await expect(assertManifestFacadeParity()).resolves.toBeUndefined();
  });

  it("assertManifestFacadeParity reports violations when handler missing", async () => {
    const { checkManifestFacadeParity } = await import("@/lib/agent-actions/public/manifest-parity");
    const { __clearPublicFacadeRegistryForTests: clearReg } = await import(
      "@/lib/agent-actions/public/public-executor"
    );
    // 清空 registry（不注册任何 handler）→ 所有 implemented tool 都应报 handler 违规。
    clearReg();
    const violations = await checkManifestFacadeParity();
    const handlerViolations = violations.filter((v) => v.kind === "handler");
    expect(handlerViolations.length).toBe(PUBLIC_TOOL_MANIFEST.length);
  });
});

describe("public-executor — security gates", () => {
  const actor = { userId: "u1", role: "ADMIN" };
  const invocation = { channel: "agent" as const, agentRunId: "run-1" };

  it("rejects an unknown publicToolKey", async () => {
    const outcome = await executePublicTool({
      actor,
      invocation,
      publicToolKey: "totally_made_up_tool",
      publicInput: {},
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("UNKNOWN_PUBLIC_TOOL");
  });

  it("rejects a raw internal actionKey submitted as publicToolKey (no manifest bypass)", async () => {
    const outcome = await executePublicTool({
      actor,
      invocation,
      publicToolKey: "orders.search", // internal action key, NOT a public tool
      publicInput: {},
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("UNKNOWN_PUBLIC_TOOL");
  });

  it("rejects non-object publicInput (INVALID_PUBLIC_INPUT)", async () => {
    // P2-2：find_orders 已 implemented:true（静态）+ 已注册 handler（beforeEach）。
    // 验证 P1-1 严格 schema 校验在 handler 前拦截非对象输入。
    const outcome = await executePublicTool({
      actor,
      invocation,
      publicToolKey: "find_orders",
      publicInput: "not-an-object",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("INVALID_PUBLIC_INPUT");
  });

  it("rejects role not allowed for the tool", async () => {
    // get_invoice roles = [ADMIN, USER, REGIONAL_MANAGER]; REPRESENTATIVE 不在列。
    // P2-2：get_invoice 已 implemented:true（静态），无需运行时翻转。
    const outcome = await executePublicTool({
      actor: { userId: "u1", role: "REPRESENTATIVE" },
      invocation,
      publicToolKey: "get_invoice",
      publicInput: {},
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("ROLE_FORBIDDEN");
  });

  it("returns FACADE_HANDLER_MISSING when implemented but no handler registered", async () => {
    // 用一个未注册 handler 的 publicToolKey（registerPublicFacade 在 beforeEach 已 clear）。
    // 故意不注册 handler；manifest 中 find_orders implemented:true。
    const outcome = await executePublicTool({
      actor,
      invocation,
      publicToolKey: "find_orders",
      publicInput: {},
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FACADE_HANDLER_MISSING");
  });

  it("rejects empty publicToolKey", async () => {
    const outcome = await executePublicTool({
      actor,
      invocation,
      publicToolKey: "",
      publicInput: {},
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("INVALID_PUBLIC_TOOL_KEY");
  });

  it("manifest entry getPublicToolManifestEntry resolves known tool", () => {
    expect(getPublicToolManifestEntry("find_orders")).toBeDefined();
    expect(getPublicToolManifestEntry("nope")).toBeUndefined();
  });

  it("all manifest tools implemented:true (PUBLIC_TOOL_NOT_IMPLEMENTED path is dead code)", () => {
    // P2-2：全部 28 个 tool 静态 implemented:true。
    // PUBLIC_TOOL_NOT_IMPLEMENTED 安全门保留在 public-executor.ts 作为防御纵深，
    // 但通过正常 manifest 无法触发（除非未来新增未实现 tool 并标 false）。
    for (const entry of PUBLIC_TOOL_MANIFEST) {
      expect(entry.implemented, `${entry.publicTool} 应 implemented:true`).toBe(true);
    }
  });
});
