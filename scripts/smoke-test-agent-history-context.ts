import assert from "node:assert/strict";
import { appendVerifiedCustomerHistoryContext } from "../src/lib/agent-runtime/history-context";
import type { AgentTimelineItem } from "../src/lib/agent-runtime/types";

const timeline: AgentTimelineItem[] = [{
  id: "search",
  kind: "tool",
  toolName: "crm.search_customers",
  label: "搜索客户",
  status: "done",
  output: {
    content: [],
    details: {
      result: {
        items: [{
          profileId: "profile-real-1",
          customerId: "legacy-customer-id",
          customerName: "周周老师",
          organization: "浙农林 动科院",
        }],
      },
    },
  },
}];

const enriched = appendVerifiedCustomerHistoryContext("找到 1 位客户。", timeline);
assert.match(enriched, /周周老师（浙农林 动科院） \| profileId: profile-real-1/);
assert.doesNotMatch(enriched, /legacy-customer-id/);
assert.match(enriched, /不得生成、猜测或改写 ID/);

const failedTool: AgentTimelineItem = {
  id: "search",
  kind: "tool",
  toolName: "crm.search_customers",
  label: "搜索客户",
  status: "error",
};
const failed = appendVerifiedCustomerHistoryContext("查询失败。", [failedTool]);
assert.equal(failed, "查询失败。");

console.log("agent history context smoke: 4/4 passed");
