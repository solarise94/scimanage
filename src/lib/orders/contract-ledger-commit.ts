/**
 * 合同台账导入 commit 逻辑（src/lib/orders/contract-ledger-commit.ts）
 *
 * per-row $transaction：Order + OrderSourceRecord + OrderLine + InvoiceRequest +
 * FinanceReceipt + FinanceCost + OrderProjectLink + ContractAttachment + FinanceCommission(快照)。
 * 见 docs/contract-ledger-import-export-design.md §9.2。
 *
 * 串行（行间 await，不并发）：SQLite 库级写锁，并发多行事务会死锁。
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ORDER_SOURCE, ORDER_NO_PREFIX, ORDER_STATUS, ORDER_CATEGORY, ORDER_FINANCE_TREATMENT } from "@/lib/orders/constants";
import {
  generateImportOrderNo,
  upsertImportSourceRecord,
  withRetry,
} from "@/lib/orders/import-commit";
import {
  resolveOrCreateOrganizationWithSiteForImport,
  resolveOrCreateCustomerForImport,
  type OrganizationMode,
  type CustomerMode,
} from "@/lib/orders/import-masterdata";
import { transitionCrmStage } from "@/lib/crm/lifecycle";
import { isProductProjectType } from "@/lib/project-type";
import { resolveCustomerBusinessContext } from "@/lib/business/customer-context";
import type { ContractLedgerRow } from "@/lib/orders/contract-ledger-parser";

export interface ContractLedgerCommitResult {
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; projectNo?: string; message: string }>;
  warnings: Array<{ row: number; projectNo?: string; message: string }>;
  stats: {
    projectsUpserted: number;
    ordersUpserted: number;
    invoicesCreated: number;
    receiptsCreated: number;
    costsCreated: number;
    parentLinksCreated: number;
    parentLinksSkipped: number;
    advanceSettled: number;
    advanceUnsettled: number;
    attachmentsCreated: number;
    commissionsCreated: number;
  };
}

function ledgerCategory(projectType: string | null): string {
  if (isProductProjectType(projectType)) return ORDER_CATEGORY.PRODUCT;
  if (projectType === "预存款抵扣") return ORDER_CATEGORY.SERVICE;
  return ORDER_CATEGORY.SERVICE;
}

function periodKey(d: Date | null): string {
  const date = d ?? new Date(0);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Upsert Project by projectNo（@unique，天然幂等）。返回 projectId。
 * 已存在则更新业务字段，否则新建。
 */
async function upsertProject(
  tx: Prisma.TransactionClient,
  row: ContractLedgerRow,
  profileId: string | null,
): Promise<{ projectId: string; isNew: boolean }> {
  const existing = await tx.project.findUnique({
    where: { projectNo: row.projectNo },
    select: { id: true },
  });

  const data = {
    name: row.projectContent?.slice(0, 200) || `合同台账项目 ${row.projectNo}`,
    orderNumber: row.orderNumber,
    organization: row.organizationRaw,
    client: row.client,
    representative: row.representative || null,
    profileId,
    projectType: row.projectType,
    projectContent: row.projectContent,
    quantity: row.quantity,
    procurementSource: row.procurementSource,
    brand: row.brand,
    techSupport: row.techSupport,
    budgetAmount: row.projectAmountCents,
    budgetAmountSource: row.projectAmountCents != null ? "MANUAL" : null,
    budgetCost: row.projectCostCents,
    status: row.status,
    progress: row.progress,
    startDate: row.startDate,
    // N 列交付时间落 deliveredAt，**不落 endDate**（§7.5）
    deliveredAt: row.deliveredAt,
    terminatedAt: row.terminatedAt,
  };

  if (existing) {
    await tx.project.update({ where: { id: existing.id }, data });
    return { projectId: existing.id, isNew: false };
  }
  const created = await tx.project.create({
    data: { ...data, projectNo: row.projectNo },
    select: { id: true },
  });
  return { projectId: created.id, isNew: true };
}

