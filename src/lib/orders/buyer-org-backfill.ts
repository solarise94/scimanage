/**
 * Order.buyerOrganizationId 回填核心逻辑（profile 主权）。
 *
 * 机构字段主权在 CrmCustomerProfile：只读 Order.profile.organizationId（Profile-only，
 * 不经 Customer 锚点反查）。
 *
 * 共享给 backfill 脚本（scripts/backfill-order-buyer-organization.ts）和
 * 治理接口（/api/admin/governance/backfill-order-buyer-org），保证两条路径逻辑一致。
 *
 * 规则：
 *   - 仅处理 Order.buyerOrganizationId 为空、未删除、有 profileId 的订单。
 *   - org 来源 = order.profile.organizationId（profile 主权）。
 *   - 机构必须存在、未删除、未归档，否则进 invalidProfileOrg，不写入。
 *   - 有发票/回款等财务关联的订单单独列出（hasFinance），不自动写入（需人工确认）。
 *   - 默认遇 invalidProfileOrg 禁写全部（保守）；allowPartial=true 才允许只写安全 plans。
 */
import type { PrismaClient } from "@prisma/client";

export interface BackfillPlan {
  orderId: string;
  orderNo: string;
  profileId: string;
  buyerOrganizationId: string;
}

export interface BackfillAnomaly {
  orderId: string;
  orderNo: string;
  profileId: string | null;
  reason: string;
}

export interface BackfillScanResult {
  scanned: number;
  plans: BackfillPlan[];
  skippedNoProfileOrg: BackfillAnomaly[];
  invalidProfileOrg: BackfillAnomaly[];
  hasFinance: BackfillAnomaly[];
}

export interface BackfillExecuteResult extends BackfillScanResult {
  updated: number;
  dryRun: boolean;
}

/**
 * 扫描可回填的订单（不写入）。
 * db 可以是单例 prisma，也可以是脚本里按 DATABASE_URL 构造的独立 client。
 */
export async function scanBackfillCandidates(
  db: PrismaClient,
): Promise<BackfillScanResult> {
  const orders = await db.order.findMany({
    where: { deleted: false, buyerOrganizationId: null, profileId: { not: null } },
    select: {
      id: true,
      orderNo: true,
      profileId: true,
      profile: {
        select: {
          id: true,
          deleted: true,
          mergedIntoProfileId: true,
          organizationId: true,
          org: { select: { id: true, canonicalName: true, deleted: true, archived: true } },
        },
      },
      invoiceCoverage: { select: { id: true } },
      _count: { select: { invoiceRequests: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const result: BackfillScanResult = {
    scanned: orders.length,
    plans: [],
    skippedNoProfileOrg: [],
    invalidProfileOrg: [],
    hasFinance: [],
  };

  for (const o of orders) {
    const profileId = o.profileId!;
    const orderNo = o.orderNo;
    const baseAnomaly = { orderId: o.id, orderNo, profileId };

    if (!o.profile) {
      result.skippedNoProfileOrg.push({ ...baseAnomaly, reason: "profile_not_found" });
      continue;
    }
    if (o.profile.deleted) {
      result.skippedNoProfileOrg.push({ ...baseAnomaly, reason: "profile_deleted" });
      continue;
    }
    if (o.profile.mergedIntoProfileId) {
      result.skippedNoProfileOrg.push({ ...baseAnomaly, reason: "profile_merged" });
      continue;
    }

    const profileOrgId = o.profile.organizationId ?? null;
    if (!profileOrgId) {
      result.skippedNoProfileOrg.push({ ...baseAnomaly, reason: "profile_no_organization" });
      continue;
    }

    // 校验目标机构存在且未删除/归档
    const org = o.profile.org;
    if (!org || org.deleted || org.archived) {
      result.invalidProfileOrg.push({
        ...baseAnomaly,
        reason: `organization_invalid:${profileOrgId}${org ? `(${org.deleted ? "deleted" : "archived"})` : "(missing)"}`,
      });
      continue;
    }

    // 财务关联门禁：有发票 coverage 或 invoiceRequests 的订单单独列出，不自动写
    const hasInvoiceCoverage = o.invoiceCoverage.length > 0;
    const hasInvoiceRequests = o._count.invoiceRequests > 0;
    if (hasInvoiceCoverage || hasInvoiceRequests) {
      result.hasFinance.push({
        ...baseAnomaly,
        reason: `has_finance:${[hasInvoiceCoverage ? "coverage" : "", hasInvoiceRequests ? "invoices" : ""].filter(Boolean).join("+")}`,
      });
      continue;
    }

    result.plans.push({ orderId: o.id, orderNo, profileId, buyerOrganizationId: profileOrgId });
  }

  return result;
}

/**
 * 执行回填。dryRun=true 只扫描不写入；dryRun=false 写入 plans。
 * allowPartial=false（默认）：遇 invalidProfileOrg 或 hasFinance 时禁写全部；
 * allowPartial=true：只写 plans，跳过异常条目（已在 scan 阶段排除，这里只做门禁判断）。
 */
export async function executeBackfill(
  db: PrismaClient,
  opts: { dryRun?: boolean; allowPartial?: boolean } = {},
): Promise<BackfillExecuteResult> {
  const { dryRun = true, allowPartial = false } = opts;
  const scan = await scanBackfillCandidates(db);

  // 写入门禁：非 partial 模式下，任何异常都阻止写入
  if (!dryRun && !allowPartial) {
    const anomalyCount = scan.invalidProfileOrg.length + scan.hasFinance.length;
    if (anomalyCount > 0) {
      return { ...scan, updated: 0, dryRun };
    }
  }

  if (dryRun) {
    return { ...scan, updated: 0, dryRun };
  }

  let updated = 0;
  for (const p of scan.plans) {
    await db.order.update({
      where: { id: p.orderId },
      data: { buyerOrganizationId: p.buyerOrganizationId },
    });
    updated++;
  }

  return { ...scan, updated, dryRun };
}
