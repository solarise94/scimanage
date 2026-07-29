/**
 * Agent 金额叙述 / 解析回归。
 *
 * 锁定：
 * - 50660 分 → 模型文本只出现 ¥506.60，绝不出现 ¥50,660 / 裸 50660 作为金额
 * - allocatedAmountYuan=500 → 50000 分
 * - 旧 proposal `{ allocatedAmount: 50000 }`（分）确认后仍为 50000 分（不得 ×100）
 * - 开票规划 requestedTotalAmountYuan/amountYuan=500 → 50000 分
 *
 * 运行: npx tsx scripts/smoke-test-agent-money-narration.ts
 */

import { centsToYuan, yuanToCents } from "@/lib/finance/money";
import { getAgentAction } from "@/lib/agent-actions/registry";
import {
  buildModelFacingToolText,
  formatCentsAsYuanLabel,
  formatToolResultMoneyForModel,
  migrateLinkToProjectProposalInput,
  parseLinkAllocatedAmountToCents,
  parsePlanInvoiceMoneyToCents,
} from "@/lib/agent-actions/format-tool-result-for-model";

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

function assertNoRawCentsLeak(text: string, cents: number, label: string) {
  assert(text.includes(formatCentsAsYuanLabel(cents)), `${label} 含 ${formatCentsAsYuanLabel(cents)}`);
  assert(!text.includes("¥50,660"), `${label} 不含错误的 ¥50,660`);
  assert(!text.includes("¥50660"), `${label} 不含 ¥50660`);
  assert(!text.includes(`: ${cents}`), `${label} 不含裸分值键值 : ${cents}`);
  assert(!text.includes(`: ${cents},`), `${label} 不含裸分值键值 : ${cents},`);
}

console.log("=== Agent 金额叙述回归 ===\n");

console.log("[formatCentsAsYuanLabel]");
assert(formatCentsAsYuanLabel(50660) === "¥506.60", "50660 → ¥506.60");
assert(formatCentsAsYuanLabel(50000) === "¥500.00", "50000 → ¥500.00");

console.log("\n[parseLinkAllocatedAmountToCents]");
assert(parseLinkAllocatedAmountToCents({ allocatedAmountYuan: 500 }, yuanToCents) === 50000, "Yuan 路径：500 元 → 50000 分");
assert(parseLinkAllocatedAmountToCents({ allocatedAmountYuan: 506.6 }, yuanToCents) === 50660, "Yuan 路径：506.6 元 → 50660 分");
assert(
  parseLinkAllocatedAmountToCents({ allocatedAmount: 50000 }, yuanToCents) === 50000,
  "旧 proposal：allocatedAmount=50000（分）确认后仍为 50000 分",
);
assert(
  parseLinkAllocatedAmountToCents({ allocatedAmount: 50000 }, yuanToCents) !== 5_000_000,
  "旧 proposal：绝不把 50000 分再 ×100",
);
assert(
  parseLinkAllocatedAmountToCents({ allocatedAmountCents: 50000 }, yuanToCents) === 50000,
  "显式 allocatedAmountCents 按分",
);
assert(
  parseLinkAllocatedAmountToCents(
    { allocatedAmountYuan: 500, allocatedAmount: 99999 },
    yuanToCents,
  ) === 50000,
  "Yuan 优先于裸 allocatedAmount",
);

console.log("\n[migrateLinkToProjectProposalInput]");
{
  const { migrated, input } = migrateLinkToProjectProposalInput(
    { orderId: "o1", projectId: "p1", allocatedAmount: 50000 },
    centsToYuan,
  );
  assert(migrated, "旧分值 input 标记为需迁移");
  assert(input.allocatedAmountYuan === 500, "迁移后 allocatedAmountYuan=500");
  assert(input.allocatedAmount == null, "迁移后去掉裸 allocatedAmount");
  assert(input.inputVersion === 2, "迁移写入 inputVersion=2");

  const again = migrateLinkToProjectProposalInput(input, centsToYuan);
  assert(!again.migrated, "已迁移 input 幂等");
}

console.log("\n[orders.link_to_project parseInput 真实路径]");
{
  const action = getAgentAction("orders.link_to_project");
  assert(action != null, "action 已注册");
  if (action) {
    const legacy = action.parseInput({
      orderId: "ord_legacy",
      projectId: "proj_legacy",
      allocatedAmount: 50000,
    }) as { allocatedAmount?: number };
    assert(legacy.allocatedAmount === 50000, "parseInput 旧 proposal 50000 分 → 50000 分");

    const modern = action.parseInput({
      orderId: "ord_new",
      projectId: "proj_new",
      allocatedAmountYuan: 500,
    }) as { allocatedAmount?: number };
    assert(modern.allocatedAmount === 50000, "parseInput allocatedAmountYuan=500 → 50000 分");
  }
}

