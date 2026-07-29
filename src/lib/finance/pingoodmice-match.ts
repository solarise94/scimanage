import { prisma } from "@/lib/prisma";
import type { MatchResult, MatchScanResult } from "./types";
import { getProfileOrgForSnapshot } from "@/lib/customer-organization";
import { resolveEffectiveRepresentativesForProfiles } from "@/lib/crm/customer-effective-representative";
import { findActiveProfile } from "@/lib/crm/ids";
import { normalizeText } from "@/lib/orders/match-scoring";
import {
  resolveImportRowMatch,
  type MatchCandidate,
  type MatchInput,
} from "@/lib/orders/source-order-match";
import type { MatchRowResolution } from "@/lib/orders/match-scoring";
import { type NameAliasType } from "@/lib/customers/customer-name-alias";

// ─── Data Loading ──────────────────────────────────────────────────────────────

// Profile-only：候选就是 Profile，profileId 即 CrmCustomerProfile.id。
async function loadMatchCustomers(): Promise<MatchCandidate[]> {
  const rows = await prisma.crmCustomerProfile.findMany({
    where: { deleted: false, archived: false, mergedIntoProfileId: null },
    select: {
      id: true,
      name: true,
      customerCode: true,
      wechat: true,
      phone: true,
      principal: true,
      miniProgramId: true,
      organization: true,
      address: true,
      organizationId: true,
      organizationSiteId: true,
      nameAliases: { where: { active: true }, select: { alias: true, aliasType: true } },
      org: {
        select: {
          canonicalName: true,
          normalizedName: true,
          aliases: { select: { alias: true } },
          sites: { where: { archived: false }, select: { id: true, siteName: true } },
        },
      },
    },
  });

  return rows
    .map((p) => {
      const sites = p.org?.sites || [];
      const siteNames = sites.map((s) => s.siteName).filter(Boolean) as string[];
      const customerSite = p.organizationSiteId
        ? sites.find((s) => s.id === p.organizationSiteId)?.siteName ?? null
        : null;
      return {
        profileId: p.id,
        name: p.name ?? null,
        customerCode: p.customerCode ?? null,
        wechat: p.wechat ?? null,
        phone: p.phone ?? null,
        principal: p.principal ?? null,
        miniProgramId: p.miniProgramId ?? null,
        organization: p.organization ?? null,
        address: p.address ?? null,
        orgCanonicalName: p.org?.canonicalName ?? null,
        orgNormalizedName: p.org?.normalizedName ?? null,
        orgAliases: p.org?.aliases?.map((a) => a.alias) || [],
        orgSiteNames: siteNames,
        customerSiteName: customerSite,
        nameAliases: (p.nameAliases || []).map((a) => ({ alias: a.alias, aliasType: a.aliasType as NameAliasType })),
      };
    });
}

async function loadMatchOrganizations() {
  return prisma.organization.findMany({
    select: {
      id: true,
      canonicalName: true,
      normalizedName: true,
      aliases: { select: { alias: true } },
    },
  });
}

type MatchOrganization = Awaited<ReturnType<typeof loadMatchOrganizations>>[number];

// ─── MatchContext ──────────────────────────────────────────────────────────────

export interface MatchContext {
  candidates: MatchCandidate[];
  organizations: MatchOrganization[];
}

export async function createMatchContext(): Promise<MatchContext> {
  const [candidates, organizations] = await Promise.all([
    loadMatchCustomers(),
    loadMatchOrganizations(),
  ]);
  return { candidates, organizations };
}

// ─── Org-from-address extraction (recall enhancement) ────────────────────────────

/**
 * 拼好鼠订单通常无显式单位，只有收货地址 + 店铺名。此函数尝试从地址/店铺名里抽取出
 * 机构名（先比对已有 Organization canonical/alias，再退回大学/研究所/医院/公司模式，最后用店铺名），
 * 抽取出的机构名再交给统一打分核心做"姓名+机构"匹配。
 */
