/**
 * 回归测试：前端 GenUI adapter 对 public tool 的 modelFacing 解包 + 映射。
 *
 * 覆盖 2026-07-27 实测 P0 bug：prepare_order 后端成功返回 modelFacing（含
 * orderDraftId/productOptions/patchEndpoint），但前端 unwrapPiToolOutput 不读
 * modelFacing、ACTION_UI_MAP 不注册 prepare_order，导致草稿编辑卡不渲染（灰色
 * 工具调用行），用户后续输入无法关联草稿。
 *
 * 本测试为纯函数单测（无 DB 依赖），聚焦 adapter 层契约：
 *  - unwrapPiToolOutput 对 preview/needs_input/proposal 模式解 modelFacing；
 *  - normalizeAgentUi 对 prepare_order 映射到 orders.draft-edit 且 props 含 orderDraftId；
 *  - ACTION_UI_MAP 注册了 public tool key（prepare_order/propose_order）。
 */
import { describe, it, expect } from "vitest";
import {
  unwrapPiToolOutput,
  normalizeAgentUi,
  getMappedAgentUiType,
} from "@/components/agent/agent-ui-adapters";
import type { AgentUiSource } from "@/components/agent/agent-ui-types";

describe("unwrapPiToolOutput — public tool modelFacing", () => {
  it("preview mode (prepare_order): 返回 modelFacing 作为 output", () => {
    const raw = {
      content: [{ type: "text", text: "已创建订单草稿" }],
      details: {
        ok: true,
        actionKey: "prepare_order",
        mode: "preview",
        modelFacing: {
          orderDraftId: "draft-abc",
          version: 1,
          productOptions: [{ serviceCatalogId: "svc-1", displayName: "单细胞测序" }],
          projectTypeOptions: [{ projectTypeOptionId: "SEQUENCING", displayName: "测序" }],
          needsSelection: true,
          patchEndpoint: "/api/agent/order-drafts/draft-abc",
        },
      },
    };
    const { output, proposal } = unwrapPiToolOutput(raw);
    expect(proposal).toBeUndefined();
    expect(output).toEqual({
      orderDraftId: "draft-abc",
      version: 1,
      productOptions: [{ serviceCatalogId: "svc-1", displayName: "单细胞测序" }],
      projectTypeOptions: [{ projectTypeOptionId: "SEQUENCING", displayName: "测序" }],
      needsSelection: true,
      patchEndpoint: "/api/agent/order-drafts/draft-abc",
    });
  });

  it("needs_input mode (prepare_order needsSelection): 返回 modelFacing 作为 output", () => {
    const raw = {
      content: [],
      details: {
        ok: true,
        actionKey: "prepare_order",
        mode: "needs_input",
        modelFacing: { orderDraftId: "draft-x", needsSelection: true, error: "请补充产品" },
      },
    };
    const { output } = unwrapPiToolOutput(raw);
    expect((output as Record<string, unknown>).orderDraftId).toBe("draft-x");
    expect((output as Record<string, unknown>).error).toBe("请补充产品");
  });

  it("proposal mode (propose_order): 从 modelFacing.proposal 抽出 proposal", () => {
    const fakeProposal = { id: "prop-1", status: "PENDING", actionKey: "orders.create_from_draft" };
    const raw = {
      content: [],
      details: {
        ok: true,
        actionKey: "propose_order",
        mode: "proposal",
        modelFacing: { proposal: fakeProposal, orderDraftId: "draft-y", note: "等待确认" },
      },
    };
    const { output, proposal } = unwrapPiToolOutput(raw);
    expect(proposal).toEqual(fakeProposal);
    // output 仍是 modelFacing（含附加上下文 orderDraftId/note）
    expect((output as Record<string, unknown>).orderDraftId).toBe("draft-y");
  });

  it("proposal mode (legacy internal): 从 details.proposal 抽出（兼容旧路径）", () => {
    const fakeProposal = { id: "prop-2", status: "PENDING" };
    const raw = {
      content: [],
      details: { ok: true, actionKey: "orders.create", mode: "proposal", proposal: fakeProposal },
    };
    const { proposal } = unwrapPiToolOutput(raw);
    expect(proposal).toEqual(fakeProposal);
  });

  it("result mode (legacy safe action): 返回 details.result", () => {
    const raw = {
      content: [],
      details: { ok: true, actionKey: "crm.get_customer_context", mode: "result", result: { name: "张三" } },
    };
    const { output } = unwrapPiToolOutput(raw);
    expect(output).toEqual({ name: "张三" });
  });

  it("非 Pi 包装（legacy unwrapped）: 原样返回", () => {
    const raw = { name: "张三", organization: "某机构" };
    const { output } = unwrapPiToolOutput(raw);
    expect(output).toBe(raw);
  });
});

describe("ACTION_UI_MAP — public tool 注册", () => {
  it("prepare_order 映射到 orders.draft-edit", () => {
    expect(getMappedAgentUiType("prepare_order")).toBe("orders.draft-edit");
  });

  it("propose_order 映射到 orders.create-draft（复用确认卡）", () => {
    expect(getMappedAgentUiType("propose_order")).toBe("orders.create-draft");
  });
});

describe("normalizeAgentUi — prepare_order 草稿编辑卡", () => {
  it("把 modelFacing 字段透传到 props（orderDraftId/productOptions/patchEndpoint）", () => {
    const source: AgentUiSource = {
      actionKey: "prepare_order",
      input: { customerId: "cust-1" },
      output: {
        orderDraftId: "draft-abc",
        version: 1,
        productOptions: [{ serviceCatalogId: "svc-1", displayName: "单细胞测序" }],
        projectTypeOptions: [{ projectTypeOptionId: "SEQUENCING", displayName: "测序" }],
        needsSelection: true,
        patchEndpoint: "/api/agent/order-drafts/draft-abc",
      },
      status: "success",
    };
    const descriptor = normalizeAgentUi(source);
    expect(descriptor).not.toBeNull();
    expect(descriptor!.type).toBe("orders.draft-edit");
    expect(descriptor!.state).toBe("draft"); // EDITABLE_DRAFT_UI_TYPES 含 orders.draft-edit
    expect(descriptor!.props.orderDraftId).toBe("draft-abc");
    expect(descriptor!.props.patchEndpoint).toBe("/api/agent/order-drafts/draft-abc");
    expect(descriptor!.props.version).toBe(1);
    expect(Array.isArray(descriptor!.props.productOptions)).toBe(true);
  });

  it("propose_order（带 proposal）映射到 orders.create-draft", () => {
    const source: AgentUiSource = {
      actionKey: "propose_order",
      input: { orderDraftId: "draft-y" },
      output: { proposal: { id: "p1", status: "PENDING" }, orderDraftId: "draft-y" },
      proposal: { id: "p1", status: "PENDING", actionKey: "orders.create_from_draft" } as never,
      status: "success",
    };
    const descriptor = normalizeAgentUi(source);
    expect(descriptor).not.toBeNull();
    expect(descriptor!.type).toBe("orders.create-draft");
  });
});
