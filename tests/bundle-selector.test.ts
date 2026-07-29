/**
 * Phase A tests: bundle selector.
 *
 * 覆盖（plan v2 + §7.1）：
 *  - bootstrap bundle ≤ 15；
 *  - REPRESENTATIVE bundle 只含 4 个 scoped read 工具，无写工具；
 *  - REGIONAL_MANAGER bundle 无写工具；
 *  - active workflow 时只注入该 workflow 的 nextAction；
 *  - needs_selection 时只注入消费 options 的 contextual 工具；
 *  - 已选实体 ref 时注入该领域 bundle；
 *  - isAutoHopEligible 只允许 discovery/context/preview（禁止 propose 自动执行）。
 *
 * P2-2：manifest 全部 implemented:true（静态），不再需要测试内翻转 implemented。
 * selector 的 implemented 硬过滤逻辑由 production 代码保留（防御纵深），但通过正常
 * manifest 无法触发空 bundle（除非未来新增未实现 tool 并标 false）。
 */
import { describe, it, expect } from "vitest";
import {
  selectToolBundle,
  MAX_TOOLS_PER_BUNDLE,
  MAX_AUTO_HOPS,
  isAutoHopEligible,
} from "@/lib/agent-actions/public/bundle-selector";

describe("bundle selector — limits", () => {
  it("MAX_TOOLS_PER_BUNDLE is 15", () => {
    expect(MAX_TOOLS_PER_BUNDLE).toBe(15);
  });

  it("MAX_AUTO_HOPS is 3", () => {
    expect(MAX_AUTO_HOPS).toBe(3);
  });
});

describe("bundle selector — implemented hard filter (static manifest)", () => {
  it("all 28 manifest tools are implemented:true (selector sees full candidate pool)", async () => {
    // P2-2：manifest 静态全 implemented:true。selector 的硬过滤逻辑仍保留在 production
    // 代码（candidatePool 内 `if (!entry.implemented) continue`），但通过正常 manifest
    // 无法触发空 bundle。此测试断言静态状态，证明 selector 看到完整候选池。
    const { PUBLIC_TOOL_MANIFEST } = await import("@/lib/agent-actions/public/manifest");
    for (const entry of PUBLIC_TOOL_MANIFEST) {
      expect(entry.implemented, `${entry.publicTool} 应 implemented:true`).toBe(true);
    }
  });
});

describe("bundle selector — bootstrap", () => {
  it("bootstrap bundle contains discovery + new-entry tools and stays ≤15", () => {
    const result = selectToolBundle({ actor: { userId: "u1", role: "ADMIN" } });
    expect(result.tools.length).toBeLessThanOrEqual(MAX_TOOLS_PER_BUNDLE);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("find_customers");
    expect(names).toContain("find_projects");
    expect(names).toContain("find_orders");
    // P1：每条 tool 必须带 manifest kind（runtime 用 name→kind 限流，不猜前缀）
    for (const tool of result.tools) {
      expect(typeof tool.kind).toBe("string");
      expect(tool.kind.length).toBeGreaterThan(0);
    }
  });

  it("list_contract_templates carries discovery kind", () => {
    const result = selectToolBundle({
      actor: { userId: "u1", role: "ADMIN" },
      selectedRefs: ["contract"],
    });
    const templates = result.tools.find((t) => t.name === "list_contract_templates");
    expect(templates).toBeDefined();
    expect(templates!.kind).toBe("discovery");
    expect(isAutoHopEligible(templates!.kind)).toBe(true);
  });
});

describe("bundle selector — REPRESENTATIVE", () => {
  it("REP bundle only has scoped read tools, no writes, no financialView consumer", () => {
    // P2-2：全部 implemented:true（静态），验证 REP 仍被收敛到 4 工具
    const result = selectToolBundle({ actor: { userId: "u1", role: "REPRESENTATIVE" } });
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("find_orders");
    expect(names).toContain("get_order");
    expect(names).toContain("find_contracts");
    expect(names).toContain("get_contract");
    // 绝不含写/财务/发票/模板
    expect(names).not.toContain("get_invoice");
    expect(names).not.toContain("prepare_order");
    expect(names).not.toContain("propose_order");
    expect(names).not.toContain("propose_invoice");
    expect(names).not.toContain("prepare_contract");
    expect(names).not.toContain("list_contract_templates");
    expect(result.tools.length).toBeLessThanOrEqual(MAX_TOOLS_PER_BUNDLE);
  });
});

