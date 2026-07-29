/**
 * 演练清理脚本：清掉所有订单/项目/财务数据，保留账号+CRM+客户+机构。
 *
 * 用途：上线演练。在 demo 库（覆盖了 prod 数据）上跑此脚本，
 * 然后跑 import-history-orders.ts 用历史 Excel 重建财务闭环。
 *
 * 用法：
 *   npx tsx scripts/clean-orders-projects-finance.ts            # dry-run 预览
 *   npx tsx scripts/clean-orders-projects-finance.ts --apply    # 实际删除
 *
 * 清理范围（按依赖逆序）：
 *   财务：FinanceAdvanceRefund/FinanceCommission/FinanceReceiptAllocation/
 *        FinanceReceipt/FinanceAdvance/FinanceCost/ProgressReceivableAdjustment
 *   发票：ExternalOrderInvoiceCoverage/OrderInvoiceCoverage/ExternalOrderInvoiceItem/
 *        InvoiceAdjustment/InvoiceDocument/ExternalOrderInvoiceRequest/
 *        ProjectInvoiceItem/ProjectInvoice
 *   附件：ContractAttachment/Attachment
 *   订单：OrderProjectLink/OrderLine/OrderSourceRecord/OrderStatusHistory/
 *        OrderMerge/OrderRevision/Order/ExternalOrder/
 *        ExternalOrderImportBatch/OrderImportBatch
 *   工单：Comment/TicketReply/Ticket
 *   项目：StatusHistory/ProjectMember/Project
 *
 * 保留：User、Representative、Customer、Organization 系列、CRM 系列
 *      （Profile/Interaction/FollowUpTask/Visit/Region/Application 等）、
 *      BillingProfile、ProcurementChannel、SourceBrand、
 *      RepresentativeCommissionTier、Agent 系列、Notification、ActivityLog
 */
import { prisma } from "../src/lib/prisma";

