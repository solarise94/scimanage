/**
 * 历史订单导入烟测脚本（一次性，跑完清理）。
 * 验证 2025 parser + 2026 parser（表头匹配改造）+ commit + 跨年父记录 + 负金额 + 幂等。
 *
 * 不导入全量（634+621 行太慢），只取代表性子集验证逻辑正确性。
 * 全量导入的正确性由 demo 重建流程 + 清理脚本 dry-run 保障。
 *
 * 用法：npx tsx scripts/smoke-test-history-import.ts
 */
import { prisma } from "../src/lib/prisma";
import * as fs from "fs";
import * as crypto from "crypto";
import bcrypt from "bcryptjs";
import { parseContractLedger } from "../src/lib/orders/contract-ledger-parser";
import { parseHistory2025 } from "../src/lib/orders/contract-ledger-parser-2025";
import { commitContractLedger } from "../src/lib/orders/contract-ledger-commit";
import type { ContractLedgerRow } from "../src/lib/orders/contract-ledger-parser";

const FILE_2025 = "historyOrder/2025-历史数据.xlsx";
const FILE_2026 = "historyOrder/2026-历史数据.xlsx";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function main() {
  // ── 解析全量（验证 parser 不报错 + 行数）──
  console.log("[parse] 2025...");
  const buf2025 = fs.readFileSync(FILE_2025);
  const p2025 = parseHistory2025(buf2025);
  console.log(`  rows=${p2025.rows.length} errors=${p2025.errors.length} invoices=${p2025.summary.invoiceCount} pureCost=${p2025.summary.pureCostRows}`);
  assert(p2025.rows.length === 634, `2025 行数应为 634，实际 ${p2025.rows.length}`);
  assert(p2025.errors.length === 0, `2025 解析不应有错误，实际 ${p2025.errors.length}`);
  assert(p2025.summary.receiptCount === 0, "2025 不应有到款");

  console.log("[parse] 2026...");
  const buf2026 = fs.readFileSync(FILE_2026);
  // 2026 文件含 8 个 sheet，真实数据在「26年生物收入&成本」(第 7 个)，需显式指定
  const p2026 = parseContractLedger(buf2026, "26年生物收入&成本");
  console.log(`  rows=${p2026.rows.length} errors=${p2026.errors.length} invoices=${p2026.summary.invoiceCount} receipts=${p2026.summary.receiptCount} parentChild=${p2026.summary.parentChildRows}`);
  assert(p2026.rows.length === 621, `2026 行数应为 621，实际 ${p2026.rows.length}`);
  assert(p2026.errors.length === 0, `2026 解析不应有错误，实际 ${p2026.errors.length}`);

  // ── 校验 2025 关键语义 ──
  // 1. 项目类型全 SERVICE
  const nonSvc = p2025.rows.filter((r) => r.projectType !== "SERVICE");
  assert(nonSvc.length === 0, `2025 项目类型应全为 SERVICE，发现 ${nonSvc.length} 个非 SERVICE`);

  // 2. 父记录全空（忽略日期）
  const withParent = p2025.rows.filter((r) => r.parentProjectNo);
  assert(withParent.length === 0, `2025 父记录应全空，发现 ${withParent.length} 个非空`);

  // 3. 负金额行存在且 remark 标注
  const negRows = p2025.rows.filter((r) => r.projectAmountCents != null && r.projectAmountCents < 0);
  console.log(`  [verify] 2025 负金额行: ${negRows.length}`);
  assert(negRows.length > 0, "2025 应有负金额行（冲红/退款）");
  const negMarked = negRows.filter((r) => r.remark?.includes("历史冲红/退款"));
  assert(negMarked.length === negRows.length, "所有负金额行 remark 应标注 [历史冲红/退款]");

  // 4. 提成/季度奖励为 null（文本非金额）
  const withComm = p2025.rows.filter((r) => r.commissionPaidCents != null || r.quarterlyBonusCents != null);
  assert(withComm.length === 0, "2025 提成/季度奖励应全为 null（文本非金额）");

  // ── 校验 2026 父记录指向 2025 ──
  const pn2025 = new Set(p2025.rows.map((r) => r.projectNo));
  const crossYearRefs = p2026.rows.filter((r) => r.parentProjectNo && r.parentProjectNo.startsWith("25"));
  console.log(`  [verify] 2026 跨年父记录引用(25xxxx): ${crossYearRefs.length}`);
  for (const r of crossYearRefs) {
    assert(pn2025.has(r.parentProjectNo!), `2026 父记录 ${r.parentProjectNo} 应在 2025 数据中`);
  }
  console.log(`  [verify] ✓ 所有跨年父记录引用均在 2025 数据中（0 缺失）`);

  // ── 小样本 commit 测试 ──
  // 临时 admin
  const email = `smoke-${crypto.randomBytes(4).toString("hex")}@test.local`;
  const admin = await prisma.user.create({
    data: { email, name: "smoke-history", password: await bcrypt.hash(crypto.randomBytes(16).toString("hex"), 12), role: "ADMIN" },
  });
  console.log("[setup] temp admin:", admin.id);

  // 导入前快照
  const beforeOrderIds = new Set((await prisma.order.findMany({ where: { source: "CONTRACT_LEDGER" }, select: { id: true } })).map((o) => o.id));
  const beforeProjectIds = new Set((await prisma.project.findMany({ select: { id: true } })).map((p) => p.id));

  // 取子集：2025 前 3 行 + 1 个负金额行 + 2026 1 个有跨年父记录的行
  const subset2025: ContractLedgerRow[] = [
    ...p2025.rows.slice(0, 3),
    negRows[0],
  ];
  // 2026 取一个有父记录的行，其父记录可能是 26xxxx（本批次内）或 25xxxx（需先导 2025）
  const parentRow2026 = crossYearRefs[0] ?? p2026.rows.find((r) => r.parentProjectNo)!;
  // 父记录本身也要导入，否则 link 跳过
  const parentProj2026 = p2026.rows.find((r) => r.projectNo === parentRow2026.parentProjectNo);
  const subset2026: ContractLedgerRow[] = [];
  if (parentProj2026 && parentProj2026.projectNo.startsWith("25")) {
    // 父在 2025，先导 2025 子集里补上这个父
    const parentIn2025 = p2025.rows.find((r) => r.projectNo === parentProj2026.projectNo);
    if (parentIn2025) subset2025.push(parentIn2025);
  } else if (parentProj2026) {
    subset2026.push(parentProj2026);
  }
  subset2026.push(parentRow2026);

  let exitCode = 0;
  try {
    // 先导 2025 子集
    console.log(`[commit] 2025 subset ${subset2025.length} rows...`);
    const res1 = await commitContractLedger(subset2025, admin.id, {
      customerMode: "MATCH_ONLY",
      organizationMode: "CREATE_IF_MISSING",
      sourceRemark: "smoke-2025",
    });
    console.log(`  created=${res1.created} updated=${res1.updated} errors=${res1.errors.length}`);
    assert(res1.errors.length === 0, `2025 子集 commit 不应有错误: ${JSON.stringify(res1.errors)}`);

    // 再导 2026 子集
    console.log(`[commit] 2026 subset ${subset2026.length} rows...`);
    const res2 = await commitContractLedger(subset2026, admin.id, {
      customerMode: "MATCH_ONLY",
      organizationMode: "CREATE_IF_MISSING",
      sourceRemark: "smoke-2026",
    });
    console.log(`  created=${res2.created} updated=${res2.updated} errors=${res2.errors.length} parentLinks=${res2.stats.parentLinksCreated}`);
    assert(res2.errors.length === 0, `2026 子集 commit 不应有错误: ${JSON.stringify(res2.errors)}`);

    // 校验：2026 子行的父记录 link 命中
    if (parentRow2026.parentProjectNo) {
      const childOrder = await prisma.order.findFirst({
        where: { externalOrderNo: parentRow2026.projectNo, source: "CONTRACT_LEDGER" },
        select: { id: true },
      });
      assert(childOrder !== null, `2026 子行订单应存在: ${parentRow2026.projectNo}`);
      const links = await prisma.orderProjectLink.findMany({
        where: { orderId: childOrder!.id },
        select: { isPrimary: true, relationType: true },
      });
      console.log(`  [verify] ${parentRow2026.projectNo} links=${links.length}:`, JSON.stringify(links));
      assert(links.length >= 2, `子行应有 ≥2 条 link（primary+secondary），实际 ${links.length}`);
      assert(links.filter((l) => !l.isPrimary).length >= 1, "应有 secondary link 指向父项目");
      console.log("  [verify] ✓ 跨年父记录 link 命中");
    }

    // 校验：负金额行入库
    const negOrder = await prisma.order.findFirst({
      where: { externalOrderNo: negRows[0].projectNo, source: "CONTRACT_LEDGER" },
      select: { totalAmount: true },
    });
    assert(negOrder !== null, `负金额行订单应存在: ${negRows[0].projectNo}`);
    assert(negOrder!.totalAmount < 0, `负金额行 totalAmount 应为负，实际 ${negOrder!.totalAmount}`);
    console.log(`  [verify] ✓ 负金额行入库: ${negRows[0].projectNo} totalAmount=${negOrder!.totalAmount} 分`);

    // 校验：幂等（重导 2025 子集）
    const res3 = await commitContractLedger(subset2025, admin.id, {
      customerMode: "MATCH_ONLY",
      organizationMode: "CREATE_IF_MISSING",
      sourceRemark: "smoke-2025",
    });
    console.log(`  [idempotency] re-import 2025: created=${res3.created} updated=${res3.updated}`);
    assert(res3.created === 0, `幂等：重导 created 应为 0，实际 ${res3.created}`);
    assert(res3.updated === subset2025.length, `幂等：重导 updated 应为 ${subset2025.length}，实际 ${res3.updated}`);
    console.log("  [verify] ✓ 幂等：重导无新增");

    console.log("\n✅ ALL SMOKE CHECKS PASSED");
  } catch (e) {
    exitCode = 1;
    console.error("\n❌ SMOKE FAILED:", e instanceof Error ? e.message : e);
  } finally {
    // 清理：删除本次导入产生的数据
    console.log("\n[cleanup] rolling back...");
    const newOrders = await prisma.order.findMany({
      where: { source: "CONTRACT_LEDGER", id: { notIn: [...beforeOrderIds] } },
      select: { id: true },
    });
    const newOrderIds = newOrders.map((o) => o.id);
    const newProjects = await prisma.project.findMany({ where: { id: { notIn: [...beforeProjectIds] } }, select: { id: true } });
    const newProjectIds = newProjects.map((p) => p.id);

    await prisma.financeAdvanceRefund.deleteMany({ where: { settledByReceipt: { orderId: { in: newOrderIds } } } });
    await prisma.financeCommission.deleteMany({ where: { orderId: { in: newOrderIds } } });
    await prisma.financeReceipt.deleteMany({ where: { orderId: { in: newOrderIds } } });
    await prisma.financeCost.deleteMany({ where: { orderId: { in: newOrderIds } } });
    await prisma.externalOrderInvoiceRequest.deleteMany({ where: { orderId: { in: newOrderIds } } });
    await prisma.contractAttachment.deleteMany({ where: { OR: [{ orderId: { in: newOrderIds } }, { projectId: { in: newProjectIds } }] } });
    await prisma.orderProjectLink.deleteMany({ where: { orderId: { in: newOrderIds } } });
    await prisma.orderSourceRecord.deleteMany({ where: { orderId: { in: newOrderIds } } });
    await prisma.orderLine.deleteMany({ where: { orderId: { in: newOrderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: newOrderIds } } });
    await prisma.project.deleteMany({ where: { id: { in: newProjectIds } } });
    await prisma.user.delete({ where: { id: admin.id } }).catch(() => undefined);
    console.log(`[cleanup] removed ${newOrderIds.length} orders, ${newProjectIds.length} projects`);
    await prisma.$disconnect();
    process.exit(exitCode);
  }
}

main();