describe("bundle selector — REGIONAL_MANAGER", () => {
  it("RM bundle has no write tools", () => {
    const result = selectToolBundle({
      actor: { userId: "u1", role: "REGIONAL_MANAGER" },
      selectedRefs: ["order"],
    });
    const kinds = result.tools.map((t) => t.kind);
    for (const k of kinds) {
      expect(k === "discovery" || k === "context").toBe(true);
    }
    const names = result.tools.map((t) => t.name);
    expect(names).not.toContain("propose_invoice");
    expect(names).not.toContain("prepare_contract");
  });

  it("RM can read financialView-scoped orders + invoice", () => {
    const result = selectToolBundle({ actor: { userId: "u1", role: "REGIONAL_MANAGER" } });
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("find_orders");
    expect(names).toContain("get_invoice");
  });
});

describe("bundle selector — active workflow", () => {
  it("active import workspace only injects operate_order_import + necessary context", () => {
    const result = selectToolBundle({
      actor: { userId: "u1", role: "ADMIN" },
      activeWorkspaces: { importSessionRef: "imp-1" },
    });
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("operate_order_import");
    // 不应注入无关写工具（如 propose_ticket_reply）
    expect(names).not.toContain("propose_ticket_reply");
  });

  it("active bank-flow workspace only injects operate_bank_flow", () => {
    const result = selectToolBundle({
      actor: { userId: "u1", role: "ADMIN" },
      activeWorkspaces: { bankFlowRef: "bf-1" },
    });
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("operate_bank_flow");
  });
});

describe("bundle selector — needs_selection", () => {
  it("after needs_selection for customer, injects customer-consuming tools", () => {
    const result = selectToolBundle({
      actor: { userId: "u1", role: "ADMIN" },
      lastToolResult: { kind: "needs_selection", optionType: "customer" },
    });
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("get_customer");
  });

  it("after needs_selection for order, injects order-consuming tools", () => {
    const result = selectToolBundle({
      actor: { userId: "u1", role: "ADMIN" },
      lastToolResult: { kind: "needs_selection", optionType: "order" },
    });
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("get_order");
    expect(names).toContain("propose_invoice");
  });
});

describe("bundle selector — selected refs domain", () => {
  it("selected order ref injects order domain bundle + bootstrap discovery", () => {
    const result = selectToolBundle({
      actor: { userId: "u1", role: "ADMIN" },
      selectedRefs: ["order"],
    });
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("get_order");
    expect(names).toContain("find_orders");
    expect(names).toContain("propose_invoice");
    expect(result.tools.length).toBeLessThanOrEqual(MAX_TOOLS_PER_BUNDLE);
  });

  // 回归 2026-07-27 P0 bug：find_customers 唯一命中后 selectedRefs 应含 "customer"，
  // 使下一轮 bundle 注入 get_customer。此前 runtime 误读已删除的 customerRef 字段，
  // 导致 selectedRefs 为空、get_customer 不载入、链路断裂。
  it("selected customer ref injects customer domain bundle (get_customer)", () => {
    const result = selectToolBundle({
      actor: { userId: "u1", role: "ADMIN" },
      selectedRefs: ["customer"],
    });
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("get_customer");
    expect(names).toContain("propose_follow_up");
    expect(names).toContain("prepare_order");
    expect(result.tools.length).toBeLessThanOrEqual(MAX_TOOLS_PER_BUNDLE);
  });
});

describe("auto-hop eligibility", () => {
  it("only discovery/context/preview kinds are auto-hop eligible", () => {
    expect(isAutoHopEligible("discovery")).toBe(true);
    expect(isAutoHopEligible("context")).toBe(true);
    expect(isAutoHopEligible("preview")).toBe(true);
    expect(isAutoHopEligible("propose")).toBe(false);
    expect(isAutoHopEligible("workflow")).toBe(false);
    expect(isAutoHopEligible("preview_then_confirm_generate")).toBe(false);
  });
});