export async function commitContractLedger(
  rows: ContractLedgerRow[],
  userId: string,
  opts: {
    customerMode?: CustomerMode;
    organizationMode?: OrganizationMode;
    sourceRemark?: string;
  } = {},
): Promise<ContractLedgerCommitResult> {
  const customerMode: CustomerMode = opts.customerMode ?? "MATCH_ONLY";
  const organizationMode: OrganizationMode = opts.organizationMode ?? "CREATE_IF_MISSING";

  const result: ContractLedgerCommitResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    warnings: [],
    stats: {
      projectsUpserted: 0,
      ordersUpserted: 0,
      invoicesCreated: 0,
      receiptsCreated: 0,
      costsCreated: 0,
      parentLinksCreated: 0,
      parentLinksSkipped: 0,
      advanceSettled: 0,
      advanceUnsettled: 0,
      attachmentsCreated: 0,
      commissionsCreated: 0,
    },
  };

  // projectNo → projectId（本批次内已落库的项目，供父记录关联）
  const projectNoToId = new Map<string, string>();
  const touchedProfileIds = new Set<string>();

  // 父记录先于子记录处理：子行关联父项目需父项目先落库（§3.5）。
  // 稳定排序——把"被本批次其它行作为父记录引用"的行排到前面。
  const parentNos = new Set(rows.map((r) => r.parentProjectNo).filter(Boolean) as string[]);
  const orderedRows = [...rows].sort((a, b) => {
    const aIsParent = parentNos.has(a.projectNo) ? 0 : 1;
    const bIsParent = parentNos.has(b.projectNo) ? 0 : 1;
    if (aIsParent !== bIsParent) return aIsParent - bIsParent;
    return a.rowIndex - b.rowIndex;
  });

  for (const row of orderedRows) {
    try {
      const action = await withRetry(() =>
        prisma.$transaction(
          async (tx) => {
            // 1. 机构 + 校区。当映射后的 canonicalName 与原始单位名不同时，传 rawAlias 补建别名。
            const orgRes = row.orgMapping
              ? await resolveOrCreateOrganizationWithSiteForImport(
                  row.orgMapping.canonicalName,
                  row.orgMapping.siteName,
                  row.orgMapping.siteType,
                  organizationMode,
                  tx,
                  row.organizationRaw,
                )
              : await resolveOrCreateOrganizationWithSiteForImport(
                  row.organizationRaw,
                  undefined,
                  undefined,
                  organizationMode,
                  tx,
                );
            const organizationId = orgRes.organizationId;
            const organizationSiteId = orgRes.organizationSiteId;

            // 1.5 提前计算已存在订单，用于 MATCH_ONLY 失败时保留原 profileId
            const existingSourceRecord = await tx.orderSourceRecord.findUnique({
              where: {
                source_externalOrderNo: {
                  source: ORDER_SOURCE.CONTRACT_LEDGER,
                  externalOrderNo: row.projectNo,
                },
              },
              select: { orderId: true, order: { select: { deleted: true } } },
            });
            const existingOrderId =
              existingSourceRecord?.orderId && existingSourceRecord.order && !existingSourceRecord.order.deleted
                ? existingSourceRecord.orderId
                : null;

            // 2. 客户（MATCH_ONLY）— 只认 profileId
            const custRes = await resolveOrCreateCustomerForImport(
              {
                buyerName: row.client || undefined,
                buyerOrgName: row.organizationRaw || undefined,
              },
              customerMode,
              organizationId,
              null,
              tx,
              organizationSiteId,
            );
            let profileId = custRes.profileId;
            if (profileId == null && existingOrderId) {
              const existingOrder = await tx.order.findUnique({
                where: { id: existingOrderId },
                select: { profileId: true },
              });
              profileId = existingOrder?.profileId ?? null;
            }
            if (profileId) touchedProfileIds.add(profileId);
            // U3：订单必须有客户（Profile-only，只认 profileId）。
            if (!profileId) {
              throw new Error("未匹配到客户，已拒绝导入（请先建档或补全机构后再导入）");
            }
            // 校区写回客户 Profile（F6）：FK + site + canonical 快照一体写入
            if (organizationSiteId) {
              if (!organizationId || !orgRes.canonicalName) {
                throw new Error("校区写回失败：机构未解析到 canonicalName");
              }
              const siteRow = await tx.organizationSite.findUnique({
                where: { id: organizationSiteId },
                select: { organizationId: true, archived: true },
              });
              if (!siteRow || siteRow.archived || siteRow.organizationId !== organizationId) {
                throw new Error("校区写回失败：院区与机构不一致或已归档");
              }
              await tx.crmCustomerProfile.updateMany({
                where: { id: profileId },
                data: {
                  organizationId,
                  organizationSiteId,
                  organization: orgRes.canonicalName,
                },
              });
            }

            const orderTechSupport = row.techSupport?.trim();
            if (!orderTechSupport) {
              throw new Error(`合同台账项目 ${row.projectNo} 缺少技术支持，拒绝创建或更新订单`);
            }

            // 3. Project upsert（projectNo 幂等）
            const { projectId, isNew: projectIsNew } = await upsertProject(
              tx,
              { ...row, techSupport: orderTechSupport },
              profileId,
            );
            projectNoToId.set(row.projectNo, projectId);
            result.stats.projectsUpserted++;
            void projectIsNew;

            // 4. Order：幂等键 (CONTRACT_LEDGER, projectNo)
            //    严格 source-scoped 查询：只命中本来源的 OrderSourceRecord，
            //    不做跨来源 externalOrderNo 匹配（projectNo 与其它来源单号可能巧合相同，§9.2）。
            const refDate = row.startDate ?? row.deliveredAt ?? new Date();

            const category = ledgerCategory(row.projectType);
            const totalAmount = row.projectAmountCents ?? 0;
            // 纯成本行（金额0 成本>0）→ DRAFT，不触发 CRM ORDER_CONFIRMED（§6.5）
            const orderStatus = row.isPureCost ? ORDER_STATUS.DRAFT : ORDER_STATUS.CONFIRMED;
            const financeNote = row.isAdvanceSettlement ? "预存款抵扣" : null;

            let orderId: string;
            let isUpdate = false;

            // profile 主权：投影 buyerOrganizationId（财务分组键）。
            // 名称快照 buyerOrgNameSnapshot 仍取台账抬头 row.organizationRaw（展示用），
            // ID 取 CRM profile（分组键），二者来源不同是有意设计。
            const custCtx = await resolveCustomerBusinessContext(profileId, tx);
            const buyerOrgId = custCtx.organizationId;

            if (existingOrderId) {
              orderId = existingOrderId;
              isUpdate = true;
              await tx.order.update({
                where: { id: orderId },
                data: {
                  title: row.projectContent?.slice(0, 200) || `合同台账 ${row.projectNo}`,
                  category,
                  status: orderStatus,
                  totalAmount,
                  // 已交付项目走 STANDALONE，避免与实际到款重叠虚增应收（§7.5）
                  financeTreatment: ORDER_FINANCE_TREATMENT.STANDALONE,
                  financeNote,
                  techSupport: orderTechSupport,
                  profileId,
                  customerMatchStatus: custRes.matchStatus,
                  customerMatchScore: custRes.matchScore,
                  customerMatchReason: custRes.matchReason,
                  buyerOrgNameSnapshot: row.organizationRaw,
                  buyerOrganizationId: buyerOrgId ?? undefined,
                  buyerNameSnapshot: row.client,
                  commissionPaid: row.commissionPaidCents,
                  quarterlyBonus: row.quarterlyBonusCents,
                  orderedAt: row.startDate,
                  confirmedAt: orderStatus === ORDER_STATUS.CONFIRMED ? row.startDate : null,
                  deliveredAt: row.deliveredAt,
                },
              });
              // 重新导入：清掉本订单的旧子记录后重建，保证幂等不累积。
              // 发票/成本另有应用层去重，但 receipt/commission 无唯一约束，必须先删。
              await tx.orderLine.deleteMany({ where: { orderId } });
              // 先收集将被删 refund 影响的 advance，再删 refund/receipt，最后按实际剩余 refund 还原 advance 状态
              const affectedRefunds = await tx.financeAdvanceRefund.findMany({
                where: { settledByReceipt: { orderId } },
                select: { advanceId: true },
              });
              const affectedAdvanceIds = [...new Set(affectedRefunds.map((r) => r.advanceId))];
              await tx.financeAdvanceRefund.deleteMany({ where: { settledByReceipt: { orderId } } });
              await tx.financeReceipt.deleteMany({ where: { orderId } });
              await tx.financeCommission.deleteMany({ where: { orderId } });
              // 还原受影响 advance 的状态：按删后剩余 refund 重新判定 HELD/PARTIAL_REFUNDED/REFUNDED
              for (const advId of affectedAdvanceIds) {
                const adv = await tx.financeAdvance.findUnique({
                  where: { id: advId },
                  select: { amount: true, refunds: { select: { amount: true } } },
                });
                if (!adv) continue;
                const stillRefunded = adv.refunds.reduce((s, r) => s + r.amount, 0);
                const status = stillRefunded <= 0 ? "HELD" : stillRefunded >= adv.amount ? "REFUNDED" : "PARTIAL_REFUNDED";
                await tx.financeAdvance.update({ where: { id: advId }, data: { status } });
              }
            } else {
              const orderNo = await generateImportOrderNo(tx, refDate, ORDER_NO_PREFIX.CONTRACT_LEDGER);
              const order = await tx.order.create({
                data: {
                  orderNo,
                  source: ORDER_SOURCE.CONTRACT_LEDGER,
                  sourceRemark: opts.sourceRemark,
                  externalOrderNo: row.projectNo,
                  title: row.projectContent?.slice(0, 200) || `合同台账 ${row.projectNo}`,
                  category,
                  status: orderStatus,
                  totalAmount,
                  financeTreatment: ORDER_FINANCE_TREATMENT.STANDALONE,
                  financeNote,
                  techSupport: orderTechSupport,
                  profileId,
                  customerMatchStatus: custRes.matchStatus,
                  customerMatchScore: custRes.matchScore,
                  customerMatchReason: custRes.matchReason,
                  buyerOrgNameSnapshot: row.organizationRaw,
                  buyerOrganizationId: buyerOrgId,
                  buyerNameSnapshot: row.client,
                  commissionPaid: row.commissionPaidCents,
                  quarterlyBonus: row.quarterlyBonusCents,
                  orderedAt: row.startDate,
                  confirmedAt: orderStatus === ORDER_STATUS.CONFIRMED ? row.startDate : null,
                  deliveredAt: row.deliveredAt,
                  createdById: userId,
                  // 历史台账补录，非业务下单；创建时 rep 为 null，但 CRM sync 可事后回填代表
                  // 触发误发。显式 SKIPPED（设计 §5.4）。扫描侧另有 source 兜底（§6.2 第 0b 步）。
                  repNotifyStatus: "SKIPPED",
                },
                select: { id: true },
              });
              orderId = order.id;
            }
            result.stats.ordersUpserted++;

            // 5. OrderSourceRecord
            await upsertImportSourceRecord(tx, {
              orderId,
              source: ORDER_SOURCE.CONTRACT_LEDGER,
              sourceRemark: opts.sourceRemark,
              externalOrderNo: row.projectNo,
              rawJson: JSON.stringify({
                projectNo: row.projectNo,
                organization: row.organizationRaw,
                client: row.client,
                representative: row.representativeRaw,
                progress: row.progressRaw,
                projectAmountCents: row.projectAmountCents,
                projectCostCents: row.projectCostCents,
              }),
            });

            // 6. OrderLine（单行明细）
            await tx.orderLine.create({
              data: {
                orderId,
                itemName: row.projectContent?.slice(0, 200) || row.projectNo,
                quantity: row.quantity ?? undefined,
                amount: totalAmount,
                category,
                sortOrder: 0,
              },
            });

            // 7. OrderProjectLink — 子行挂父项目（§3.5）
            //    先 primary（→自己 project），再 secondary（→父 project）
            await tx.orderProjectLink.upsert({
              where: { orderId_projectId: { orderId, projectId } },
              update: { isPrimary: true, treatment: ORDER_FINANCE_TREATMENT.STANDALONE },
              create: {
                orderId,
                projectId,
                relationType: "GENERATED",
                treatment: ORDER_FINANCE_TREATMENT.STANDALONE,
                isPrimary: true,
                createdById: userId,
              },
            });
            if (row.parentProjectNo) {
              const parentProjectId =
                projectNoToId.get(row.parentProjectNo) ??
                (
                  await tx.project.findUnique({
                    where: { projectNo: row.parentProjectNo },
                    select: { id: true },
                  })
                )?.id ??
                null;
              if (parentProjectId && parentProjectId !== projectId) {
                await tx.orderProjectLink.upsert({
                  where: { orderId_projectId: { orderId, projectId: parentProjectId } },
                  update: { isPrimary: false, relationType: "SUPPLEMENT" },
                  create: {
                    orderId,
                    projectId: parentProjectId,
                    relationType: "SUPPLEMENT",
                    treatment: ORDER_FINANCE_TREATMENT.STANDALONE,
                    isPrimary: false,
                    createdById: userId,
                  },
                });
                result.stats.parentLinksCreated++;
              } else {
                result.stats.parentLinksSkipped++;
                result.warnings.push({
                  row: row.rowIndex,
                  projectNo: row.projectNo,
                  message: `父记录 ${row.parentProjectNo} 未找到，跳过追加关联`,
                });
              }
            }

            // 8. 开票（每行≤2 张）→ ExternalOrderInvoiceRequest
            //    幂等：(orderId, actualInvoiceNo)；发票号空时 (orderId, totalAmount, actualIssuedAt)
            const buyerInvoiceOrgName = row.buyerInvoiceOrgName || row.organizationRaw;
            let buyerInvoiceOrgId: string | null = null;
            if (buyerInvoiceOrgName) {
              const buyerOrg = await resolveOrCreateOrganizationWithSiteForImport(
                buyerInvoiceOrgName,
                undefined,
                undefined,
                organizationMode,
                tx,
              );
              buyerInvoiceOrgId = buyerOrg.organizationId;
            }
            let sellerProfileId: string | null = null;
            if (row.sellerName) {
              const profile = await tx.billingProfile.findFirst({
                where: { name: row.sellerName },
                select: { id: true },
              });
              sellerProfileId = profile?.id ?? (
                await tx.billingProfile.create({
                  data: { name: row.sellerName },
                  select: { id: true },
                })
              ).id;
            }
            for (const inv of row.invoices) {
              // 幂等检查
              const dupWhere: Prisma.ExternalOrderInvoiceRequestWhereInput = inv.invoiceNo
                ? { orderId, actualInvoiceNo: inv.invoiceNo }
                : { orderId, totalAmount: inv.amountCents, actualIssuedAt: inv.issuedAt };
              const dup = await tx.externalOrderInvoiceRequest.findFirst({
                where: dupWhere,
                select: { id: true },
              });
              if (dup) continue;
              await tx.externalOrderInvoiceRequest.create({
                data: {
                  orderId,
                  status: "ISSUED",
                  totalAmount: inv.amountCents,
                  actualInvoiceNo: inv.invoiceNo,
                  actualIssuedAt: inv.issuedAt,
                  buyerOrganizationId: buyerInvoiceOrgId,
                  buyerOrganizationName: buyerInvoiceOrgName || "未知单位",
                  sellerProfileId,
                  sellerName: row.sellerName,
                  contentSummary: row.projectContent,
                  createdById: userId,
                },
              });
              result.stats.invoicesCreated++;
            }

            // 9. 到款（每行≤2 笔）→ FinanceReceipt
            //    预存款抵扣行的 receipt 用 ADVANCE_SETTLEMENT 并做 FIFO 核销（§10.3）
            //    合并到款的子行不重复记到款（仅父行/主行记）
            const recordReceipts = !(row.isMergedReceipt && row.parentProjectNo);
            if (recordReceipts) {
              for (const rec of row.receipts) {
                const receipt = await tx.financeReceipt.create({
                  data: {
                    orderId,
                    projectId,
                      profileId,
                    organizationId,
                    amount: rec.amountCents,
                    receivedAt: rec.receivedAt ?? row.deliveredAt ?? new Date(),
                    source: row.isAdvanceSettlement ? "ADVANCE_SETTLEMENT" : "CONTRACT_IMPORT",
                    remark: [row.receiptRemark, rec.account].filter(Boolean).join(" / ") || null,
                    createdById: userId,
                  },
                  select: { id: true },
                });
                result.stats.receiptsCreated++;

                // 预存款抵扣核销：跨 advance FIFO（设计 §10.3）。
                // 按 advancedAt 升序消费多条有余额的 advance，直到该 receipt 全部核销或余额耗尽。
                if (row.isAdvanceSettlement && profileId) {
                  let toSettle = rec.amountCents;
                  let settledAny = false;
                  // 取该 profile 所有有余额的 advance（Profile-only：只按 profileId）。
                  const candidates = await tx.financeAdvance.findMany({
                    where: {
                      profileId,
                      status: { in: ["HELD", "PARTIAL_REFUNDED"] },
                    },
                    orderBy: { advancedAt: "asc" },
                    select: { id: true, amount: true, refunds: { select: { amount: true } } },
                  });
                  for (const adv of candidates) {
                    if (toSettle <= 0) break;
                    const refunded = adv.refunds.reduce((s, r) => s + r.amount, 0);
                    const remaining = adv.amount - refunded;
                    if (remaining <= 0) continue;
                    const settleAmount = Math.min(remaining, toSettle);
                    await tx.financeAdvanceRefund.create({
                      data: {
                        advanceId: adv.id,
                        settledByReceiptId: receipt.id,
                        amount: settleAmount,
                        refundedAt: rec.receivedAt ?? new Date(),
                        remark: "预存款抵扣（合同台账导入）",
                        createdById: userId,
                      },
                    });
                    await tx.financeAdvance.update({
                      where: { id: adv.id },
                      data: { status: settleAmount >= remaining ? "REFUNDED" : "PARTIAL_REFUNDED" },
                    });
                    toSettle -= settleAmount;
                    settledAny = true;
                  }
                  if (settledAny) {
                    result.stats.advanceSettled++;
                    if (toSettle > 0) {
                      result.warnings.push({
                        row: row.rowIndex,
                        projectNo: row.projectNo,
                        message: `预存款抵扣：余额不足，剩余 ${toSettle} 分未核销，receipt 保留`,
                      });
                    }
                  } else {
                    result.stats.advanceUnsettled++;
                    result.warnings.push({
                      row: row.rowIndex,
                      projectNo: row.projectNo,
                      message: "预存款抵扣：未找到可消费余额，receipt 保留，余额账暂不平",
                    });
                  }
                }
              }
            }

            // 10. 成本（S 列）→ FinanceCost(costType=PROJECT_COST, sourceType=CONTRACT_IMPORT)
            if (row.projectCostCents != null && row.projectCostCents > 0) {
              const costCreated = await tx.financeCost.create({
                data: {
                  orderId,
                  projectId,
                  profileId,
                  amount: row.projectCostCents,
                  costType: "PROJECT_COST",
                  occurredAt: row.deliveredAt ?? row.startDate ?? new Date(),
                  sourceType: "CONTRACT_IMPORT",
                  sourceKey: `CONTRACT_LEDGER:${row.projectNo}:cost`,
                  remark: "合同台账项目成本",
                  createdById: userId,
                },
              }).then(() => true).catch((e: unknown) => {
                // sourceKey @unique：重复导入时已存在，跳过
                if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002") return false;
                throw e;
              });
              if (costCreated) result.stats.costsCreated++;
            }

            // 11. 附件元数据（AQ 列）→ ContractAttachment
            if (row.attachmentFileName) {
              const existsAttach = await tx.contractAttachment.findFirst({
                where: { projectId, fileName: row.attachmentFileName },
                select: { id: true },
              });
              if (!existsAttach) {
                await tx.contractAttachment.create({
                  data: {
                    projectId,
                    orderId,
                    kind: "CONTRACT",
                    fileName: row.attachmentFileName,
                    source: "IMPORT",
                    uploadedById: userId,
                  },
                });
                result.stats.attachmentsCreated++;
              }
            }

            // 12. 提成快照（W/X）→ FinanceCommission(status=PAID)。需先有绑定 representativeId。
            //     台账只存 representative 文本不绑 ID（§6.1），故此处仅当 Project 已手动绑定 representativeId 时落快照。
            const proj = await tx.project.findUnique({
              where: { id: projectId },
              select: { representativeId: true },
            });
            if (proj?.representativeId) {
              if (row.commissionPaidCents != null && row.commissionPaidCents > 0) {
                await tx.financeCommission.create({
                  data: {
                    representativeId: proj.representativeId,
                    orderId,
                    projectId,
                    period: periodKey(row.startDate),
                    basisAmountCents: totalAmount,
                    rateBps: 0,
                    amountCents: row.commissionPaidCents,
                    kind: "ORDER",
                    status: "PAID",
                    paidAt: row.startDate,
                    note: "合同台账历史提成快照",
                    createdById: userId,
                  },
                });
                result.stats.commissionsCreated++;
              }
              if (row.quarterlyBonusCents != null && row.quarterlyBonusCents > 0) {
                await tx.financeCommission.create({
                  data: {
                    representativeId: proj.representativeId,
                    orderId,
                    projectId,
                    period: periodKey(row.startDate),
                    basisAmountCents: totalAmount,
                    rateBps: 0,
                    amountCents: row.quarterlyBonusCents,
                    kind: "QUARTERLY_BONUS",
                    status: "PAID",
                    paidAt: row.startDate,
                    note: "合同台账历史季度奖励快照",
                    createdById: userId,
                  },
                });
                result.stats.commissionsCreated++;
              }
            }

            return isUpdate ? ("updated" as const) : ("created" as const);
          },
          { timeout: 30000 },
        ),
      );

      if (action === "updated") result.updated++;
      else if (action === "created") result.created++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "未知错误";
      result.errors.push({ row: row.rowIndex, projectNo: row.projectNo, message: `导入失败: ${msg}` });
    }
  }

  // CRM 阶段同步：CONFIRMED 订单触发 ORDER_CONFIRMED（纯成本 DRAFT 行不触发）
  for (const profileId of touchedProfileIds) {
    await transitionCrmStage(profileId, { type: "ORDER_CONFIRMED", orderId: "contract-ledger-import" }).catch(
      (err) => {
        console.error(`[CRM][CONTRACT_LEDGER] ORDER_CONFIRMED transition failed for ${profileId}:`, err);
      },
    );
  }

  return result;
}
