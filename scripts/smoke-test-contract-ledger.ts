/**
 * 合同台账导入烟测脚本（临时库，跑完自动销毁）。
 * 自建随机临时 ADMIN 账号，跑 commit，校验落库 + 应收口径不虚增 + 幂等。
 *
 * Usage: npx tsx scripts/smoke-test-contract-ledger.ts
 */
import * as fs from "fs";
import * as crypto from "crypto";
import bcrypt from "bcryptjs";
import { withTempSmokeDb } from "./lib/temp-smoke-db";
import type { LedgerExportRow } from "../src/lib/orders/contract-ledger-export";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const buf = fs.readFileSync("importRef/生物收入-合同情况表_26年生物收入&成本_表格 (1).xlsx");

  let exitCode = 0;
  try {
    await withTempSmokeDb(async () => {
      const { parseContractLedger } = await import("../src/lib/orders/contract-ledger-parser");
      const { commitContractLedger } = await import("../src/lib/orders/contract-ledger-commit");
      const {
        TsvLedgerExporter,
        LEDGER_EXPORT_HEADERS,
        finalReceivableCents,
      } = await import("../src/lib/orders/contract-ledger-export");
      const {
        computeProjectProgressReceivable,
        computeStandaloneOrderReceivable,
      } = await import("../src/lib/finance/progress");
      const { prisma } = await import("../src/lib/prisma");

      function mkExportRow(p: Partial<LedgerExportRow> & { projectNo: string }): LedgerExportRow {
        const amount = p.projectAmountCents ?? null;
        const base: LedgerExportRow = {
          projectNo: p.projectNo, orderNumber: null, organization: null, client: null, representative: null,
          techSupport: null, projectType: null, projectContent: null, quantity: null,
          procurementSource: null, brand: null, status: null, startDate: null, deliveredAt: null, terminatedAt: null,
          projectAmountCents: null, projectCostCents: null,
          commissionPaidCents: null, quarterlyBonusCents: null, remark: null, receiptRemark: null,
          sellerName: null, buyerInvoiceOrgName: null, invoices: [], receipts: [],
          totalReceivableCents: null, finalReceivableCents: null,
          totalPayableCents: null, attachmentFileName: null, parentProjectNo: null,
        };
        return {
          ...base,
          ...p,
          totalReceivableCents: amount,
          finalReceivableCents: finalReceivableCents(amount, p.projectType ?? null),
        };
      }

      const parsed = parseContractLedger(buf);
      console.log("[parse] rows:", parsed.rows.length, "errors:", parsed.errors.length);

      const email = `smoke-${crypto.randomBytes(4).toString("hex")}@test.local`;
      const admin = await prisma.user.create({
        data: { email, name: "smoke-admin", password: await bcrypt.hash(crypto.randomBytes(16).toString("hex"), 12), role: "ADMIN" },
      });
      console.log("[setup] temp admin:", admin.id);

      // ── MATCH_ONLY 首次导入：预置 Profile-only（生产默认模式）──
      const { resolveOrCreateOrganizationWithSiteForImport } = await import("../src/lib/orders/import-masterdata");
      const { createCrmCustomerProfile } = await import("../src/lib/crm/create-profile");
      const { seedContractLedgerMatchProfiles } = await import("./lib/seed-contract-ledger-profiles");

      const seed = await seedContractLedgerMatchProfiles(parsed.rows, admin.id, {
        resolveOrCreateOrganizationWithSiteForImport,
        createCrmCustomerProfile,
        prisma,
      });
      console.log(
        `[seed MATCH_ONLY] profiles=${seed.seeded} skippedNoClient=${seed.skippedNoClient} skippedNoOrg=${seed.skippedNoOrg}`,
      );
      assert(seed.seeded > 0, "应预置至少 1 条 Profile-only fixture");
      assert(seed.skippedNoOrg === 0, `seed 不得跳过无机构行，实际 ${seed.skippedNoOrg}`);
      const profileCountAfterSeed = await prisma.crmCustomerProfile.count();
      assert(profileCountAfterSeed === seed.seeded, `Profile 数应=${seed.seeded}，实际 ${profileCountAfterSeed}`);

      const res1 = await commitContractLedger(parsed.rows, admin.id, {
        customerMode: "MATCH_ONLY",
        organizationMode: "CREATE_IF_MISSING",
        sourceRemark: "合同台账-smoke",
      });
      console.log(`[commit#1 MATCH_ONLY]`, JSON.stringify({ created: res1.created, updated: res1.updated, errors: res1.errors.length, stats: res1.stats }));
      assert(res1.errors.length === 0, `commit#1 MATCH_ONLY 不应有错误，实际 ${res1.errors.length}: ${JSON.stringify(res1.errors.slice(0, 3))}`);

      const orderCount = await prisma.order.count({ where: { source: "CONTRACT_LEDGER" } });
      console.log(`[verify] CONTRACT_LEDGER orders=${orderCount} (expect 322)`);
      assert(orderCount === 322, `订单数应为 322，实际 ${orderCount}`);
      assert(res1.created === 322, `created 应为 322，实际 ${res1.created}`);

      const ordersMissingProfile = await prisma.order.count({
        where: { source: "CONTRACT_LEDGER", profileId: null },
      });
      assert(ordersMissingProfile === 0, `CONTRACT_LEDGER 订单应均有 profileId，异常 ${ordersMissingProfile} 条`);
      assert(
        (await prisma.crmCustomerProfile.count()) === profileCountAfterSeed,
        "MATCH_ONLY 首次导入不得新建 Profile（应全部命中 seed）",
      );
      const draftCount = await prisma.order.count({ where: { source: "CONTRACT_LEDGER", status: "DRAFT" } });
      assert(draftCount === 15, `纯成本 DRAFT 应为 15，实际 ${draftCount}`);

      const advNote = await prisma.order.count({ where: { source: "CONTRACT_LEDGER", financeNote: "预存款抵扣" } });
      assert(advNote === 13, `预存款抵扣订单应为 13，实际 ${advNote}`);

      const invCount = await prisma.externalOrderInvoiceRequest.count({ where: { order: { source: "CONTRACT_LEDGER" } } });
      const recCount = await prisma.financeReceipt.count({ where: { order: { source: "CONTRACT_LEDGER" } } });
      const costCount = await prisma.financeCost.count({ where: { sourceType: "CONTRACT_IMPORT" } });
      assert(invCount === parsed.summary.invoiceCount, `发票数 ${invCount} != 解析 ${parsed.summary.invoiceCount}`);

      const childRow = parsed.rows.find((r) => r.parentProjectNo);
      if (childRow) {
        const childOrder = await prisma.order.findFirst({ where: { externalOrderNo: childRow.projectNo, source: "CONTRACT_LEDGER" }, select: { id: true } });
        const links = await prisma.orderProjectLink.findMany({ where: { orderId: childOrder!.id }, select: { isPrimary: true } });
        assert(links.length === 2, `子行应有 2 条 link，实际 ${links.length}`);
        assert(links.filter((l) => l.isPrimary).length === 1, "应恰有 1 条 primary link");
      }

      const r0 = parsed.rows[0];
      const o0 = await prisma.order.findFirst({ where: { externalOrderNo: r0.projectNo, source: "CONTRACT_LEDGER" }, select: { totalAmount: true } });
      assert(o0!.totalAmount === r0.projectAmountCents, "金额精度不一致");

      const svcProj = await prisma.project.findFirst({
        where: { projectNo: { not: null }, projectType: "服务", status: "COMPLETED", startDate: { not: null } },
        select: { id: true, budgetAmount: true, projectType: true, startDate: true, createdAt: true, endDate: true, status: true },
      });
      if (svcProj) {
        const sh = await prisma.statusHistory.findFirst({ where: { projectId: svcProj.id, newStatus: "COMPLETED" } });
        assert(svcProj.endDate === null, "台账项目 endDate 必须为 null（§7.5）");
        assert(sh === null, "台账项目不应建 StatusHistory(COMPLETED)（§7.5 fallback）");

        const start = new Date(svcProj.startDate!);
        const pStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
        const pEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0, 23, 59, 59));
        const projRecv = computeProjectProgressReceivable(
          { budgetAmount: svcProj.budgetAmount, projectType: svcProj.projectType, startDate: svcProj.startDate, createdAt: svcProj.createdAt, completionDate: null },
          pStart, pEnd,
        );
        const ord = await prisma.order.findFirst({
          where: { externalOrderNo: { not: null }, projectLinks: { some: { projectId: svcProj.id, isPrimary: true } } },
          select: { totalAmount: true, financeAmountOverride: true, category: true, financeTreatment: true, orderedAt: true, confirmedAt: true, createdAt: true },
        });
        const ordRecv = ord ? computeStandaloneOrderReceivable({ ...ord, hasProjectLinks: true }, pStart, pEnd) : 0;
        console.log(`[verify §7.5] period ${pStart.toISOString().slice(0, 7)}: projectRecv.total=${projRecv.total}, orderRecv=${ordRecv}`);
        assert(projRecv.serviceFinal === 0, "completionDate=null 时不应产生 serviceFinal（70%）");
      }

      const recCountBefore = await prisma.financeReceipt.count({ where: { order: { source: "CONTRACT_LEDGER" } } });
      const commCountBefore = await prisma.financeCommission.count({ where: { order: { source: "CONTRACT_LEDGER" } } });
      const linkCountBefore = await prisma.orderProjectLink.count({ where: { order: { source: "CONTRACT_LEDGER" } } });
      const res2 = await commitContractLedger(parsed.rows, admin.id, { customerMode: "MATCH_ONLY", organizationMode: "CREATE_IF_MISSING", sourceRemark: "合同台账-smoke" });
      assert(res2.created === 0 && res2.updated === 322, "幂等：第二次导入");
      assert((await prisma.order.count({ where: { source: "CONTRACT_LEDGER" } })) === 322, "幂等：订单数仍 322");
      assert((await prisma.externalOrderInvoiceRequest.count({ where: { order: { source: "CONTRACT_LEDGER" } } })) === invCount, "幂等：发票数不变");
      assert((await prisma.financeCost.count({ where: { sourceType: "CONTRACT_IMPORT" } })) === costCount, "幂等：成本数不变");
      assert((await prisma.financeReceipt.count({ where: { order: { source: "CONTRACT_LEDGER" } } })) === recCountBefore, "幂等：到款数不变");
      assert((await prisma.financeCommission.count({ where: { order: { source: "CONTRACT_LEDGER" } } })) === commCountBefore, "幂等：提成数不变");
      assert((await prisma.orderProjectLink.count({ where: { order: { source: "CONTRACT_LEDGER" } } })) === linkCountBefore, "幂等：link 数不变");

      const advRow = parsed.rows.find((r) => r.projectNo === "2602129" && r.isAdvanceSettlement);
      if (advRow) {
        const advOrder = await prisma.order.findFirst({
          where: { externalOrderNo: "2602129", source: "CONTRACT_LEDGER" },
          select: { profileId: true },
        });
        assert(!!advOrder?.profileId, "§10.3: 订单 2602129 应有 profileId");
        const advProfileId = advOrder!.profileId!;
        const adv1 = await prisma.financeAdvance.create({
          data: { profileId: advProfileId, amount: 50000, status: "HELD", advancedAt: new Date(Date.UTC(2026, 0, 1)), createdById: admin.id, remark: "smoke 充值1" },
        });
        const adv2 = await prisma.financeAdvance.create({
          data: { profileId: advProfileId, amount: 50000, status: "HELD", advancedAt: new Date(Date.UTC(2026, 0, 2)), createdById: admin.id, remark: "smoke 充值2" },
        });
        const advCommit = await commitContractLedger([advRow], admin.id, { customerMode: "MATCH_ONLY", organizationMode: "CREATE_IF_MISSING", sourceRemark: "合同台账-smoke-adv" });
        const r1 = (await prisma.financeAdvanceRefund.findMany({ where: { advanceId: adv1.id }, select: { amount: true } })).reduce((s, r) => s + r.amount, 0);
        const r2 = (await prisma.financeAdvanceRefund.findMany({ where: { advanceId: adv2.id }, select: { amount: true } })).reduce((s, r) => s + r.amount, 0);
        assert(r1 === 50000 && r2 === 39760, `跨 advance FIFO：adv1=${r1} adv2=${r2}`);
        assert((await prisma.financeAdvance.findUnique({ where: { id: adv1.id }, select: { status: true } }))!.status === "REFUNDED", "adv1 REFUNDED");
        assert((await prisma.financeAdvance.findUnique({ where: { id: adv2.id }, select: { status: true } }))!.status === "PARTIAL_REFUNDED", "adv2 PARTIAL_REFUNDED");

        await commitContractLedger([advRow], admin.id, { customerMode: "MATCH_ONLY", organizationMode: "CREATE_IF_MISSING", sourceRemark: "合同台账-smoke-adv" });
        const r1b = (await prisma.financeAdvanceRefund.findMany({ where: { advanceId: adv1.id }, select: { amount: true } })).reduce((s, r) => s + r.amount, 0);
        const r2b = (await prisma.financeAdvanceRefund.findMany({ where: { advanceId: adv2.id }, select: { amount: true } })).reduce((s, r) => s + r.amount, 0);
        assert(r1b === 50000 && r2b === 39760, `重导入后核销额不应漂移`);
        console.log("[verify §10.3] ✓ 跨 advance FIFO + 重导入无腐化", JSON.stringify({ settled: advCommit.stats.advanceSettled }));
      }

      const exporter = new TsvLedgerExporter();
      const rowsToExport: LedgerExportRow[] = [
        mkExportRow({ projectNo: "T-SVC-5", projectType: "服务", projectAmountCents: 5 }),
        mkExportRow({ projectNo: "T-SVC-45", projectType: "服务", projectAmountCents: 45 }),
        mkExportRow({ projectNo: "T-PRD", projectType: "商品", projectAmountCents: 12345 }),
      ];
      const out = exporter.export(rowsToExport);
      const lines = out.content!.split("\n");
      assert(lines[0].split("\t").length === LEDGER_EXPORT_HEADERS.length, `表头列数应=${LEDGER_EXPORT_HEADERS.length}`);
      for (let li = 1; li < lines.length; li++) {
        const c = lines[li].split("\t");
        assert(c.length === LEDGER_EXPORT_HEADERS.length, `第 ${li} 行列数应=${LEDGER_EXPORT_HEADERS.length}`);
        const amount = parseFloat(c[15]);
        const deposit = parseFloat(c[16]);
        const finalPay = parseFloat(c[17]);
        const ao = parseFloat(c[40]);
        assert(Math.abs(deposit + finalPay - amount) < 0.005, `行${li} 立项+交付 != 金额`);
        assert(Math.abs(finalPay - ao) < 0.005, `行${li} R列 != AO列`);
      }

      console.log("\n✅ ALL SMOKE CHECKS PASSED");
    });
  } catch (e) {
    exitCode = 1;
    console.error("\n❌ SMOKE FAILED:", e instanceof Error ? e.message : e);
  }
  process.exit(exitCode);
}

main();
