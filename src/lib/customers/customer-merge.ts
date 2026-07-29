/**
 * Customer merge executor — performs the actual merge within a transaction.
 * Used by the review console's merge action and the legacy manual merge endpoint.
 *
 * SINGLE merge implementation — all callers go through this function.
 *
 * Phase E contract 边界：
 *  - 运行时 Profile-only：Customer 锚点模型与全部旧 `*CustomerId*` 列已物理删除，
 *    执行/撤销写路径只迁/写 `profileId` 系列列。代表同步统一
 *    `syncProfileRepresentativeLinksFromOwner` + tag helper。
 *  - 合并主键只认 profileId；Profile lifecycle 检查为唯一主权。
 *  - 旧 mergeLog JSON 快照里可能残留旧锚点键（历史数据），解析时忽略，不做还原。
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { syncProfileRepresentativeLinksFromOwner } from "@/lib/crm/customer-representative-sync";
import { syncManagingTagForProfileOwner } from "@/lib/crm/customer-rep-tag-helpers";
import { toPinyinToneless } from "@/lib/crm/pinyin";
import { CRM_PROFILE_BUSINESS_FIELDS, type CrmProfileBusinessField } from "@/lib/customers/customer-business-fields";
import {
  NAME_ALIAS_TYPE,
  NAME_ALIAS_SOURCE,
  normalizeCustomerNameAlias,
  dedupeAliasCandidates,
  type AliasCandidate,
  type NameAliasType,
} from "@/lib/customers/customer-name-alias";

export type ProfileResolution = "KEEP_TARGET" | "KEEP_SOURCE" | "ARCHIVED";
export type OrgResolution = "KEEP_TARGET_ORG" | "KEEP_SOURCE_ORG";

/**
 * migratedIds 的版本化容器。历史上声明为 `Record<string, string[]>`，但实际已有四种非
 * `string[]` 对象结构（orderMatchSnapshots / customerRelations / customerRepTags /
 * 新增 customerNameAliases）。容器改为 `Record<string, unknown>`，读取点用显式 type guard 收窄。
 * 解析 helper 见本文件 `migratedIds` 段。
 */
type MigratedIds = Record<string, unknown>;

type ProfileResourceDelegate = {
  findMany(args: { where: { profileId: string }; select: { id: true } }): Promise<Array<{ id: string }>>;
  updateMany(args: { where: { id: { in: string[] } }; data: { profileId: string } }): Promise<unknown>;
};

export interface MergeResult {
  mergeLogId: string;
  migratedCounts: Record<string, number>;
  migratedIds: MigratedIds;
}

// ── migratedIds 安全解析 helper（docs §6.3 / §6.4）──
// 旧 JSON 缺键或形状不完整时安全跳过，不抛错。

interface OrderMatchSnapshot {
  id: string;
  status: string;
  score: number | null;
  reason: string | null;
  representativeId: string | null;
}

// 旧日志的删除关系快照可能还带旧锚点端点键（历史数据），解析时忽略；
// 新快照只记录 Profile 端点。
interface CustomerRelationSnapshot {
  id: string;
  fromProfileId: string;
  toProfileId: string;
  type: string;
  strength: string | null;
  notes: string | null;
  introducedAt: Date | null;
  createdByUserId: string;
}

interface CustomerRelationsMigration {
  from?: string[];
  to?: string[];
  deleted?: CustomerRelationSnapshot[];
}

interface CustomerOrgTextDriftTasksMigration {
  migrated?: string[];
  ignored?: Array<{
    id: string;
    status: string;
    resolutionNote: string | null;
  }>;
}

interface CustomerRepTagsMigration {
  migrated?: string[];
  deactivated?: string[];
}

interface CustomerNameAliasesMigration {
  created?: string[];
  reused?: string[];
  /** 本次合并从 inactive 恢复为 active 的 alias 记录，含恢复前状态。撤销时恢复 inactive。 */
  reactivated?: Array<{ id: string; alias: string; active: boolean }>;
}

function parseOrderMatchSnapshots(v: unknown): OrderMatchSnapshot[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x): x is OrderMatchSnapshot =>
      x != null && typeof x === "object" && typeof (x as OrderMatchSnapshot).id === "string",
  );
}

function parseCustomerRelations(v: unknown): CustomerRelationsMigration {
  if (Array.isArray(v)) return {}; // 旧 flat 形状，无方向信息，返回空（不恢复）
  if (v != null && typeof v === "object") return v as CustomerRelationsMigration;
  return {};
}

function parseCustomerOrgTextDriftTasks(v: unknown): CustomerOrgTextDriftTasksMigration {
  if (Array.isArray(v)) {
    return { migrated: v.filter((x): x is string => typeof x === "string") };
  }
  if (v != null && typeof v === "object") return v as CustomerOrgTextDriftTasksMigration;
  return {};
}

function isPrismaUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function parseCustomerRepTags(v: unknown): CustomerRepTagsMigration {
  if (Array.isArray(v)) return {}; // 旧 flat 形状
  if (v != null && typeof v === "object") return v as CustomerRepTagsMigration;
  return {};
}

function parseCustomerNameAliases(v: unknown): CustomerNameAliasesMigration {
  if (Array.isArray(v)) return {};
  if (v != null && typeof v === "object") return v as CustomerNameAliasesMigration;
  return {};
}

/** 字符串数组安全读取（用于 projects/orders 等纯 ID 键）。 */
function parseStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function parseObjectArray(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => x != null && typeof x === "object")
    : [];
}

/**
 * Profile 快照字段：P0 修复需要独立捕获 Profile 权威业务字段（docs §5）。
 * 撤销时用 Profile 快照恢复。
 */
const PROFILE_SNAPSHOT_FIELDS = [
  "id",
  "ownerUserId",
  "name",
  "namePinyin",
  "customerCode",
  "nameDisambiguator",
  "principal",
  "labOrGroup",
  "phone",
  "wechat",
  "email",
  "miniProgramId",
  "address",
  "addressNote",
  "receiverPhone",
  "receiverAddress",
  "organization",
  "organizationId",
  "organizationSiteId",
  "organizationRawInput",
  "stage",
  "importance",
  "archived",
  "assignmentStatus",
] as const;

const profileSnapshotSelect = Object.fromEntries(
  PROFILE_SNAPSHOT_FIELDS.map((f) => [f, true]),
) as Record<(typeof PROFILE_SNAPSHOT_FIELDS)[number], true>;

/**
 * 解析 Profile 的展示姓名（只读 Profile.name，不回退 Customer.name）。
 * 空白视为空。
 */
function effectiveProfileName(profileName: string | null | undefined): string | null {
  const p = profileName?.trim();
  return p || null;
}

/**
 * Execute a customer merge with full table migration + audit.
 *
 * 主键为 CrmCustomerProfile.id（Profile-only）。
 * Stores IDs for all migrated records so rollback can precisely reverse.
 *
 * `options.afterPreflight`：仅供 smoke 注入——在事务外 preflight 通过后、
 * `$transaction` 开始前执行，用于模拟目标在竞态窗口内被冻结。
 */
export type ExecuteMergeOptions = {
  afterPreflight?: () => Promise<void>;
};

