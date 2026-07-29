/**
 * card/minimal presentation ↔ GenUI 映射契约 smoke。
 *
 * 锁定：每个 `presentation: { type: "card", narration: "minimal" }` 的 action
 * 必须有 UI 映射；若 outputSchema 顶层含 `items` 数组，映射目标必须是列表卡
 * （不能误绑到单条 draft 卡），且 normalize 后 props.items 可被卡片消费。
 *
 * 运行: npx tsx scripts/smoke-test-agent-card-minimal-contract.ts
 */

import {
  DRAFT_UI_TYPES,
  EDITABLE_DRAFT_UI_TYPES,
  LIST_OUTPUT_UI_TYPES,
  getMappedAgentUiType,
  normalizeAgentUi,
} from "@/components/agent/agent-ui-adapters";
import type { AgentUiSource } from "@/components/agent/agent-ui-types";
import { listAgentActions } from "@/lib/agent-actions/registry";
import {
  buildActionSpecificMinimalNarration,
  buildCardToolNarration,
} from "@/lib/agent-actions/tool-adapter";

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    pass++;
  } else {
    console.log(`  ✗ ${msg}`);
    fail++;
  }
}

function outputHasItemsArray(outputSchema: unknown): boolean {
  if (!outputSchema || typeof outputSchema !== "object") return false;
  const props = (outputSchema as { properties?: Record<string, unknown> }).properties;
  if (!props || typeof props !== "object") return false;
  const items = props.items;
  if (!items || typeof items !== "object") return false;
  return (items as { type?: string }).type === "array";
}

function makeSource(actionKey: string, output: Record<string, unknown>): AgentUiSource {
  return { actionKey, input: {}, output, status: "success" };
}

console.log("=== card/minimal ↔ GenUI 输出结构契约 ===\n");

const cardMinimalActions = listAgentActions().filter(
  (action) => action.presentation?.type === "card" && action.presentation.narration === "minimal",
);

assert(cardMinimalActions.length > 0, `发现 ${cardMinimalActions.length} 个 card/minimal action`);

for (const action of cardMinimalActions) {
  console.log(`\n[${action.key}]`);
  const uiType = getMappedAgentUiType(action.key);
  assert(uiType != null, `存在 UI 映射 → ${uiType}`);

  if (!uiType) continue;

  const isListOutput = outputHasItemsArray(action.outputSchema);
  if (isListOutput) {
    assert(
      LIST_OUTPUT_UI_TYPES.has(uiType),
      `items[] 输出映射到列表卡（当前 ${uiType}）`,
    );
    assert(
      !DRAFT_UI_TYPES.has(uiType),
      `items[] 输出不得映射到 draft 卡`,
    );

    const sample = normalizeAgentUi(
      makeSource(action.key, {
        items: [
          {
            id: "sample-1",
            profileId: "p1",
            customerName: "样例客户",
            organizationName: "样例单位",
            name: "样例申请",
            status: "PENDING",
            isPrimary: "false",
            siteName: "",
            supervisorReviewStatus: "PENDING",
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    // search_customers with 1 item intentionally returns null (follow-up path)
    if (action.key === "crm.search_customers") {
      assert(sample === null, "crm.search_customers 单条命中 → null（等详情跟进）");
      const multi = normalizeAgentUi(
        makeSource(action.key, {
          items: [
            { profileId: "p1", customerName: "A" },
            { profileId: "p2", customerName: "B" },
          ],
        }),
      );
      assert(
        multi != null && Array.isArray(multi.props.items) && multi.props.items.length === 2,
        "多条搜索结果保留 props.items",
      );
    } else {
      assert(sample != null, `normalize 产出 descriptor（${sample?.type ?? "null"}）`);
      assert(
        sample != null && Array.isArray(sample.props.items) && sample.props.items.length === 1,
        "列表卡 props.items 可消费",
      );
    }
  } else {
    assert(
      !LIST_OUTPUT_UI_TYPES.has(uiType) || action.key === "crm.search_customers",
      `非 items[] 输出不误绑纯列表卡（当前 ${uiType}）`,
    );
  }
}

console.log("\n=== 只读卡 state=loaded / 可编辑卡 state=draft ===\n");
{
  const finance = normalizeAgentUi(
    makeSource("orders.get_finance_snapshot", {
      order: { id: "o1", orderNo: "CO-1", title: "样例" },
      finance: { financeAmount: 0, invoicedAmount: 0, receiptAmount: 0, costAmount: 0, outstandingAmount: 0 },
    }),
  );
  assert(finance?.state === "loaded", "财务摘要 → loaded（非草稿）");

  const pending = normalizeAgentUi(makeSource("orders.list_pending_receipts", { items: [], scanned: 0, truncated: false }));
  assert(pending?.state === "loaded", "待回款列表 → loaded");

  const invoice = normalizeAgentUi(
    makeSource("finance.get_invoice_detail", {
      invoice: { id: "inv1", buyerOrganizationName: "购方", totalAmount: 0 },
      lineItems: [],
      coveredOrders: [],
      allocatedAmount: 0,
      outstandingAmount: 0,
    }),
  );
  assert(invoice?.state === "loaded", "发票详情 → loaded");

  const detail = normalizeAgentUi(
    makeSource("orders.get_detail", {
      order: { id: "o1", orderNo: "CO-1", title: "样例", status: "CONFIRMED" },
      lines: [],
      projectLinks: [],
    }),
  );
  assert(detail?.state === "loaded", "订单详情 → loaded");

  const checkin = normalizeAgentUi(
    makeSource("crm.prepare_visit_checkin", {
      profileId: "p1",
      customerName: "样例",
    }),
  );
  assert(checkin?.state === "draft", "签到准备 → draft（可编辑）");
  assert(EDITABLE_DRAFT_UI_TYPES.has("crm.checkin-draft"), "checkin-draft 属于可编辑集合");
}

console.log("\n=== 财务 minimal 固定旁白 ===\n");
{
  const snap = buildCardToolNarration(
    { type: "card", narration: "minimal" },
    "result",
    { actionKey: "orders.get_finance_snapshot", result: {} },
  );
  assert(!!snap && snap.includes("list_pending_receipts"), "财务摘要旁白指向 list_pending_receipts");
  assert(!!snap && snap.includes("禁止"), "财务摘要旁白含禁止约束");

  const emptyPending = buildActionSpecificMinimalNarration("orders.list_pending_receipts", {
    items: [],
  });
  assert(!!emptyPending && emptyPending.includes("无待回款"), "空待回款旁白固定说明无欠款");

  const generic = buildCardToolNarration({ type: "card", narration: "minimal" }, "result");
  assert(!!generic && generic.includes("禁止推断"), "通用 minimal 旁白禁止推断");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("❌ card/minimal 契约回归失败");
  process.exit(1);
}
console.log("✅ card/minimal 契约回归通过");
