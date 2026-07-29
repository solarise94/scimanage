/**
 * 预存款充值记录 commit 逻辑（src/lib/orders/advance-records-commit.ts）
 *
 * 为每条充值记录解析客户（人名优先匹配 buyerName，机构名回退 buyerOrgName），
 * 建 FinanceAdvance(status=HELD)。若有到款金额，同时建 FinanceReceipt(source=ADVANCE_CHARGE)
 * 并将 advance 的 settledByReceiptId 指向它（表示已到款的充值）。
 *
 * 串行（行间 await），SQLite 写锁。
 *
 * 见 docs/history-orders-import-design.md（预存款充值导入扩展）。
 */

import { prisma } from "@/lib/prisma";
import { withRetry } from "@/lib/orders/import-commit";
import {
  resolveOrCreateOrganizationWithSiteForImport,
  resolveOrCreateCustomerForImport,
  type OrganizationMode,
  type CustomerMode,
} from "@/lib/orders/import-masterdata";
import type { AdvanceRecordRow } from "@/lib/orders/advance-records-parser";

export interface AdvanceCommitResult {
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; projectNo?: string; message: string }>;
  warnings: Array<{ row: number; projectNo?: string; message: string }>;
  stats: {
    advancesCreated: number;
    advancesSkipped: number;
    receiptsCreated: number;
    customersCreated: number;
  };
}

// 机构名判断：客户团队列若匹配已知机构关键词，作为机构名处理
// 这些值在「预存款客户项目」sheet 里出现，且是机构而非人名
const ORG_NAME_KEYWORDS = ["大学", "学院", "医院", "研究院", "研究所", "公司", "中心", "实验室"];

function isOrgName(name: string): boolean {
  return ORG_NAME_KEYWORDS.some((kw) => name.includes(kw));
}

export async function commitAdvanceRecords(
  rows: AdvanceRecordRow[],
  userId: string,
  opts: {
    customerMode?: CustomerMode;
    organizationMode?: OrganizationMode;
    sourceRemark?: string;
  } = {},
): Promise<AdvanceCommitResult> {
  const customerMode: CustomerMode = opts.customerMode ?? "CREATE_IF_MISSING";
  const organizationMode: OrganizationMode = opts.organizationMode ?? "CREATE_IF_MISSING";

  const result: AdvanceCommitResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    warnings: [],
    stats: { advancesCreated: 0, advancesSkipped: 0, receiptsCreated: 0, customersCreated: 0 },
  };

  for (const row of rows) {
    try {
      await withRetry(() =>
        prisma.$transaction(
          async (tx) => {
            const teamName = row.customerTeam?.trim() || null;
            if (!teamName) {
              result.warnings.push({
                row: row.rowIndex,
                projectNo: row.projectNo ?? undefined,
                message: "客户团队为空，跳过",
              });
              result.stats.advancesSkipped++;
              return "skipped" as const;
            }

            // 客户匹配：机构名同时作为 buyerOrgName 解析 Organization
            // 人名只作为 buyerName 匹配
            const isOrg = isOrgName(teamName);
            const buyerName = isOrg ? teamName : teamName;
            const buyerOrgName = isOrg ? teamName : null;

            // 解析 Organization（机构名时）
            let organizationId: string | null = null;
            if (buyerOrgName) {
              const orgRes = await resolveOrCreateOrganizationWithSiteForImport(
                buyerOrgName, undefined, undefined, organizationMode, tx,
              );
              organizationId = orgRes.organizationId;
            }

            // 解析/创建 Customer
            const custRes = await resolveOrCreateCustomerForImport(
              { buyerName, buyerOrgName: buyerOrgName ?? undefined },
              customerMode,
              organizationId,
              null,
              tx,
            );
            // Phase D：CREATE_IF_MISSING 新建客户不再产生 Customer 锚点；匹配既有亦只认 profileId。
            const profileId = custRes.profileId;
            if (custRes.created) result.stats.customersCreated++;

            if (!profileId) {
              result.warnings.push({
                row: row.rowIndex,
                projectNo: row.projectNo ?? undefined,
                message: `客户"${teamName}"未匹配且未创建，跳过`,
              });
              result.stats.advancesSkipped++;
              return "skipped" as const;
            }

            // 幂等检查：只按 profileId（Profile-only）。
            const dup = await tx.financeAdvance.findFirst({
              where: {
                profileId,
                amount: row.amountCents,
                advancedAt: row.advancedAt ?? new Date(0),
                remark: { contains: row.projectNo ?? "" },
              },
              select: { id: true },
            });
            if (dup) {
              // 命中既存充值：顺手清旧列（schema 待删列显式 null，runtime 只读 profileId）。
              await tx.financeAdvance.updateMany({
                where: { id: dup.id },
                data: { profileId }
              });
              result.stats.advancesSkipped++;
              return "updated" as const;
            }

            // 建 FinanceAdvance
            const advance = await tx.financeAdvance.create({
              data: {
                profileId,
                amount: row.amountCents,
                status: "HELD",
                advancedAt: row.advancedAt ?? new Date(),
                remark: [
                  opts.sourceRemark ?? "历史预存款充值导入",
                  row.projectNo ? `项目:${row.projectNo}` : null,
                  row.bankSerialNo ? `流水号:${row.bankSerialNo}` : null,
                  row.remark,
                ].filter(Boolean).join(" | "),
                createdById: userId,
              },
              select: { id: true },
            });
            result.stats.advancesCreated++;

            // 若有到款金额，建 FinanceReceipt 并关联到 advance
            if (row.receivedAmountCents != null && row.receivedAmountCents > 0) {
              const receipt = await tx.financeReceipt.create({
                data: {
                    profileId,
                  amount: row.receivedAmountCents,
                  receivedAt: row.receivedAt ?? row.advancedAt ?? new Date(),
                  source: "ADVANCE_CHARGE",
                  remark: [
                    "预存款充值到款",
                    row.projectNo ? `项目:${row.projectNo}` : null,
                    row.bankSerialNo ? `流水号:${row.bankSerialNo}` : null,
                  ].filter(Boolean).join(" | "),
                  createdById: userId,
                },
                select: { id: true },
              });
              // 关联 advance 到 receipt（表示这笔充值已到款）
              await tx.financeAdvance.update({
                where: { id: advance.id },
                data: { settledByReceiptId: receipt.id },
              });
              result.stats.receiptsCreated++;
            }

            return "created" as const;
          },
          { timeout: 30000 },
        ),
      );
      result.created++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "未知错误";
      result.errors.push({ row: row.rowIndex, projectNo: row.projectNo ?? undefined, message: `充值导入失败: ${msg}` });
    }
  }

  // 修正计数：skipped 的不算 created
  result.created = result.stats.advancesCreated;
  result.updated = 0;
  result.skipped = result.stats.advancesSkipped;

  return result;
}