function matchOrgAgainstOrderAddress(
  organizations: MatchOrganization[],
  orderAddress: string | null,
  storeName: string | null,
): string | null {
  const addrNorm = normalizeText(orderAddress);
  const storeNorm = normalizeText(storeName);

  // Priority 1: Organization canonicalName / alias 出现在地址中
  for (const org of organizations) {
    const names = [org.canonicalName, org.normalizedName, ...(org.aliases || []).map((a) => a.alias)]
      .filter(Boolean)
      .map((n) => normalizeText(n!));
    for (const name of names) {
      if (name && name.length >= 4 && addrNorm.includes(name)) {
        return org.canonicalName;
      }
    }
  }

  // Priority 2: 从地址里抽取 大学/研究所/医院/公司 模式
  const uniMatch = addrNorm.match(/([一-龥]+大学)/);
  if (uniMatch) return uniMatch[1];
  const instMatch = addrNorm.match(/([一-龥]+研究所)/);
  if (instMatch) return instMatch[1];
  const hospitalMatch = addrNorm.match(/([一-龥]+医院)/);
  if (hospitalMatch) return hospitalMatch[1];
  const companyMatch = addrNorm.match(/([一-龥]+公司)/);
  if (companyMatch) return companyMatch[1];

  // Priority 3 (weak): storeName as fallback
  if (storeNorm && storeNorm.length >= 4) return storeNorm;

  return null;
}

// ─── Core Matcher ──────────────────────────────────────────────────────────────

export type ResolvedCandidate = MatchRowResolution["candidates"][number];
/** 统一三态输出（§5.4）：{ status: AUTO_SUGGESTED|AMBIGUOUS|NO_MATCH, candidates, best, suggestedProfileId }。 */
export type MatchResolution = MatchRowResolution;

export function resolveMatch(
  ctx: MatchContext,
  params: {
    buyerPhone?: string | null;
    buyerWechat?: string | null;
    buyerName?: string | null;
    buyerAddress?: string | null;
    buyerOrgName?: string | null;
    buyerMiniProgramId?: string | null;
    buyerCustomerCode?: string | null;
  },
): MatchResolution {
  // 拼好鼠路径：单位多藏在地址里，先抽取机构名再交统一打分核心。
  const orderOrgFromAddress = params.buyerOrgName
    ? params.buyerOrgName
    : matchOrgAgainstOrderAddress(ctx.organizations, params.buyerAddress ?? null, null);

  const input: MatchInput = {
    buyerName: params.buyerName,
    buyerWechat: params.buyerWechat,
    buyerPhone: params.buyerPhone,
    buyerMiniProgramId: params.buyerMiniProgramId,
    buyerCustomerCode: params.buyerCustomerCode,
    buyerOrgName: orderOrgFromAddress,
    buyerAddress: params.buyerAddress,
  };

  return resolveImportRowMatch(input, ctx.candidates);
}

// ─── Adapter: scanPingoodmiceMatch ─────────────────────────────────────────────

export async function scanPingoodmiceMatch(params: {
  buyerPhone?: string | null;
  buyerWechat?: string | null;
  buyerName?: string | null;
  buyerAddress?: string | null;
  buyerOrgName?: string | null;
  buyerMiniProgramId?: string | null;
  buyerCustomerCode?: string | null;
}): Promise<{ profileId: string; matchMethod: string } | null> {
  const ctx = await createMatchContext();
  const result = resolveMatch(ctx, params);
  // 仅高置信（AUTO_SUGGESTED）自动绑定；AMBIGUOUS/NO_MATCH 不兜底。
  if (result.status !== "AUTO_SUGGESTED" || !result.best) return null;
  const profileId = result.suggestedProfileId ?? result.best.profileId;
  if (!profileId) return null;
  return {
    profileId,
    matchMethod: result.best.reason,
  };
}

// ─── Adapter: matchSourceOrders ────────────────────────────────────────────────

