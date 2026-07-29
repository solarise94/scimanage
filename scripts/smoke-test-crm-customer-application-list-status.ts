/**
 * 客户申请列表卡状态展示契约（review P2：主管复核不可被 APPROVED 掩盖）。
 *
 * 锁定：status=APPROVED 且 supervisorReviewStatus=PENDING 时，状态行必须同时
 * 保留「已通过」并显示「主管复核：待复核」。
 *
 * 运行: npx tsx scripts/smoke-test-crm-customer-application-list-status.ts
 */

import { formatCustomerApplicationListStatus } from "@/components/agent/cards/crm-customer-application-list-card";

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

console.log("=== 客户申请列表卡状态展示契约 ===\n");

console.log("[1] APPROVED + PENDING → 已通过 · 主管复核：待复核（review P2 复现）");
{
  const line = formatCustomerApplicationListStatus({
    status: "APPROVED",
    supervisorReviewStatus: "PENDING",
  });
  console.log(`    line: ${line}`);
  assert(line.includes("已通过"), "保留主状态「已通过」");
  assert(line.includes("主管复核：待复核"), "显示主管复核待复核，不可只显示已通过");
}

console.log("\n[2] APPROVED + CONFIRMED → 已通过 · 主管复核：已确认");
{
  const line = formatCustomerApplicationListStatus({
    status: "APPROVED",
    supervisorReviewStatus: "CONFIRMED",
  });
  assert(line.includes("已通过") && line.includes("主管复核：已确认"), line);
}

console.log("\n[3] APPROVED + REJECTED → 已通过 · 主管复核：已拒绝");
{
  const line = formatCustomerApplicationListStatus({
    status: "APPROVED",
    supervisorReviewStatus: "REJECTED",
  });
  assert(line.includes("已通过") && line.includes("主管复核：已拒绝"), line);
}

console.log("\n[4] APPROVED + NONE → 仅主状态，不展示主管复核");
{
  const line = formatCustomerApplicationListStatus({
    status: "APPROVED",
    supervisorReviewStatus: "NONE",
  });
  assert(line === "已通过", `NONE 不追加复核行（实际：${line}）`);
}

console.log("\n[5] PENDING 无复核字段 → 待审核");
{
  const line = formatCustomerApplicationListStatus({ status: "PENDING" });
  assert(line === "待审核", line);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("❌ 客户申请列表状态展示契约失败");
  process.exit(1);
}
console.log("✅ 客户申请列表状态展示契约通过");