export async function executeMerge(
  sourceProfileId: string,
  targetProfileId: string,
  profileResolution: ProfileResolution,
  orgResolution: OrgResolution,
  operatorId: string,
  options?: ExecuteMergeOptions,
): Promise<MergeResult> {
  if (sourceProfileId === targetProfileId) throw new Error("源客户与目标客户不能相同");

  const [sourceProfileRow, targetProfileRow] = await Promise.all([
    prisma.crmCustomerProfile.findUnique({
      where: { id: sourceProfileId },
      select: { ...profileSnapshotSelect, deleted: true, deletedAt: true, mergedIntoProfileId: true },
    }),
    prisma.crmCustomerProfile.findUnique({
      where: { id: targetProfileId },
      select: { ...profileSnapshotSelect, deleted: true, deletedAt: true, mergedIntoProfileId: true },
    }),
  ]);

  if (!sourceProfileRow || sourceProfileRow.deleted || sourceProfileRow.mergedIntoProfileId) {
    throw new Error("源客户不存在或已是合并别名");
  }
  if (!targetProfileRow || targetProfileRow.deleted || targetProfileRow.mergedIntoProfileId) {
    throw new Error("目标客户不存在或已是合并别名");
  }
  // W6.8：冻结目标不可作为合并宿主（否则 sync skipped 会保留源订单旧代表缓存）
  if (targetProfileRow.archived) {
    throw new Error("目标客户已归档，不能作为合并目标");
  }
  if (
    targetProfileRow.assignmentStatus === "RECALLED"
    || targetProfileRow.assignmentStatus === "RECALL_CANDIDATE"
  ) {
    throw new Error("目标客户处于收回/待收回状态，不能作为合并目标");
  }

  // Profile lifecycle 检查（上方）为唯一主权。
  const preMergeSourceProfile = sourceProfileRow;
  const preMergeTargetProfile = targetProfileRow;

  if (options?.afterPreflight) {
    await options.afterPreflight();
  }

  const result = await prisma.$transaction(async (tx) => {
    // W6.8 P1：事务内复核冻结态（archived / RECALLED / RECALL_CANDIDATE），
    // 避免事务外检查与事务开始之间目标被收回后 sync skipped、仍迁移并保留源订单代表。
    const [currentSource, currentTarget] = await Promise.all([
      tx.crmCustomerProfile.findUnique({
        where: { id: sourceProfileId },
        select: { deleted: true, mergedIntoProfileId: true },
      }),
      tx.crmCustomerProfile.findUnique({
        where: { id: targetProfileId },
        select: {
          deleted: true,
          mergedIntoProfileId: true,
          archived: true,
          assignmentStatus: true,
        },
      }),
    ]);
    if (!currentSource || currentSource.deleted || currentSource.mergedIntoProfileId) {
      throw new Error("源客户已被删除或合并");
    }
    if (!currentTarget || currentTarget.deleted || currentTarget.mergedIntoProfileId) {
      throw new Error("目标客户已被删除或合并");
    }
    if (currentTarget.archived) {
      throw new Error("目标客户已归档，不能作为合并目标");
    }
    if (
      currentTarget.assignmentStatus === "RECALLED"
      || currentTarget.assignmentStatus === "RECALL_CANDIDATE"
    ) {
      throw new Error("目标客户处于收回/待收回状态，不能作为合并目标");
    }

    const migratedCounts: Record<string, number> = {};
    const migratedIds: MigratedIds = {};

    // Phase E：运行时资源迁移只认 Profile 主键。
    const sourceSubjectOr = { profileId: sourceProfileId };

    const sourceSuggestedOr = { suggestedProfileId: sourceProfileId };

    const sourceConfirmedOr = { confirmedProfileId: sourceProfileId };

    // ── 1. Project — 先记录 ID，待 Profile/org resolution 完成后再写入最终 Profile 快照 ──
    const projects = await tx.project.findMany({
      where: sourceSubjectOr,
      select: { id: true, client: true, organization: true },
    });
    migratedCounts.projects = projects.length;
    migratedIds.projects = projects.map((p) => p.id);
    migratedIds.projectSnapshots = projects.map((p) => ({
      id: p.id,
      client: p.client,
      organization: p.organization,
    }));

    // ── 2. Order — find IDs before updateMany, store them ──
    // Also snapshot pre-merge match fields so reverseMerge can restore them.
    // Without the snapshot, a merge followed by reverse would leave orders with
    // the target-resolved match state instead of the original source-time state.
    const orders = await tx.order.findMany({
      where: sourceSubjectOr,
      select: {
        id: true,
        customerMatchStatus: true,
        customerMatchScore: true,
        customerMatchReason: true,
        representativeId: true,
      },
    });
    migratedCounts.orders = orders.length;
    migratedIds.orders = orders.map((o) => o.id);
    migratedIds.orderMatchSnapshots = orders.map((o) => ({
      id: o.id,
      status: o.customerMatchStatus,
      score: o.customerMatchScore,
      reason: o.customerMatchReason,
      representativeId: o.representativeId,
    }));

    // ── 2b. Re-resolve match state for migrated orders（统一 Profile owner 同步，不分锚点）──
    if (orders.length > 0) {
      const synced = await syncProfileRepresentativeLinksFromOwner(
        targetProfileId,
        targetProfileRow.ownerUserId,
        tx,
      );
      // 冻结目标 sync skipped 必须中止合并，禁止静默保留源订单代表缓存
      if (synced.skipped) {
        throw new Error(
          synced.reason === "PROFILE_NOT_ASSIGNABLE"
            ? "目标客户处于冻结状态，无法同步代表，合并已中止"
            : "目标客户代表同步失败，合并已中止",
        );
      }
      await tx.order.updateMany({
        where: { id: { in: orders.map((o) => o.id) } },
        data: {
          customerMatchStatus: "MANUAL_MATCHED",
          customerMatchScore: null,
          customerMatchReason: "existing_customer_binding",
          representativeId: synced.representativeId,
          profileId: targetProfileId,
        },
      });
    }

    // ── 3. ExternalOrder ──
    const extOrders = await tx.externalOrder.findMany({
      where: sourceSubjectOr,
      select: { id: true },
    });
    if (extOrders.length > 0) {
      await tx.externalOrder.updateMany({
        where: { id: { in: extOrders.map((o) => o.id) } },
        data: { profileId: targetProfileId },
      });
    }
    migratedCounts.externalOrders = extOrders.length;
    migratedIds.externalOrders = extOrders.map((o) => o.id);

    // ── 4. FinanceReceipt ──
    const receipts = await tx.financeReceipt.findMany({
      where: sourceSubjectOr,
      select: { id: true },
    });
    if (receipts.length > 0) {
      await tx.financeReceipt.updateMany({
        where: { id: { in: receipts.map((r) => r.id) } },
        data: { profileId: targetProfileId },
      });
    }
    migratedCounts.financeReceipts = receipts.length;
    migratedIds.financeReceipts = receipts.map((r) => r.id);

    // ── 5. FinanceCost ──
    const costs = await tx.financeCost.findMany({
      where: sourceSubjectOr,
      select: { id: true },
    });
    if (costs.length > 0) {
      await tx.financeCost.updateMany({
        where: { id: { in: costs.map((c) => c.id) } },
        data: { profileId: targetProfileId },
      });
    }
    migratedCounts.financeCosts = costs.length;
    migratedIds.financeCosts = costs.map((c) => c.id);

    // ── 6. FinanceAdvance ──
    const advances = await tx.financeAdvance.findMany({
      where: sourceSubjectOr,
      select: { id: true },
    });
    if (advances.length > 0) {
      await tx.financeAdvance.updateMany({
        where: { id: { in: advances.map((a) => a.id) } },
        data: { profileId: targetProfileId },
      });
    }
    migratedCounts.financeAdvances = advances.length;
    migratedIds.financeAdvances = advances.map((a) => a.id);

    // ── 7. CrmCustomerApplication：Profile 优先并集 ──
    const apps = await tx.crmCustomerApplication.findMany({
      where: { createdCrmProfileId: sourceProfileId },
      select: { id: true },
    });
    if (apps.length > 0) {
      await tx.crmCustomerApplication.updateMany({
        where: { id: { in: apps.map((a) => a.id) } },
        data: { createdCrmProfileId: targetProfileId },
      });
    }
    migratedCounts.crmApplications = apps.length;
    migratedIds.crmApplications = apps.map((a) => a.id);
    // 兼容旧撤销路径键名
    migratedIds.crmProfileApplications = apps.map((a) => a.id);
    migratedCounts.crmProfileApplications = apps.length;

    // ── 9. CrmRepresentativeReportLine ──
    const reportLines = await tx.crmRepresentativeReportLine.findMany({
      where: { profileId: sourceProfileId },
      select: { id: true, customerName: true },
    });
    migratedCounts.reportLines = reportLines.length;
    migratedIds.reportLines = reportLines.map((r) => r.id);
    migratedIds.reportLineSnapshots = reportLines.map((r) => ({
      id: r.id,
      customerName: r.customerName,
    }));

    // ── 10. ProgressReceivableAdjustment ──
    const adjustments = await tx.progressReceivableAdjustment.findMany({
      where: sourceSubjectOr,
      select: { id: true },
    });
    if (adjustments.length > 0) {
      await tx.progressReceivableAdjustment.updateMany({
        where: { id: { in: adjustments.map((a) => a.id) } },
        data: { profileId: targetProfileId },
      });
    }
    migratedCounts.adjustments = adjustments.length;
    migratedIds.adjustments = adjustments.map((a) => a.id);

    // ── 11. 其余 Customer 引用：治理、审计、导入与供应链成本 ──
    const receiptDeletionLogs = await tx.financeReceiptDeletionLog.findMany({
      where: sourceSubjectOr,
      select: { id: true },
    });
    if (receiptDeletionLogs.length > 0) {
      await tx.financeReceiptDeletionLog.updateMany({
        where: { id: { in: receiptDeletionLogs.map((row) => row.id) } },
        data: { profileId: targetProfileId },
      });
    }
    migratedIds.financeReceiptDeletionLogs = receiptDeletionLogs.map((row) => row.id);
    migratedCounts.financeReceiptDeletionLogs = receiptDeletionLogs.length;

    const apiAuditLogs = await tx.customerApiAuditLog.findMany({
      where: sourceSubjectOr,
      select: { id: true },
    });
    if (apiAuditLogs.length > 0) {
      await tx.customerApiAuditLog.updateMany({
        where: { id: { in: apiAuditLogs.map((row) => row.id) } },
        data: { profileId: targetProfileId },
      });
    }
    migratedIds.customerApiAuditLogs = apiAuditLogs.map((row) => row.id);
    migratedCounts.customerApiAuditLogs = apiAuditLogs.length;

    // 机构绑定任务以 profileId 为唯一键
    const orgBindingTask = await tx.customerOrgBindingTask.findUnique({
      where: { profileId: sourceProfileId },
      select: { id: true, status: true, resolutionNote: true },
    });
    const targetOrgBindingTask = await tx.customerOrgBindingTask.findUnique({
      where: { profileId: targetProfileId },
      select: { id: true },
    });
    if (orgBindingTask) {
      if (!targetOrgBindingTask) {
        await tx.customerOrgBindingTask.update({
          where: { id: orgBindingTask.id },
          data: {
            profileId: targetProfileId,
          },
        });
        migratedIds.customerOrgBindingTasks = { migrated: [orgBindingTask.id], ignored: [] };
        migratedCounts.customerOrgBindingTasks = 1;
      } else {
        // 目标已有任务：源任务退出活动队列
        await tx.customerOrgBindingTask.update({
          where: { id: orgBindingTask.id },
          data: {
            status: "IGNORED",
            resolutionNote: "客户合并：目标档案已有机构绑定治理任务",
          },
        });
        migratedIds.customerOrgBindingTasks = {
          migrated: [],
          ignored: [{ id: orgBindingTask.id, status: orgBindingTask.status, resolutionNote: orgBindingTask.resolutionNote }],
        };
        migratedCounts.customerOrgBindingTasks = 1;
      }
    }

    const orgTextDriftTask = await tx.customerOrgTextDriftTask.findFirst({
      where: { profileId: sourceProfileId },
      select: { id: true, status: true, resolutionNote: true },
    });
    const targetOrgTextDriftTask = await tx.customerOrgTextDriftTask.findFirst({
      where: { profileId: targetProfileId },
      select: { id: true },
    });
    if (orgTextDriftTask) {
      // Profile-only：漂移任务以 profileId 为唯一键，目标无任务时直接迁移
      if (!targetOrgTextDriftTask) {
        await tx.customerOrgTextDriftTask.update({
          where: { id: orgTextDriftTask.id },
          data: { profileId: targetProfileId },
        });
        migratedIds.customerOrgTextDriftTasks = {
          migrated: [orgTextDriftTask.id],
          ignored: [],
        };
        migratedCounts.customerOrgTextDriftTasks = 1;
      } else {
        await tx.customerOrgTextDriftTask.update({
          where: { id: orgTextDriftTask.id },
          data: {
            status: "IGNORED",
            resolutionNote: "客户合并：目标客户已有机构文本漂移治理任务",
          },
        });
        migratedIds.customerOrgTextDriftTasks = {
          migrated: [],
          ignored: [{
            id: orgTextDriftTask.id,
            status: orgTextDriftTask.status,
            resolutionNote: orgTextDriftTask.resolutionNote,
          }],
        };
        migratedCounts.customerOrgTextDriftTasks = 1;
      }
    }

    const suggestedImportRows = await tx.orderImportRow.findMany({
      where: sourceSuggestedOr,
      select: { id: true },
    });
    const confirmedImportRows = await tx.orderImportRow.findMany({
      where: sourceConfirmedOr,
      select: { id: true },
    });
    if (suggestedImportRows.length > 0) {
      await tx.orderImportRow.updateMany({
        where: { id: { in: suggestedImportRows.map((row) => row.id) } },
        data: { suggestedProfileId: targetProfileId },
      });
    }
    if (confirmedImportRows.length > 0) {
      await tx.orderImportRow.updateMany({
        where: { id: { in: confirmedImportRows.map((row) => row.id) } },
        data: { confirmedProfileId: targetProfileId },
      });
    }
    migratedIds.orderImportRowsSuggested = suggestedImportRows.map((row) => row.id);
    migratedIds.orderImportRowsConfirmed = confirmedImportRows.map((row) => row.id);
    migratedCounts.orderImportRows = suggestedImportRows.length + confirmedImportRows.length;

    const costEntries = await tx.costEntry.findMany({
      where: sourceSubjectOr,
      select: { id: true },
    });
    if (costEntries.length > 0) {
      await tx.costEntry.updateMany({
        where: { id: { in: costEntries.map((row) => row.id) } },
        data: { profileId: targetProfileId },
      });
    }
    migratedIds.costEntries = costEntries.map((row) => row.id);
    migratedCounts.costEntries = costEntries.length;

    // ── CrmCustomerProfile（W4：两端 Profile 已知）──
    const preMergeSourceAliases = await tx.crmCustomerNameAlias.findMany({
      where: { profileId: sourceProfileId, active: true },
    });

    let resolvedProfileResolution: string = profileResolution;
    const sourceProfile = await tx.crmCustomerProfile.findUnique({ where: { id: sourceProfileId } });
    const targetProfile = await tx.crmCustomerProfile.findUnique({ where: { id: targetProfileId } });
    if (!sourceProfile || !targetProfile) {
      throw new Error("合并源/目标 Profile 不存在");
    }

    // 双 Profile：把无唯一冲突的 CRM 历史迁入保留 Profile
    {
      const resourceSpecs = [
        ["crmInteractions", tx.crmInteraction, "profileId"],
        ["crmFollowUpTasks", tx.crmFollowUpTask, "profileId"],
        ["crmVisitCheckins", tx.crmVisitCheckin, "profileId"],
        ["crmCustomerAddresses", tx.crmCustomerAddress, "profileId"],
        ["crmAssignmentLogs", tx.crmCustomerAssignmentLog, "profileId"],
        ["crmComplaints", tx.crmComplaint, "profileId"],
      ] as const;
      for (const [key, rawModel] of resourceSpecs) {
        const model = rawModel as unknown as ProfileResourceDelegate;
        const rows = await model.findMany({
          where: { profileId: sourceProfile.id },
          select: { id: true },
        });
        if (rows.length > 0) {
          await model.updateMany({
            where: { id: { in: rows.map((row) => row.id) } },
            data: { profileId: targetProfile.id },
          });
        }
        migratedIds[key] = rows.map((row) => row.id);
        migratedCounts[key] = rows.length;
      }

      // CrmCustomerApplication 已在上方 Profile 并集迁移；此处不再重复扫描

      const stageHistory = await tx.crmCustomerStageHistory.findMany({
        where: { profileId: sourceProfile.id },
        select: { id: true },
      });
      if (stageHistory.length > 0) {
        await tx.crmCustomerStageHistory.updateMany({
          where: { id: { in: stageHistory.map((row) => row.id) } },
          data: { profileId: targetProfile.id },
        });
      }
      migratedIds.crmStageHistory = stageHistory.map((row) => row.id);
      migratedCounts.crmStageHistory = stageHistory.length;

      const sourcePreferences = await tx.crmCustomerPreference.findMany({
        where: { profileId: sourceProfile.id },
        select: { id: true, sourceType: true, key: true, status: true },
      });
      const targetPreferenceKeys = new Set((await tx.crmCustomerPreference.findMany({
        where: { profileId: targetProfile.id },
        select: { sourceType: true, key: true },
      })).map((row) => `${row.sourceType}::${row.key}`));
      const migratedPreferenceIds: string[] = [];
      const archivedPreferences: Array<{ id: string; status: string }> = [];
      for (const preference of sourcePreferences) {
        const key = `${preference.sourceType}::${preference.key}`;
        if (targetPreferenceKeys.has(key)) {
          archivedPreferences.push({ id: preference.id, status: preference.status });
          await tx.crmCustomerPreference.update({
            where: { id: preference.id },
            data: { status: "ARCHIVED" },
          });
        } else {
          await tx.crmCustomerPreference.update({
            where: { id: preference.id },
            data: { profileId: targetProfile.id },
          });
          targetPreferenceKeys.add(key);
          migratedPreferenceIds.push(preference.id);
        }
      }
      migratedIds.crmPreferences = { migrated: migratedPreferenceIds, archived: archivedPreferences };
      migratedCounts.crmPreferences = sourcePreferences.length;

      if (profileResolution === "KEEP_SOURCE") {
        // customerCode 全局唯一：不能在源行仍占用时直接写到目标。
        const keepCustomerCode = sourceProfile.customerCode;
        await tx.crmCustomerProfile.update({
          where: { id: sourceProfileId },
          data: { customerCode: null },
        });
        // namePinyin 跳过快照直传，改以 name 为准重新计算，避免历史脏值漂移。
        const sourceFields = Object.fromEntries(
          PROFILE_SNAPSHOT_FIELDS
            .filter((field) => field !== "id" && field !== "customerCode" && field !== "namePinyin")
            .map((field) => [field, sourceProfile[field as keyof typeof sourceProfile]]),
        );
        await tx.crmCustomerProfile.update({
          where: { id: targetProfile.id },
          data: {
            ...sourceFields,
            namePinyin: toPinyinToneless(sourceProfile.name ?? "") || null,
            customerCode: keepCustomerCode,
            archived: false,
          },
        });
        resolvedProfileResolution = "KEEP_SOURCE";
      } else {
        resolvedProfileResolution = profileResolution === "KEEP_TARGET" ? "KEEP_TARGET" : "ARCHIVED";
      }
    }

    // KEEP_SOURCE_ORG：从源 Profile 同步机构字段到目标
    if (orgResolution === "KEEP_SOURCE_ORG") {
      await tx.crmCustomerProfile.update({
        where: { id: targetProfileId },
        data: {
          organization: sourceProfile.organization,
          organizationId: sourceProfile.organizationId,
          organizationSiteId: sourceProfile.organizationSiteId,
          organizationRawInput: sourceProfile.organizationRawInput,
        },
      });
    }

    const finalTargetProfileForSnapshots = await tx.crmCustomerProfile.findUnique({
      where: { id: targetProfileId },
      select: { id: true, name: true, organization: true },
    });
    const targetEffectiveName = effectiveProfileName(finalTargetProfileForSnapshots?.name) ?? "";
    const targetOrganization = finalTargetProfileForSnapshots?.organization ?? null;

    for (const project of projects) {
      const updateData: Record<string, unknown> = {
        profileId: targetProfileId,
        client: targetEffectiveName,
      };
      if (orgResolution === "KEEP_SOURCE_ORG" || !project.organization) {
        updateData.organization = targetOrganization;
      }
      await tx.project.update({ where: { id: project.id }, data: updateData });
    }

    if (reportLines.length > 0) {
      await tx.crmRepresentativeReportLine.updateMany({
        where: { id: { in: reportLines.map((r) => r.id) } },
        data: {
          profileId: targetProfileId,
          customerName: targetEffectiveName,
        },
      });
    }

    // ── CustomerRepTag：按 profileId 迁并（W4）──
    const sourceTags = await tx.customerRepTag.findMany({ where: { profileId: sourceProfileId } });
    const targetTags = await tx.customerRepTag.findMany({
      where: { profileId: targetProfileId },
      select: { representativeId: true, tagType: true },
    });
    const targetTagKeys = new Set(targetTags.map((t) => `${t.representativeId}::${t.tagType}`));
    const migratedTagIds: string[] = [];
    const deactivatedTagIds: string[] = [];
    for (const tag of sourceTags) {
      const key = `${tag.representativeId}::${tag.tagType}`;
      if (targetTagKeys.has(key)) {
        if (tag.isActive) {
          await tx.customerRepTag.update({
            where: { id: tag.id },
            data: {
              isActive: false,
              endedAt: new Date(),
              note: tag.note ? `${tag.note}（客户合并：保留目标客户同代表标注）` : "客户合并：保留目标客户同代表标注",
            },
          });
          deactivatedTagIds.push(tag.id);
        }
      } else {
        await tx.customerRepTag.update({
          where: { id: tag.id },
          data: {
            profileId: targetProfileId,
          },
        });
        targetTagKeys.add(key);
        migratedTagIds.push(tag.id);
      }
    }
    migratedCounts.customerRepTags = migratedTagIds.length;
    migratedIds.customerRepTags = { migrated: migratedTagIds, deactivated: deactivatedTagIds };

    // ── Relations：按 profileId 迁并（W4）──
    // 快照只选 Profile 端点（旧日志残留锚点键解析时忽略）
    const relationSelect = {
      id: true,
      fromProfileId: true,
      toProfileId: true,
      type: true,
      strength: true,
      notes: true,
      introducedAt: true,
      createdByUserId: true,
    } as const;
    const relsFromProfile = await tx.customerRelation.findMany({
      where: { fromProfileId: sourceProfileId },
      select: relationSelect,
    });
    const relsToProfile = await tx.customerRelation.findMany({
      where: { toProfileId: sourceProfileId },
      select: relationSelect,
    });
    const migratedRelationFromIds: string[] = [];
    const migratedRelationToIds: string[] = [];
    const deletedRelations: CustomerRelationSnapshot[] = [];

    for (const rel of relsFromProfile) {
      try {
        await tx.customerRelation.update({
          where: { id: rel.id },
          data: {
            fromProfileId: targetProfileId,
          },
        });
        migratedRelationFromIds.push(rel.id);
      } catch (err) {
        if (!isPrismaUniqueViolation(err)) throw err;
        deletedRelations.push(rel);
        await tx.customerRelation.delete({ where: { id: rel.id } });
      }
    }
    for (const rel of relsToProfile) {
      try {
        await tx.customerRelation.update({
          where: { id: rel.id },
          data: {
            toProfileId: targetProfileId,
          },
        });
        migratedRelationToIds.push(rel.id);
      } catch (err) {
        if (!isPrismaUniqueViolation(err)) throw err;
        deletedRelations.push(rel);
        await tx.customerRelation.delete({ where: { id: rel.id } });
      }
    }
    const customerRelationsMigration: CustomerRelationsMigration = {
      from: migratedRelationFromIds,
      to: migratedRelationToIds,
      ...(deletedRelations.length > 0 ? { deleted: deletedRelations } : {}),
    };
    migratedIds.customerRelations = customerRelationsMigration;
    migratedCounts.customerRelations = migratedRelationFromIds.length + migratedRelationToIds.length
      + deletedRelations.length;

    // ── 代表缓存同步（保留最终 owner，不覆盖 KEEP_SOURCE；tag 不写 Customer 锚点）──
    const finalTargetProfileForSync = await tx.crmCustomerProfile.findUnique({
      where: { id: targetProfileId },
      select: {
        ownerUserId: true,
        archived: true,
        assignmentStatus: true,
        deleted: true,
        mergedIntoProfileId: true,
      },
    });
    if (finalTargetProfileForSync) {
      if (
        finalTargetProfileForSync.deleted
        || finalTargetProfileForSync.mergedIntoProfileId
        || finalTargetProfileForSync.archived
        || finalTargetProfileForSync.assignmentStatus === "RECALLED"
        || finalTargetProfileForSync.assignmentStatus === "RECALL_CANDIDATE"
      ) {
        throw new Error("目标客户在合并过程中变为不可分配状态，合并已中止");
      }
      const finalSynced = await syncProfileRepresentativeLinksFromOwner(
        targetProfileId,
        finalTargetProfileForSync.ownerUserId,
        tx,
      );
      if (finalSynced.skipped) {
        throw new Error(
          finalSynced.reason === "PROFILE_NOT_ASSIGNABLE"
            ? "目标客户处于冻结状态，无法同步代表，合并已中止"
            : "目标客户代表同步失败，合并已中止",
        );
      }
      if (finalTargetProfileForSync.ownerUserId) {
        await syncManagingTagForProfileOwner(tx, {
          profileId: targetProfileId,
          ownerUserId: finalTargetProfileForSync.ownerUserId,
          actingUserId: operatorId,
          note: "客户合并：管理关系同步",
        });
      }
    }

    // ── Profile lifecycle：源标记合并别名 ──
    await tx.crmCustomerProfile.update({
      where: { id: sourceProfileId },
      data: {
        deleted: true,
        deletedAt: new Date(),
        mergedIntoProfileId: targetProfileId,
        archived: true,
      },
    });

    // ── Write CustomerMergeLog ──
    const mergeLog = await tx.customerMergeLog.create({
      data: {
        sourceProfileId,
        targetProfileId,
        migratedCountsJson: JSON.stringify(migratedCounts),
        migratedIdsJson: JSON.stringify(migratedIds),
        sourceSnapshotJson: "{}",
        targetSnapshotJson: "{}",
        sourceProfileSnapshotJson: JSON.stringify(preMergeSourceProfile),
        targetProfileSnapshotJson: JSON.stringify(preMergeTargetProfile),
        profileResolution: resolvedProfileResolution,
        orgResolution,
        operatorId,
      },
    });

    // ── P1：合并沉淀姓名变体到 target ──
    const finalTargetProfile = await tx.crmCustomerProfile.findUnique({
      where: { id: targetProfileId },
      select: { id: true, name: true },
    });
    const createdAliasIds: string[] = [];
    const reusedAliasIds: string[] = [];
    const reactivatedAliases: Array<{ id: string; alias: string; active: boolean }> = [];
    if (finalTargetProfile) {
      const finalName = effectiveProfileName(finalTargetProfile.name);
      const finalNameNorm = finalName ? normalizeCustomerNameAlias(finalName) : "";

      // 合并前 effective name（只读 Profile.name，不回退 Customer.name）
      const sourcePreName = effectiveProfileName(preMergeSourceProfile?.name);
      const targetPreName = effectiveProfileName(preMergeTargetProfile?.name);

      // 构建候选称呼集合（§6.2）
      const candidates: AliasCandidate[] = [];

      // source 合并前 effective name -> MERGED_NAME
      if (sourcePreName) {
        const norm = normalizeCustomerNameAlias(sourcePreName);
        if (norm && norm !== finalNameNorm) {
          candidates.push({ raw: sourcePreName, normalized: norm, aliasType: NAME_ALIAS_TYPE.MERGED_NAME });
        }
      }
      // target 合并前 effective name 若与最终正式姓名不同 -> FORMER_NAME
      if (targetPreName) {
        const norm = normalizeCustomerNameAlias(targetPreName);
        if (norm && norm !== finalNameNorm) {
          candidates.push({ raw: targetPreName, normalized: norm, aliasType: NAME_ALIAS_TYPE.FORMER_NAME });
        }
      }
      // source 的活动称呼，保留原类型
      for (const a of preMergeSourceAliases) {
        const raw = a.alias.trim();
        if (!raw) continue;
        const norm = normalizeCustomerNameAlias(raw);
        if (!norm || norm === finalNameNorm) continue;
        candidates.push({
          raw,
          normalized: norm,
          aliasType: (a.aliasType as NameAliasType) || NAME_ALIAS_TYPE.COMMON,
        });
      }

      // 候选去重（归一化相同取高优先级）
      const deduped = dedupeAliasCandidates(candidates);

      // 关键修复：在 Profile resolution 后重新加载最终 target Profile 的【全部】 aliases（含停用）。
      // KEEP_SOURCE 搬迁场景下 source aliases 已随 Profile 移到 target，
      // 直接 create 会撞 @@unique([profileId, normalizedAlias])（P2002）。target 有同名 inactive alias
      // 时同样会 P2002。必须查最终 target 全量 aliases 做复用/恢复/创建判断。
      const finalTargetAllAliases = await tx.crmCustomerNameAlias.findMany({
        where: { profileId: finalTargetProfile.id },
      });
      const finalTargetAliasByNorm = new Map(
        finalTargetAllAliases.map((a) => [a.normalizedAlias, a]),
      );

      // §11.1 冲突规则 3：合并产生的 MERGED_NAME/FORMER_NAME 与 target 现有 COMMON 冲突时，
      // 保持现有 COMMON 不变（不升级、不覆盖、不创建新记录），匹配可信度按记录真实类型计算。
      // inactive 同 normalizedAlias 仍受唯一约束：如需创建但已有 inactive 记录，恢复原记录而非 create 第二条。
      for (const c of deduped) {
        const existing = finalTargetAliasByNorm.get(c.normalized);
        if (existing) {
          if (!existing.active) {
            // 记录恢复前状态，撤销时恢复 inactive + 原文
            reactivatedAliases.push({ id: existing.id, alias: existing.alias, active: false });
            await tx.crmCustomerNameAlias.update({
              where: { id: existing.id },
              data: { active: true, alias: c.raw },
            });
            // 不放入 reused（reused 是只读不回滚的纯复用），reactivated 撤销时需要恢复
          } else {
            // 已活动：复用，不改型，记入 reused（撤销时只读不删）
            reusedAliasIds.push(existing.id);
          }
          continue;
        }
        const created = await tx.crmCustomerNameAlias.create({
          data: {
            profileId: finalTargetProfile.id,
            alias: c.raw,
            normalizedAlias: c.normalized,
            aliasType: c.aliasType,
            sourceType: NAME_ALIAS_SOURCE.CUSTOMER_MERGE,
            sourceMergeLogId: mergeLog.id,
            createdById: operatorId,
            active: true,
          },
        });
        createdAliasIds.push(created.id);
      }
    }
    migratedCounts.customerNameAliases = createdAliasIds.length + reusedAliasIds.length + reactivatedAliases.length;
    migratedIds.customerNameAliases = { created: createdAliasIds, reused: reusedAliasIds, reactivated: reactivatedAliases };

    // mergeLog 的 migratedIdsJson 需要回写最新值（含 alias 迁移清单）
    await tx.customerMergeLog.update({
      where: { id: mergeLog.id },
      data: {
        migratedIdsJson: JSON.stringify(migratedIds),
        migratedCountsJson: JSON.stringify(migratedCounts),
      },
    });

    return { mergeLogId: mergeLog.id, migratedCounts, migratedIds };
  });

  return result;
}

