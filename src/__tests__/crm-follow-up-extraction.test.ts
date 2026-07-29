/**
 * 契约测试：CRM follow-up profileId 提取逻辑
 * 直接导入生产模块 src/lib/agent-runtime/crm-follow-up.ts
 */
import { describe, it, expect } from "vitest";
import {
  shouldFollowCrmCustomerContext,
  extractCrmFollowUpProfileId,
} from "@/lib/agent-runtime/crm-follow-up";

describe("shouldFollowCrmCustomerContext", () => {
  it("triggers for search_customers", () => {
    expect(shouldFollowCrmCustomerContext("crm.search_customers")).toBe(true);
  });
  it("triggers for resolve_customer_name", () => {
    expect(shouldFollowCrmCustomerContext("crm.resolve_customer_name")).toBe(true);
  });
  it("triggers for search_customers_by_pinyin", () => {
    expect(shouldFollowCrmCustomerContext("crm.search_customers_by_pinyin")).toBe(true);
  });
  it("does not trigger for other actions", () => {
    expect(shouldFollowCrmCustomerContext("crm.get_customer_context")).toBe(false);
    expect(shouldFollowCrmCustomerContext("orders.list")).toBe(false);
  });
});

describe("extractCrmFollowUpProfileId", () => {
  describe("crm.search_customers", () => {
    it("extracts profileId when exactly 1 result", () => {
      const result = { items: [{ profileId: "p-123", name: "张三" }] };
      expect(extractCrmFollowUpProfileId("crm.search_customers", result)).toBe("p-123");
    });

    it("returns null when 0 results", () => {
      expect(extractCrmFollowUpProfileId("crm.search_customers", { items: [] })).toBeNull();
    });

    it("returns null when 2+ results", () => {
      const result = { items: [{ profileId: "p-1" }, { profileId: "p-2" }] };
      expect(extractCrmFollowUpProfileId("crm.search_customers", result)).toBeNull();
    });

    it("returns null when items missing", () => {
      expect(extractCrmFollowUpProfileId("crm.search_customers", {})).toBeNull();
    });

    it("returns null when profileId is empty string", () => {
      const result = { items: [{ profileId: "" }] };
      expect(extractCrmFollowUpProfileId("crm.search_customers", result)).toBeNull();
    });
  });

  describe("crm.resolve_customer_name", () => {
    it("extracts profileId when UNIQUE", () => {
      const result = { resolution: "UNIQUE", candidates: [{ profileId: "p-456" }] };
      expect(extractCrmFollowUpProfileId("crm.resolve_customer_name", result)).toBe("p-456");
    });

    it("returns null when AMBIGUOUS", () => {
      const result = { resolution: "AMBIGUOUS", candidates: [{ profileId: "p-1" }, { profileId: "p-2" }] };
      expect(extractCrmFollowUpProfileId("crm.resolve_customer_name", result)).toBeNull();
    });

    it("returns null when NO_MATCH", () => {
      const result = { resolution: "NO_MATCH", candidates: [] };
      expect(extractCrmFollowUpProfileId("crm.resolve_customer_name", result)).toBeNull();
    });

    it("returns null when candidates empty even if UNIQUE", () => {
      const result = { resolution: "UNIQUE", candidates: [] };
      expect(extractCrmFollowUpProfileId("crm.resolve_customer_name", result)).toBeNull();
    });
  });

  describe("crm.search_customers_by_pinyin", () => {
    it("extracts profileId when UNIQUE (same as resolve_customer_name)", () => {
      const result = { resolution: "UNIQUE", candidates: [{ profileId: "p-789" }] };
      expect(extractCrmFollowUpProfileId("crm.search_customers_by_pinyin", result)).toBe("p-789");
    });

    it("returns null when AMBIGUOUS", () => {
      const result = { resolution: "AMBIGUOUS", candidates: [{ profileId: "p-1" }] };
      expect(extractCrmFollowUpProfileId("crm.search_customers_by_pinyin", result)).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("returns null for null result", () => {
      expect(extractCrmFollowUpProfileId("crm.search_customers", null)).toBeNull();
    });

    it("returns null for non-object result", () => {
      expect(extractCrmFollowUpProfileId("crm.search_customers", "string")).toBeNull();
    });

    it("returns null for unknown actionKey", () => {
      expect(extractCrmFollowUpProfileId("unknown.action", { items: [{ profileId: "p-1" }] })).toBeNull();
    });
  });
});
