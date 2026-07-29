/**
 * agent-ui-adapters pinyin/resolve 渲染契约 smoke（review P2#1）。
 *
 * 锁定「UI adapter 以 resolution 为唯一判断依据，不再用 candidates.length/matchType
 * 推断唯一性」。复现 review 指出的真实 UI bug：正确姓名命中会同时输出
 * resolution=UNIQUE + matchType=name-contains，旧实现仍渲染选择卡，导致用户同时看到
 * 「请选择客户」与自动返回的客户名片。
 *
 * 覆盖：
 *  crm.search_customers_by_pinyin:
 *   1. resolution=UNIQUE + matchType=name-contains（正确姓名唯一命中）→ null（等详情名片）。
 *   2. resolution=UNIQUE + matchType=exact-homophone（同音唯一命中）→ null。
 *   3. resolution=AMBIGUOUS（多候选）→ 选择卡 crm.customer-choice。
 *   4. resolution=AMBIGUOUS（单弱候选，如 zsy→张三阳 65 分）→ 选择卡。
 *   5. resolution=NO_MATCH → null。
 *  crm.resolve_customer_name:
 *   6. resolution=AMBIGUOUS → 选择卡（parity，回归保护）。
 *
 * 运行: npx tsx scripts/smoke-test-agent-ui-adapter.ts
 */

import { normalizeAgentUi } from "@/components/agent/agent-ui-adapters";
import type { AgentUiSource } from "@/components/agent/agent-ui-types";

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

function makeSource(
  actionKey: string,
  output: Record<string, unknown>,
  status: AgentUiSource["status"] = "success",
): AgentUiSource {
  return { actionKey, input: {}, output, status };
}

console.log("=== agent-ui-adapters pinyin/resolve 渲染契约 ===\n");

// ── crm.search_customers_by_pinyin ────────────────────────────────────────────
console.log("[1] pinyin: UNIQUE + name-contains（正确姓名唯一命中）→ null（review P2#1 复现）");
{
  const out = normalizeAgentUi(
    makeSource("crm.search_customers_by_pinyin", {
      query: "周舟",
      queryPinyin: "zhouzhou",
      resolution: "UNIQUE",
      candidates: [
        { profileId: "p1", name: "周舟", matchType: "name-contains", score: 100, signals: ["姓名完全匹配"] },
      ],
      total: 1,
    }),
  );
  console.log("    descriptor:", out?.type ?? "null");
  assert(out === null, "UNIQUE（含 name-contains）→ null，不渲染选择卡，等详情名片");
}

console.log("\n[2] pinyin: UNIQUE + exact-homophone（同音唯一命中）→ null");
{
  const out = normalizeAgentUi(
    makeSource("crm.search_customers_by_pinyin", {
      query: "王小明",
      queryPinyin: "wangxiaoming",
      resolution: "UNIQUE",
      candidates: [
        { profileId: "p-wxm", name: "王晓明", matchType: "exact-homophone", score: 88, signals: ["发音相同（同音错字）"] },
      ],
      total: 1,
    }),
  );
  assert(out === null, "UNIQUE + exact-homophone → null");
}

console.log("\n[3] pinyin: AMBIGUOUS（多候选）→ 选择卡");
{
  const out = normalizeAgentUi(
    makeSource("crm.search_customers_by_pinyin", {
      query: "周舟",
      queryPinyin: "zhouzhou",
      resolution: "AMBIGUOUS",
      candidates: [
        { profileId: "p1", name: "周舟", matchType: "name-contains", score: 100, signals: ["姓名完全匹配"] },
        { profileId: "p2", name: "周州", matchType: "exact-homophone", score: 88, signals: ["发音相同（同音错字）"] },
      ],
      total: 2,
    }),
  );
  console.log("    descriptor:", out?.type, "items:", out?.props && Array.isArray((out.props as Record<string, unknown>).items) ? (out.props as { items: unknown[] }).items.length : "?");
  assert(out?.type === "crm.customer-choice", "AMBIGUOUS（多候选）→ crm.customer-choice");
}

console.log("\n[4] pinyin: AMBIGUOUS（单弱候选 zsy→张三阳 65 分）→ 选择卡");
{
  const out = normalizeAgentUi(
    makeSource("crm.search_customers_by_pinyin", {
      query: "zsy",
      queryPinyin: "zsy",
      resolution: "AMBIGUOUS",
      candidates: [
        { profileId: "p-zsy", name: "张三阳", matchType: "pinyin-initial", score: 65, signals: ["拼音/首字母命中"] },
      ],
      total: 1,
    }),
  );
  assert(out?.type === "crm.customer-choice", "AMBIGUOUS（单弱候选）→ crm.customer-choice（需用户确认）");
}

console.log("\n[5] pinyin: NO_MATCH → null");
{
  const out = normalizeAgentUi(
    makeSource("crm.search_customers_by_pinyin", {
      query: "不存在",
      queryPinyin: "bucunzai",
      resolution: "NO_MATCH",
      candidates: [],
      total: 0,
    }),
  );
  assert(out === null, "NO_MATCH → null");
}

// ── crm.resolve_customer_name（parity 回归保护）──────────────────────────────
console.log("\n[6] resolve_customer_name: AMBIGUOUS → 选择卡");
{
  const out = normalizeAgentUi(
    makeSource("crm.resolve_customer_name", {
      normalizedSpokenName: "张三",
      resolution: "AMBIGUOUS",
      candidates: [
        { profileId: "p1", name: "张三", organization: "A所", ownerName: "rep", score: 100, reasons: ["姓名完全匹配"] },
        { profileId: "p2", name: "张三", organization: "B大学", ownerName: "rep2", score: 100, reasons: ["姓名完全匹配"] },
      ],
    }),
  );
  assert(out?.type === "crm.customer-choice", "resolve AMBIGUOUS → crm.customer-choice");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("❌ agent-ui-adapters 渲染契约回归失败");
  process.exit(1);
}
console.log("✅ agent-ui-adapters 渲染契约回归通过");