export async function matchSourceOrders(source?: string | null, orderIds?: string[]): Promise<MatchScanResult> {
  const baseWhere: Record<string, unknown> = {
    customerMatchStatus: "UNMATCHED",
    deleted: false,
    mergeSources: { none: {} },
    ...(orderIds?.length ? { id: { in: orderIds } } : {}),
  };
  if (source && source !== "ALL") {
    baseWhere.source = source;
  }

  const orders = await prisma.order.findMany({
    where: baseWhere,
    select: {
      id: true,
      externalOrderNo: true,
      buyerNameSnapshot: true,
      buyerPhoneSnapshot: true,
      buyerAddressSnapshot: true,
      buyerWechatSnapshot: true,
      buyerMiniProgramIdSnapshot: true,
      buyerOrgNameSnapshot: true,
      profileId: true,
    },
  });

  const ctx = await createMatchContext();

  let matched = 0;
  let conflicted = 0;
  let unmatched = 0;
  const details: MatchResult[] = [];

  for (const order of orders) {
    if (order.profileId) {
      await prisma.$transaction(async (tx) => {
        const ref = await findActiveProfile(order.profileId, tx);
        if (!ref) return;
        const effective = (
          await resolveEffectiveRepresentativesForProfiles([ref.profileId], tx)
        ).get(ref.profileId);
        await tx.order.update({
          where: { id: order.id },
          data: {
            profileId: ref.profileId,
            representativeId: effective?.representativeId ?? null,
            customerMatchStatus: "MANUAL_MATCHED",
            customerMatchScore: null,
            customerMatchReason: "existing_customer_binding",
          },
        });
      });
      matched++;
      details.push({
        orderId: order.id,
        externalOrderNo: order.externalOrderNo ?? "",
        status: "MANUAL",
        score: null,
        matchedProfileId: order.profileId,
        matchedCustomerName: null,
        reason: "existing_customer_binding",
      });
      continue;
    }

    const result = resolveMatch(ctx, {
      buyerPhone: order.buyerPhoneSnapshot,
      buyerWechat: order.buyerWechatSnapshot,
      buyerName: order.buyerNameSnapshot,
      buyerAddress: order.buyerAddressSnapshot,
      buyerOrgName: order.buyerOrgNameSnapshot,
      buyerMiniProgramId: order.buyerMiniProgramIdSnapshot,
    });

    // 三态 → DB 既有枚举：AUTO_SUGGESTED→AUTO_MATCHED 自动绑定；AMBIGUOUS→CONFLICT；NO_MATCH→UNMATCHED。
    if (result.status === "NO_MATCH") {
      await prisma.order.update({
        where: { id: order.id },
        data: {
          representativeId: null,
          customerMatchStatus: "UNMATCHED",
          customerMatchScore: null,
          customerMatchReason: null,
        },
      });
      unmatched++;
      details.push({
        orderId: order.id,
        externalOrderNo: order.externalOrderNo ?? "",
        status: "UNMATCHED",
        score: null,
        matchedProfileId: null,
        matchedCustomerName: null,
        reason: null,
      });
    } else if (result.status === "AUTO_SUGGESTED" && result.best && result.suggestedProfileId) {
      await prisma.$transaction(async (tx) => {
        const profileId = result.suggestedProfileId!;
        const effective = (
          await resolveEffectiveRepresentativesForProfiles([profileId], tx)
        ).get(profileId);
        const orgSnapshot =
          (await getProfileOrgForSnapshot(profileId, tx)) ??
          order.buyerOrgNameSnapshot;
        await tx.order.update({
          where: { id: order.id },
          data: {
            profileId,
            representativeId: effective?.representativeId ?? null,
            customerMatchStatus: "AUTO_MATCHED",
            customerMatchScore: result.best!.score,
            customerMatchReason: result.best!.reason,
            buyerOrgNameSnapshot: orgSnapshot,
          },
        });
      });
      matched++;
      details.push({
        orderId: order.id,
        externalOrderNo: order.externalOrderNo ?? "",
        status: "MATCHED",
        score: result.best.score,
        matchedProfileId: result.suggestedProfileId,
        matchedCustomerName: result.best.name,
        reason: result.best.reason,
      });
    } else {
      // AMBIGUOUS → CONFLICT
      await prisma.order.update({
        where: { id: order.id },
        data: {
          representativeId: null,
          customerMatchStatus: "CONFLICT",
          customerMatchScore: result.candidates[0]?.score ?? null,
          customerMatchReason: JSON.stringify(
            result.candidates.slice(0, 3).map((c) => ({
              id: c.profileId,
              name: c.name,
              score: c.score,
            }))
          ),
        },
      });
      conflicted++;
      details.push({
        orderId: order.id,
        externalOrderNo: order.externalOrderNo ?? "",
        status: "CONFLICT",
        score: result.candidates[0]?.score ?? null,
        matchedProfileId: null,
        matchedCustomerName: null,
        reason: "multiple_candidates",
        candidates: result.candidates.slice(0, 3).map((c) => ({
          profileId: c.profileId,
          name: c.name,
          score: c.score,
        })),
      });
    }
  }

  return { scanned: orders.length, matched, conflicted, unmatched, details };
}
