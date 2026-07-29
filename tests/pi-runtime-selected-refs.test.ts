/**
 * 回归测试：pi-runtime extractSelectedRefsFromModelFacing 读真实 id 字段。
 *
 * 覆盖 2026-07-27 P0 bug：find_customers facade 发 customerId（非已删除的 customerRef），
 * 但 runtime 的 extractSelectedRefsFromModelFacing 仍读 customerRef，导致唯一客户命中后
 * selectedRefs 为空、bundle-selector 不载入 get_customer、链路断裂。
 *
 * 动态 import agent-runtime 源码（pi-runtime 依赖 Pi core 全链路，无既有单测基建；
 * 本测试通过相对路径加载编译产物，聚焦纯函数契约）。
 */
import { describe, it, expect } from "vitest";

// agent-runtime 是独立包，vitest 未配 alias；用相对路径动态 import 其 dist 产物。
// dist 由 `cd agent-runtime && npm run build` 生成（开发流程标准步骤）。
async function loadFn() {
  const mod = await import("../agent-runtime/dist/pi-runtime.js");
  return mod.extractSelectedRefsFromModelFacing as (
    modelFacing: Record<string, unknown>,
    optionType: string | undefined,
    kind: string,
  ) => string[] | undefined;
}

describe("extractSelectedRefsFromModelFacing — public tool 真实 id 字段", () => {
  it("find_customers UNIQUE 命中（items[0].customerId）→ ['customer']", async () => {
    const fn = await loadFn();
    const modelFacing = {
      resolution: "UNIQUE",
      items: [{ customerId: "cust-1", name: "张三", organization: "某机构" }],
    };
    expect(fn(modelFacing, undefined, "result")).toEqual(["customer"]);
  });

  it("旧 customerRef 字段仍兼容（legacy internal action 直出）", async () => {
    const fn = await loadFn();
    const modelFacing = {
      items: [{ customerRef: "cust-legacy" }],
    };
    expect(fn(modelFacing, undefined, "result")).toEqual(["customer"]);
  });

  it("prepare_order 产出 orderDraftId → ['customer']（保持 customer 域 propose_order 可用）", async () => {
    const fn = await loadFn();
    const modelFacing = {
      orderDraftId: "draft-1",
      productOptions: [],
      patchEndpoint: "/api/agent/order-drafts/draft-1",
    };
    expect(fn(modelFacing, undefined, "result")).toEqual(["customer"]);
  });

  it("get_customer 产出 modelFacing.customer → ['customer']", async () => {
    const fn = await loadFn();
    const modelFacing = { customer: { id: "cust-1", name: "张三" } };
    expect(fn(modelFacing, undefined, "result")).toEqual(["customer"]);
  });

  it("find_orders UNIQUE（items[0].orderId）→ ['order']", async () => {
    const fn = await loadFn();
    const modelFacing = { items: [{ orderId: "ord-1" }] };
    expect(fn(modelFacing, undefined, "result")).toEqual(["order"]);
  });

  it("needs_selection / needs_user_input kind → undefined（走 optionType 分支）", async () => {
    const fn = await loadFn();
    const modelFacing = { items: [{ customerId: "cust-1" }] };
    expect(fn(modelFacing, "customer", "needs_selection")).toBeUndefined();
    expect(fn(modelFacing, undefined, "needs_user_input")).toBeUndefined();
  });

  it("零命中（items=[]）→ undefined", async () => {
    const fn = await loadFn();
    expect(fn({ items: [] }, undefined, "result")).toBeUndefined();
  });
});
