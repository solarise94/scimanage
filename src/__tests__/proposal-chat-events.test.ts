import { describe, expect, it } from "vitest";
import { extractConfirmedProposalFacts } from "@/lib/agent-runtime/proposal-chat-events";

describe("extractConfirmedProposalFacts", () => {
  it("pulls order/project ids from orders.create result and profileId from input", () => {
    const facts = extractConfirmedProposalFacts({
      actionKey: "orders.create",
      input: { profileId: "profile-1", title: "测试订单" },
      result: {
        order: { id: "ord-1", orderNo: "CO-2026-001", title: "测试订单" },
        project: { id: "proj-1", name: "项目 A" },
      },
    });

    expect(facts).toMatchObject({
      actionKey: "orders.create",
      orderId: "ord-1",
      orderNo: "CO-2026-001",
      profileId: "profile-1",
      projectId: "proj-1",
      projectName: "项目 A",
    });
  });

  it("falls back to flat result fields for link_to_project style payloads", () => {
    const facts = extractConfirmedProposalFacts({
      actionKey: "orders.link_to_project",
      input: { orderId: "ord-2", projectId: "proj-2" },
      result: { orderId: "ord-2", projectId: "proj-2", orderNo: "CO-9" },
    });

    expect(facts.orderId).toBe("ord-2");
    expect(facts.projectId).toBe("proj-2");
    expect(facts.orderNo).toBe("CO-9");
  });
});