console.log("\n[parsePlanInvoiceMoneyToCents / plan_project_invoice_requests]");
{
  const fromYuan = parsePlanInvoiceMoneyToCents(
    {
      requestedTotalAmountYuan: 500,
      allocations: [{ orderId: "o1", amountYuan: 500 }],
    },
    yuanToCents,
  );
  assert(fromYuan.requestedTotalAmountCents === 50000, "开票总额 500 元 → 50000 分");
  assert(fromYuan.allocations?.[0]?.amountCents === 50000, "allocations 500 元 → 50000 分");

  const fromCents = parsePlanInvoiceMoneyToCents(
    {
      requestedTotalAmountCents: 50000,
      allocations: [{ orderId: "o1", amountCents: 50000 }],
    },
    yuanToCents,
  );
  assert(fromCents.requestedTotalAmountCents === 50000, "内部 Cents 路径保持 50000");
  assert(fromCents.allocations?.[0]?.amountCents === 50000, "内部 allocations Cents 保持 50000");

  const action = getAgentAction("finance.plan_project_invoice_requests");
  if (action) {
    const parsed = action.parseInput({
      projectId: "proj_1",
      requestedTotalAmountYuan: 500,
      allocations: [{ orderId: "ord_1", amountYuan: 300 }],
    }) as {
      requestedTotalAmountCents?: number;
      allocations?: Array<{ amountCents: number }>;
    };
    assert(parsed.requestedTotalAmountCents === 50000, "action parseInput 总额 500 元 → 50000 分");
    assert(parsed.allocations?.[0]?.amountCents === 30000, "action parseInput 分摊 300 元 → 30000 分");
  } else {
    assert(false, "finance.plan_project_invoice_requests 已注册");
  }
}

console.log("\n[orders.list_pending_receipts]");
{
  const raw = {
    items: [
      {
        id: "ord_1",
        orderNo: "CO-1",
        title: "样例",
        financeAmount: 50660,
        receivedAmount: 0,
        outstandingAmount: 50660,
      },
    ],
    scanned: 1,
    truncated: false,
  };
  const formatted = formatToolResultMoneyForModel("orders.list_pending_receipts", raw) as {
    items: Array<Record<string, unknown>>;
  };
  assert(formatted.items[0].outstandingAmount === "¥506.60", "待回款 outstanding → ¥506.60");
  assert(raw.items[0].outstandingAmount === 50660, "原始 result 仍保留分值供 GenUI");

  const modelText = buildModelFacingToolText({
    actionKey: "orders.list_pending_receipts",
    presentation: undefined,
    mode: "result",
    result: raw,
  });
  assertNoRawCentsLeak(modelText, 50660, "无卡片时的 modelText");

  const minimalText = buildModelFacingToolText({
    actionKey: "orders.list_pending_receipts",
    presentation: { type: "card", narration: "minimal" },
    mode: "result",
    result: raw,
  });
  assert(minimalText.includes("待回款列表已展示"), "card/minimal 走待回款固定旁白");
  assert(minimalText.includes("禁止复述"), "card/minimal 旁白禁止复述");
  assert(!minimalText.includes("50660"), "card/minimal 旁白不含分值");
  assert(!minimalText.includes("¥506.60"), "card/minimal 旁白不含金额标签");
}

console.log("\n[orders.get_finance_snapshot]");
{
  const raw = {
    order: { totalAmount: 50660, financeAmount: 50660 },
    finance: {
      financeAmount: 50660,
      invoicedAmount: 50660,
      receiptAmount: 0,
      costAmount: 0,
      outstandingAmount: 50660,
    },
  };
  const modelText = buildModelFacingToolText({
    actionKey: "orders.get_finance_snapshot",
    mode: "result",
    result: raw,
  });
  assertNoRawCentsLeak(modelText, 50660, "财务摘要 modelText");

  const minimalText = buildModelFacingToolText({
    actionKey: "orders.get_finance_snapshot",
    presentation: { type: "card", narration: "minimal" },
    mode: "result",
    result: raw,
  });
  assert(minimalText.includes("未结清"), "财务摘要 minimal 旁白说明未结清口径");
  assert(minimalText.includes("list_pending_receipts"), "财务摘要 minimal 旁白指向待回款工具");
  assert(!minimalText.includes("50660"), "财务摘要 minimal 旁白不含分值");
  assert(!minimalText.includes("¥506.60"), "财务摘要 minimal 旁白不含金额");
}

console.log("\n[orders.search]");
{
  const raw = {
    items: [{ id: "x", orderNo: "CO-2", totalAmount: 50660, financeAmount: 50660 }],
  };
  const modelText = buildModelFacingToolText({
    actionKey: "orders.search",
    mode: "result",
    result: raw,
  });
  assertNoRawCentsLeak(modelText, 50660, "search modelText");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("❌ 金额叙述回归失败");
  process.exit(1);
}
console.log("✅ 金额叙述回归通过");