/**
 * 从快照构建 CrmCustomerProfile 业务字段还原对象。
 * 新日志使用 Profile 快照；旧日志仍可从历史 Customer 快照读取同名字段兼容撤销。
 */
function buildProfileRestore(
  snapshot: Record<string, unknown>,
): Partial<Record<CrmProfileBusinessField, string | null>> {
  const restore: Partial<Record<CrmProfileBusinessField, string | null>> = {};
  for (const f of CRM_PROFILE_BUSINESS_FIELDS) {
    if (snapshot[f] !== undefined) {
      restore[f] = (snapshot[f] as string | null) ?? null;
    }
  }
  return restore;
}

function parseLegacySnapshotJson(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return Object.keys(parsed).length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reverse a merge (within 30 days, not already reversed).
 *
 * Uses migratedIdsJson for precise reversal — all IDs are stored at merge time.
 * Restores full source/target snapshots including FK fields.
 */
export async function reverseMerge(logId: string, operatorId: string, reason: string) {
  const log = await prisma.customerMergeLog.findUnique({
    where: { id: logId },
  });

  if (!log) throw new Error("合并记录不存在");
  if (log.reversedAt) throw new Error("该合并已撤销");

  const windowDays = parseInt(process.env.CUSTOMER_MERGE_REVERSE_WINDOW_DAYS || "30", 10);
  if (Date.now() - log.createdAt.getTime() > windowDays * 24 * 60 * 60 * 1000) {
    throw new Error(`超过${windowDays}天撤销窗口期`);
  }

  const migratedIds = JSON.parse(log.migratedIdsJson) as MigratedIds;
  const sourceSnapshot = parseLegacySnapshotJson(log.sourceSnapshotJson);
  const targetSnapshot = parseLegacySnapshotJson(log.targetSnapshotJson);
  // P0：新日志有 Profile 权威快照时使用新快照恢复；旧日志为 null 沿用 Customer 快照恢复。
  const sourceProfileSnapshot = log.sourceProfileSnapshotJson
    ? (JSON.parse(log.sourceProfileSnapshotJson) as Record<string, unknown>)
    : null;
  const targetProfileSnapshot = log.targetProfileSnapshotJson
    ? (JSON.parse(log.targetProfileSnapshotJson) as Record<string, unknown>)
    : null;

  await prisma.$transaction(async (tx) => {
    const sourceProfileId = log.sourceProfileId;
    const targetProfileId = log.targetProfileId;

    const restoreSubject = {
      profileId: sourceProfileId,
    };

    // ── Reverse each table using stored IDs ──
    const projectIds = parseStringArray(migratedIds.projects);
    if (projectIds.length) {
      await tx.project.updateMany({ where: { id: { in: projectIds } }, data: restoreSubject });
    }
    for (const snapshot of parseObjectArray(migratedIds.projectSnapshots)) {
      if (typeof snapshot.id !== "string") continue;
      await tx.project.update({
        where: { id: snapshot.id },
        data: {
          client: typeof snapshot.client === "string" ? snapshot.client : null,
          organization: typeof snapshot.organization === "string" ? snapshot.organization : null,
        },
      });
    }
    const orderIds = parseStringArray(migratedIds.orders);
    if (orderIds.length) {
      await tx.order.updateMany({ where: { id: { in: orderIds } }, data: restoreSubject });
    }

    // ── Restore pre-merge match state for migrated orders ──
    const matchSnapshots = parseOrderMatchSnapshots(migratedIds.orderMatchSnapshots);
    if (matchSnapshots.length) {
      for (const snap of matchSnapshots) {
        await tx.order.update({
          where: { id: snap.id },
          data: {
            customerMatchStatus: snap.status,
            customerMatchScore: snap.score,
            customerMatchReason: snap.reason,
            representativeId: snap.representativeId,
          },
        });
      }
    }
    const externalOrderIds = parseStringArray(migratedIds.externalOrders);
    if (externalOrderIds.length) {
      await tx.externalOrder.updateMany({ where: { id: { in: externalOrderIds } }, data: restoreSubject });
    }
    const financeReceiptIds = parseStringArray(migratedIds.financeReceipts);
    if (financeReceiptIds.length) {
      await tx.financeReceipt.updateMany({ where: { id: { in: financeReceiptIds } }, data: restoreSubject });
    }
    const financeCostIds = parseStringArray(migratedIds.financeCosts);
    if (financeCostIds.length) {
      await tx.financeCost.updateMany({ where: { id: { in: financeCostIds } }, data: restoreSubject });
    }
    const financeAdvanceIds = parseStringArray(migratedIds.financeAdvances);
    if (financeAdvanceIds.length) {
      await tx.financeAdvance.updateMany({ where: { id: { in: financeAdvanceIds } }, data: restoreSubject });
    }
    const crmAppIds = [
      ...parseStringArray(migratedIds.crmApplications),
      ...parseStringArray(migratedIds.crmProfileApplications),
    ];
    const uniqueCrmAppIds = [...new Set(crmAppIds)];
    if (uniqueCrmAppIds.length) {
      await tx.crmCustomerApplication.updateMany({
        where: { id: { in: uniqueCrmAppIds } },
        data: { createdCrmProfileId: sourceProfileId },
      });
    }
    const reportLineIds = parseStringArray(migratedIds.reportLines);
    if (reportLineIds.length) {
      await tx.crmRepresentativeReportLine.updateMany({
        where: { id: { in: reportLineIds } },
        data: restoreSubject,
      });
    }
    for (const snapshot of parseObjectArray(migratedIds.reportLineSnapshots)) {
      if (typeof snapshot.id !== "string") continue;
      await tx.crmRepresentativeReportLine.update({
        where: { id: snapshot.id },
        data: { customerName: typeof snapshot.customerName === "string" ? snapshot.customerName : "" },
      });
    }
    const adjustmentIds = parseStringArray(migratedIds.adjustments);
    if (adjustmentIds.length) {
      await tx.progressReceivableAdjustment.updateMany({
        where: { id: { in: adjustmentIds } },
        data: { profileId: sourceProfileId },
      });
    }

    {
      const resourceSpecs = [
        [migratedIds.crmInteractions, tx.crmInteraction],
        [migratedIds.crmFollowUpTasks, tx.crmFollowUpTask],
        [migratedIds.crmVisitCheckins, tx.crmVisitCheckin],
        [migratedIds.crmCustomerAddresses, tx.crmCustomerAddress],
        [migratedIds.crmAssignmentLogs, tx.crmCustomerAssignmentLog],
        [migratedIds.crmComplaints, tx.crmComplaint],
      ] as const;
      for (const [rawIds, rawModel] of resourceSpecs) {
        const ids = parseStringArray(rawIds);
        if (ids.length > 0) {
          const model = rawModel as unknown as ProfileResourceDelegate;
          await model.updateMany({
            where: { id: { in: ids } },
            data: { profileId: sourceProfileId },
          });
        }
      }

      const stageHistoryIds = parseStringArray(migratedIds.crmStageHistory);
      if (stageHistoryIds.length > 0) {
        await tx.crmCustomerStageHistory.updateMany({
          where: { id: { in: stageHistoryIds } },
          data: {
            profileId: sourceProfileId,
          },
        });
      }

      const preferenceMigration = migratedIds.crmPreferences;
      if (preferenceMigration && typeof preferenceMigration === "object" && !Array.isArray(preferenceMigration)) {
        const migration = preferenceMigration as Record<string, unknown>;
        const migratedPreferenceIds = parseStringArray(migration.migrated);
        if (migratedPreferenceIds.length > 0) {
          await tx.crmCustomerPreference.updateMany({
            where: { id: { in: migratedPreferenceIds } },
            data: { profileId: sourceProfileId },
          });
        }
        for (const snapshot of parseObjectArray(migration.archived)) {
          if (typeof snapshot.id !== "string" || typeof snapshot.status !== "string") continue;
          await tx.crmCustomerPreference.update({
            where: { id: snapshot.id },
            data: { status: snapshot.status },
          });
        }
      }
    }

    const receiptDeletionLogIds = parseStringArray(migratedIds.financeReceiptDeletionLogs);
    if (receiptDeletionLogIds.length) {
      await tx.financeReceiptDeletionLog.updateMany({
        where: { id: { in: receiptDeletionLogIds } },
        data: { profileId: sourceProfileId },
      });
    }
    const apiAuditLogIds = parseStringArray(migratedIds.customerApiAuditLogs);
    if (apiAuditLogIds.length) {
      await tx.customerApiAuditLog.updateMany({
        where: { id: { in: apiAuditLogIds } },
        data: { profileId: sourceProfileId },
      });
    }
    const orgBindingMigration = migratedIds.customerOrgBindingTasks;
    if (orgBindingMigration && typeof orgBindingMigration === "object" && !Array.isArray(orgBindingMigration)) {
      const migration = orgBindingMigration as Record<string, unknown>;
      const migratedTaskIds = parseStringArray(migration.migrated);
      if (migratedTaskIds.length) {
        await tx.customerOrgBindingTask.updateMany({
          where: { id: { in: migratedTaskIds } },
          data: {
            profileId: sourceProfileId,
          },
        });
      }
      for (const snapshot of parseObjectArray(migration.ignored)) {
        if (typeof snapshot.id !== "string" || typeof snapshot.status !== "string") continue;
        await tx.customerOrgBindingTask.update({
          where: { id: snapshot.id },
          data: {
            status: snapshot.status,
            resolutionNote: typeof snapshot.resolutionNote === "string" ? snapshot.resolutionNote : null,
          },
        });
      }
    }
    const orgTextDriftMigration = parseCustomerOrgTextDriftTasks(migratedIds.customerOrgTextDriftTasks);
    if (orgTextDriftMigration.migrated?.length) {
      await tx.customerOrgTextDriftTask.updateMany({
        where: { id: { in: orgTextDriftMigration.migrated } },
        data: {
          profileId: sourceProfileId,
        },
      });
    }
    for (const snapshot of orgTextDriftMigration.ignored ?? []) {
      await tx.customerOrgTextDriftTask.update({
        where: { id: snapshot.id },
        data: {
          status: snapshot.status,
          resolutionNote: snapshot.resolutionNote,
        },
      });
    }
    const suggestedImportRowIds = parseStringArray(migratedIds.orderImportRowsSuggested);
    if (suggestedImportRowIds.length) {
      await tx.orderImportRow.updateMany({
        where: { id: { in: suggestedImportRowIds } },
        data: { suggestedProfileId: sourceProfileId },
      });
    }
    const confirmedImportRowIds = parseStringArray(migratedIds.orderImportRowsConfirmed);
    if (confirmedImportRowIds.length) {
      await tx.orderImportRow.updateMany({
        where: { id: { in: confirmedImportRowIds } },
        data: { confirmedProfileId: sourceProfileId },
      });
    }
    const costEntryIds = parseStringArray(migratedIds.costEntries);
    if (costEntryIds.length) {
      await tx.costEntry.updateMany({
        where: { id: { in: costEntryIds } },
        data: { profileId: sourceProfileId },
      });
    }

    // ── CustomerRelation: restore edges per-direction ──
    const relIds = parseCustomerRelations(migratedIds.customerRelations);
    if (relIds.from?.length) {
      await tx.customerRelation.updateMany({
        where: { id: { in: relIds.from } },
        data: {
          fromProfileId: sourceProfileId,
        },
      });
    }
    if (relIds.to?.length) {
      await tx.customerRelation.updateMany({
        where: { id: { in: relIds.to } },
        data: {
          toProfileId: sourceProfileId,
        },
      });
    }
    for (const snapshot of relIds.deleted ?? []) {
      const existing = await tx.customerRelation.findUnique({
        where: { id: snapshot.id },
        select: { id: true },
      });
      if (existing) continue;
      // 快照已是合并前完整端点，原样重建；勿把 target 端点改写成 source
      const fromProfileId = snapshot.fromProfileId;
      const toProfileId = snapshot.toProfileId;
      try {
        await tx.customerRelation.create({
          data: {
            id: snapshot.id,
            fromProfileId,
            toProfileId,
            type: snapshot.type,
            strength: snapshot.strength,
            notes: snapshot.notes,
            introducedAt: snapshot.introducedAt,
            createdByUserId: snapshot.createdByUserId,
          },
        });
      } catch (err) {
        if (!isPrismaUniqueViolation(err)) throw err;
        await tx.customerRelation.create({
          data: {
            fromProfileId,
            toProfileId,
            type: snapshot.type,
            strength: snapshot.strength,
            notes: snapshot.notes,
            introducedAt: snapshot.introducedAt,
            createdByUserId: snapshot.createdByUserId,
          },
        });
      }
    }

    // ── CustomerRepTag: reverse migration + reactivation ──
    const tagMigration = parseCustomerRepTags(migratedIds.customerRepTags);
    if (tagMigration.migrated?.length) {
      await tx.customerRepTag.updateMany({
        where: { id: { in: tagMigration.migrated } },
        data: {
          profileId: sourceProfileId,
        },
      });
    }
    if (tagMigration.deactivated?.length) {
      await tx.customerRepTag.updateMany({
        where: { id: { in: tagMigration.deactivated } },
        data: { isActive: true, endedAt: null },
      });
    }

    // ── P1：删除本次合并为 target 新建的姓名变体（docs §6.4）──
    const aliasMigration = parseCustomerNameAliases(migratedIds.customerNameAliases);
    if (aliasMigration.created?.length) {
      const aliases = await tx.crmCustomerNameAlias.findMany({
        where: { id: { in: aliasMigration.created } },
        select: { id: true, profileId: true, sourceMergeLogId: true },
      });
      const toDelete = aliases.filter(
        (a) => a.sourceMergeLogId === logId || a.profileId === targetProfileId,
      );
      if (toDelete.length > 0) {
        await tx.crmCustomerNameAlias.deleteMany({
          where: { id: { in: toDelete.map((a) => a.id) } },
        });
      }
    }

    if (aliasMigration.reactivated?.length) {
      for (const r of aliasMigration.reactivated) {
        const existing = await tx.crmCustomerNameAlias.findUnique({
          where: { id: r.id },
          select: { id: true },
        });
        if (!existing) continue;
        await tx.crmCustomerNameAlias.update({
          where: { id: r.id },
          data: { active: r.active, alias: r.alias },
        });
      }
    }

    // ── Restore source/target Profile（customerCode 对称避免唯一键冲突）──
    // KEEP_SOURCE 正向会把源 code 清空再写给目标；撤销须先腾空目标 code，再恢复源，最后恢复目标原 code。
    const sourceProfileRestoreBase = sourceProfileSnapshot ?? sourceSnapshot ?? {};
    const targetProfileRestoreBase = targetProfileSnapshot ?? targetSnapshot ?? {};
    const sourceProfileRestore = buildProfileRestore(sourceProfileRestoreBase);
    const targetProfileRestore = buildProfileRestore(targetProfileRestoreBase);
    const sourcePreArchived = sourceProfileSnapshot?.archived;
    const sourceCode = (sourceProfileRestore.customerCode
      ?? (typeof sourceProfileRestoreBase.customerCode === "string" ? sourceProfileRestoreBase.customerCode : null)) as string | null;
    const targetCode = (targetProfileRestore.customerCode
      ?? (typeof targetProfileRestoreBase.customerCode === "string" ? targetProfileRestoreBase.customerCode : null)) as string | null;

    const sourceProfileRow = await tx.crmCustomerProfile.findUnique({
      where: { id: sourceProfileId },
      select: { id: true },
    });
    if (!sourceProfileRow) {
      throw new Error("撤销失败：源 Profile 不存在");
    }
    const targetProfileRow = await tx.crmCustomerProfile.findUnique({
      where: { id: targetProfileId },
      select: { id: true },
    });
    if (!targetProfileRow) {
      throw new Error("撤销失败：目标 Profile 不存在");
    }

    // 1) 两侧先清空 customerCode，避免交叉恢复撞唯一键
    await tx.crmCustomerProfile.update({
      where: { id: targetProfileId },
      data: { customerCode: null },
    });
    await tx.crmCustomerProfile.update({
      where: { id: sourceProfileId },
      data: { customerCode: null },
    });

    // 2) 恢复源 Profile（含原 customerCode）
    await tx.crmCustomerProfile.update({
      where: { id: sourceProfileId },
      data: {
        deleted: false,
        deletedAt: null,
        mergedIntoProfileId: null,
        archived: sourcePreArchived === undefined ? false : (sourcePreArchived as boolean),
        ...sourceProfileRestore,
        // namePinyin 以恢复后的 name 为准重新计算（buildProfileRestore 不覆盖派生字段）。
        namePinyin: toPinyinToneless(sourceProfileRestore.name ?? "") || null,
        customerCode: sourceCode,
      },
    });

    // 3) 恢复目标 Profile 业务字段与原 customerCode
    await tx.crmCustomerProfile.update({
      where: { id: targetProfileId },
      data: {
        ...targetProfileRestore,
        // namePinyin 以恢复后的 name 为准重新计算（buildProfileRestore 不覆盖派生字段）。
        namePinyin: toPinyinToneless(targetProfileRestore.name ?? "") || null,
        customerCode: targetCode,
      },
    });

    // ── Recompute representative snapshots (preserve restored owners; tag Profile-only) ──
    const restoredSourceProfile = await tx.crmCustomerProfile.findUnique({
      where: { id: sourceProfileId },
      select: { ownerUserId: true },
    });
    const restoredTargetProfile = await tx.crmCustomerProfile.findUnique({
      where: { id: targetProfileId },
      select: { ownerUserId: true },
    });
    if (restoredSourceProfile) {
      await syncProfileRepresentativeLinksFromOwner(
        sourceProfileId,
        restoredSourceProfile.ownerUserId,
        tx,
      );
      if (restoredSourceProfile.ownerUserId) {
        await syncManagingTagForProfileOwner(tx, {
          profileId: sourceProfileId,
          ownerUserId: restoredSourceProfile.ownerUserId,
          actingUserId: operatorId,
          note: "客户合并撤销：管理关系同步",
        });
      }
    }
    if (restoredTargetProfile) {
      await syncProfileRepresentativeLinksFromOwner(
        targetProfileId,
        restoredTargetProfile.ownerUserId,
        tx,
      );
      if (restoredTargetProfile.ownerUserId) {
        await syncManagingTagForProfileOwner(tx, {
          profileId: targetProfileId,
          ownerUserId: restoredTargetProfile.ownerUserId,
          actingUserId: operatorId,
          note: "客户合并撤销：管理关系同步",
        });
      }
    }

    // Mark log as reversed
    await tx.customerMergeLog.update({
      where: { id: logId },
      data: { reversedAt: new Date(), reversedById: operatorId, reverseReason: reason },
    });
  });

  // P2-4: Update associated MergeTask status
  try {
    const task = await prisma.customerMergeTask.findFirst({
      where: { mergeLogId: logId, status: "MERGED" },
      select: { id: true },
    });
    if (task) {
      await prisma.customerMergeTask.update({
        where: { id: task.id },
        data: { status: "PENDING", resolutionNote: `已回滚: ${reason}` },
      });
    }
  } catch {
    // non-critical
  }
}
