import { prisma } from "@/lib/prisma";
import type { OrgTextDriftScanRecord } from "./org-text-mismatch-scan";
import type { Prisma } from "@prisma/client";

type DbLike = typeof prisma | Prisma.TransactionClient;

export type OrgTextDriftUpsertResult = {
  created: number;
  updated: number;
  resolved: number;
};

/**
 * 根据扫描结果 upsert CustomerOrgTextDriftTask。
 *
 * 规则：
 * - 按 profileId 唯一；同一 Profile 同时只保留一条当前漂移任务。
 * - 已有 PENDING 任务：更新快照字段和 mismatchKind。
 * - 已有 RESOLVED/IGNORED 任务：若当前仍漂移，不重开，仅记录重发现到 reasonJson。
 * - 源客户已删除/合并/Profile 已不存在：将对应 PENDING 任务自动置为 RESOLVED。
 */
export async function upsertOrgTextDriftTasks(
  records: OrgTextDriftScanRecord[],
  scannedById: string | null,
  db: DbLike = prisma,
): Promise<OrgTextDriftUpsertResult> {
  const result: OrgTextDriftUpsertResult = { created: 0, updated: 0, resolved: 0 };
  if (records.length === 0) return result;

  const profileIds = records.map((r) => r.profileId);

  const existingTasks = await db.customerOrgTextDriftTask.findMany({
    where: { profileId: { in: profileIds } },
  });
  const existingByProfileId = new Map(existingTasks.map((t) => [t.profileId, t]));

  const now = new Date();

  for (const r of records) {
    const existing = existingByProfileId.get(r.profileId);
    const reason = {
      scannedAt: now.toISOString(),
      mismatchKind: r.mismatchKind,
      organizationTextSnapshot: r.orgText,
      boundOrgNameSnapshot: r.boundOrgName,
    };

    if (existing) {
      if (existing.status === "PENDING") {
        await db.customerOrgTextDriftTask.update({
          where: { id: existing.id },
          data: {
            customerNameSnapshot: r.customerName,
            customerCodeSnapshot: r.customerCodeSnapshot,
            organizationIdSnapshot: r.organizationId,
            organizationSiteIdSnapshot: r.organizationSiteId,
            organizationTextSnapshot: r.orgText,
            organizationRawInputSnapshot: r.organizationRawInput,
            boundOrgNameSnapshot: r.boundOrgName,
            boundOrgCodeSnapshot: r.boundOrgCode,
            mismatchKind: r.mismatchKind,
            reasonJson: JSON.stringify(reason),
            scannedById,
            scannedAt: now,
          },
        });
        result.updated++;
      } else {
        // RESOLVED/IGNORED：不重开，追加重发现记录
        const reasons = parseReasonJson(existing.reasonJson);
        reasons.push(reason);
        await db.customerOrgTextDriftTask.update({
          where: { id: existing.id },
          data: {
            reasonJson: JSON.stringify(reasons.slice(-5)), // 保留最近 5 次
            scannedById,
            scannedAt: now,
          },
        });
      }
      continue;
    }

    // Phase E contract：漂移任务 Profile-only，按 profileId 直接新建（W7.3 过渡态结束）。
    await db.customerOrgTextDriftTask.create({
      data: {
        profileId: r.profileId,
        customerNameSnapshot: r.customerName,
        customerCodeSnapshot: r.customerCodeSnapshot,
        organizationIdSnapshot: r.organizationId,
        organizationSiteIdSnapshot: r.organizationSiteId,
        organizationTextSnapshot: r.orgText,
        organizationRawInputSnapshot: r.organizationRawInput,
        boundOrgNameSnapshot: r.boundOrgName,
        boundOrgCodeSnapshot: r.boundOrgCode,
        mismatchKind: r.mismatchKind,
        reasonJson: JSON.stringify(reason),
        scannedById,
        scannedAt: now,
      },
    });
    result.created++;
  }

  // 自动收敛：PENDING 任务对应的 Profile 已不存在、删除或已合并 → RESOLVED
  const pendingTasks = await db.customerOrgTextDriftTask.findMany({
    where: { status: "PENDING" },
    select: {
      id: true,
      profileId: true,
      profile: {
        select: {
          id: true,
          deleted: true,
          mergedIntoProfileId: true,
        },
      },
    },
  });

  for (const t of pendingTasks) {
    if (!t.profile || t.profile.deleted || t.profile.mergedIntoProfileId !== null) {
      await db.customerOrgTextDriftTask.update({
        where: { id: t.id },
        data: {
          status: "RESOLVED",
          resolvedAction: "ALREADY_FIXED",
          resolutionNote: "source no longer active",
          resolvedAt: now,
        },
      });
      result.resolved++;
    }
  }

  return result;
}

function parseReasonJson(json: string | null): unknown[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}