interface Step {
  name: string;
  count: () => Promise<number>;
  delete: () => Promise<{ count: number }>;
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`[clean] 模式: ${apply ? "APPLY（实际删除）" : "DRY-RUN（预览）"}`);
  console.log(`[clean] 数据库: ${process.env.DATABASE_URL ?? "(默认 .env)"}`);

  // 按依赖逆序定义清理步骤
  const steps: Step[] = [
    // ── 财务 ──
    { name: "FinanceAdvanceRefund", count: () => prisma.financeAdvanceRefund.count(), delete: () => prisma.financeAdvanceRefund.deleteMany() },
    { name: "FinanceCommission", count: () => prisma.financeCommission.count(), delete: () => prisma.financeCommission.deleteMany() },
    { name: "FinanceReceiptAllocation", count: () => prisma.financeReceiptAllocation.count(), delete: () => prisma.financeReceiptAllocation.deleteMany() },
    { name: "FinanceReceiptDeletionLog", count: () => prisma.financeReceiptDeletionLog.count(), delete: () => prisma.financeReceiptDeletionLog.deleteMany() },
    { name: "FinanceReceipt", count: () => prisma.financeReceipt.count(), delete: () => prisma.financeReceipt.deleteMany() },
    { name: "FinanceAdvance", count: () => prisma.financeAdvance.count(), delete: () => prisma.financeAdvance.deleteMany() },
    { name: "FinanceCost", count: () => prisma.financeCost.count(), delete: () => prisma.financeCost.deleteMany() },
    { name: "ProgressReceivableAdjustment", count: () => prisma.progressReceivableAdjustment.count(), delete: () => prisma.progressReceivableAdjustment.deleteMany() },

    // ── 发票 ──
    { name: "ExternalOrderInvoiceCoverage", count: () => prisma.externalOrderInvoiceCoverage.count(), delete: () => prisma.externalOrderInvoiceCoverage.deleteMany() },
    { name: "OrderInvoiceCoverage", count: () => prisma.orderInvoiceCoverage.count(), delete: () => prisma.orderInvoiceCoverage.deleteMany() },
    { name: "ExternalOrderInvoiceItem", count: () => prisma.externalOrderInvoiceItem.count(), delete: () => prisma.externalOrderInvoiceItem.deleteMany() },
    { name: "InvoiceAdjustment", count: () => prisma.invoiceAdjustment.count(), delete: () => prisma.invoiceAdjustment.deleteMany() },
    { name: "InvoiceDocument", count: () => prisma.invoiceDocument.count(), delete: () => prisma.invoiceDocument.deleteMany() },
    { name: "ExternalOrderInvoiceRequest", count: () => prisma.externalOrderInvoiceRequest.count(), delete: () => prisma.externalOrderInvoiceRequest.deleteMany() },
    { name: "ProjectInvoiceItem", count: () => prisma.projectInvoiceItem.count(), delete: () => prisma.projectInvoiceItem.deleteMany() },
    { name: "ProjectInvoice", count: () => prisma.projectInvoice.count(), delete: () => prisma.projectInvoice.deleteMany() },

    // ── 附件 ──
    { name: "ContractAttachment", count: () => prisma.contractAttachment.count(), delete: () => prisma.contractAttachment.deleteMany() },
    { name: "Attachment", count: () => prisma.attachment.count(), delete: () => prisma.attachment.deleteMany() },

    // ── 订单 ──
    { name: "OrderProjectLink", count: () => prisma.orderProjectLink.count(), delete: () => prisma.orderProjectLink.deleteMany() },
    { name: "OrderLine", count: () => prisma.orderLine.count(), delete: () => prisma.orderLine.deleteMany() },
    { name: "OrderSourceRecord", count: () => prisma.orderSourceRecord.count(), delete: () => prisma.orderSourceRecord.deleteMany() },
    { name: "OrderStatusHistory", count: () => prisma.orderStatusHistory.count(), delete: () => prisma.orderStatusHistory.deleteMany() },
    { name: "OrderMerge", count: () => prisma.orderMerge.count(), delete: () => prisma.orderMerge.deleteMany() },
    { name: "OrderRevision", count: () => prisma.orderRevision.count(), delete: () => prisma.orderRevision.deleteMany() },
    { name: "Order", count: () => prisma.order.count(), delete: () => prisma.order.deleteMany() },
    { name: "ExternalOrder", count: () => prisma.externalOrder.count(), delete: () => prisma.externalOrder.deleteMany() },
    { name: "ExternalOrderImportBatch", count: () => prisma.externalOrderImportBatch.count(), delete: () => prisma.externalOrderImportBatch.deleteMany() },
    { name: "OrderImportBatch", count: () => prisma.orderImportBatch.count(), delete: () => prisma.orderImportBatch.deleteMany() },

    // ── 工单 ──
    { name: "Comment", count: () => prisma.comment.count(), delete: () => prisma.comment.deleteMany() },
    { name: "TicketReply", count: () => prisma.ticketReply.count(), delete: () => prisma.ticketReply.deleteMany() },
    { name: "Ticket", count: () => prisma.ticket.count(), delete: () => prisma.ticket.deleteMany() },

    // ── 项目 ──
    { name: "StatusHistory", count: () => prisma.statusHistory.count(), delete: () => prisma.statusHistory.deleteMany() },
    { name: "ProjectMember", count: () => prisma.projectMember.count(), delete: () => prisma.projectMember.deleteMany() },
    { name: "Project", count: () => prisma.project.count(), delete: () => prisma.project.deleteMany() },
  ];

  // 1. 统计
  console.log("\n=== 将清理的表 ===");
  let total = 0;
  const counts: number[] = [];
  for (const s of steps) {
    const c = await s.count();
    counts.push(c);
    total += c;
    console.log(`  ${s.name.padEnd(35)}: ${c}`);
  }
  console.log(`  ${"TOTAL".padEnd(35)}: ${total}`);

  // 2. 保留表概览（用于对照）
  const [users, reps, orgs, sites, profiles, interactions, billings] = await Promise.all([
    prisma.user.count(),
    prisma.representative.count(),
    prisma.organization.count(),
    prisma.organizationSite.count(),
    prisma.crmCustomerProfile.count(),
    prisma.crmInteraction.count(),
    prisma.billingProfile.count(),
  ]);
  console.log("\n=== 保留的表（不删）===");
  console.log(`  User: ${users}, Representative: ${reps}`);
  console.log(`  Organization: ${orgs}, OrganizationSite: ${sites}`);
  console.log(`  CrmCustomerProfile: ${profiles}, CrmInteraction: ${interactions}`);
  console.log(`  BillingProfile: ${billings}`);

  if (!apply) {
    console.log("\n[DRY-RUN] 未实际删除。加 --apply 执行。");
    return;
  }

  // 3. 实际删除
  console.log("\n=== 开始删除 ===");
  for (const s of steps) {
    try {
      const r = await s.delete();
      console.log(`  ${s.name.padEnd(35)}: deleted ${r.count}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ${s.name.padEnd(35)}: FAILED - ${msg}`);
      throw e;
    }
  }
  console.log("\n[完成] 清理结束。账号/CRM/主数据已保留。");
}

main()
  .catch((e) => {
    console.error("[ERROR]", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
