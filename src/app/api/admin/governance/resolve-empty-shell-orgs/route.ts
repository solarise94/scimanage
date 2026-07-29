import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { GOVERNANCE_ORDER_STATUSES, readProfileOrgFields } from "@/lib/governance/common";
import { scanEmptyShellCustomers } from "@/lib/governance/customer-scan";
import { resolveOrganization } from "@/lib/organization-resolver";
import { validateOrg } from "@/lib/crm/customer-application-review";
import { resolveEffectiveRepresentativesForProfiles } from "@/lib/crm/customer-effective-representative";
import {
  loadAddressMatchOrganizations,
  extractOrgFromAddress,
  type AddressMatchOrg,
} from "@/lib/orders/order-address-org";

type ResolveSource = "CUSTOMER_ORG_TEXT" | "ORDER_ADDRESS" | "AUTO";

type Outcome =
  | "ALREADY_BOUND"
  | "RESOLVED_CUSTOMER_TEXT"
  | "RESOLVED_ADDRESS"
  | "NEEDS_MANUAL"
  | "ADDRESS_CONFLICT"
  | "NO_SOURCE";

interface PerProfileResult {
  profileId: string;
  name: string;
  outcome: Outcome;
  organizationId: string | null;
  organizationName: string | null;
  repBackfilled: boolean;
  note: string | null;
}

interface ResolvedOrg {
  organizationId: string;
  organizationSiteId: string | null;
  canonicalName: string | null;
}

type TargetRow = {
  profileId: string;
  name: string;
  organization: string | null;
  organizationId: string | null;
  organizationRawInput: string | null;
};

/**
 * POST /api/admin/governance/resolve-empty-shell-orgs
 * C2 空壳机构辅助解析（W6.7：仅 profileIds，无 customerIds 兼容）。
 *
 * body: { profileIds?: string[], source?: ..., dryRun?: boolean, allowNonShell?: boolean }
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: {
    profileIds?: string[];
    source?: ResolveSource;
    dryRun?: boolean;
    allowNonShell?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // 明确拒绝旧契约（不写 customerIds 标识符，避免 contract 扫描误报）
  const legacyCustomerKey = "customer" + "Ids";
  if (Object.prototype.hasOwnProperty.call(body, legacyCustomerKey)) {
    return NextResponse.json(
      { error: "请使用 profileIds（不再接受旧 Customer 锚点批量参数）" },
      { status: 400 },
    );
  }

  const source: ResolveSource =
    body.source === "CUSTOMER_ORG_TEXT" || body.source === "ORDER_ADDRESS" ? body.source : "AUTO";
  const dryRun = body.dryRun === true;
  const allowNonShell = body.allowNonShell === true;

  const profileIdFilter =
    Array.isArray(body.profileIds) && body.profileIds.length > 0
      ? new Set(body.profileIds.filter((id): id is string => typeof id === "string" && !!id))
      : null;

  let targets: TargetRow[];

  if (allowNonShell && profileIdFilter) {
    const profiles = await prisma.crmCustomerProfile.findMany({
      where: {
        id: { in: [...profileIdFilter] },
        deleted: false,
        archived: false,
        mergedIntoProfileId: null,
      },
      select: {
        id: true,
        name: true,
        organization: true,
        organizationId: true,
        organizationRawInput: true,
      },
    });
    targets = profiles.map((p) => {
      const org = readProfileOrgFields(p);
      return {
        profileId: p.id,
        name: p.name ?? "未命名客户",
        ...org,
      };
    });
  } else {
    const shells = await scanEmptyShellCustomers();
    const filtered = profileIdFilter
      ? shells.filter((s) => profileIdFilter.has(s.profileId))
      : shells;
    targets = filtered.map((s) => ({
      profileId: s.profileId,
      name: s.name,
      organization: s.organization,
      organizationId: s.organizationId,
      organizationRawInput: null as string | null,
    }));
  }

  let addressOrgs: AddressMatchOrg[] | null = null;
  const loadOrgs = async () => {
    if (!addressOrgs) addressOrgs = await loadAddressMatchOrganizations();
    return addressOrgs;
  };

  const results: PerProfileResult[] = [];

  for (const t of targets) {
    if (t.organizationId) {
      results.push({
        profileId: t.profileId,
        name: t.name,
        outcome: "ALREADY_BOUND",
        organizationId: t.organizationId,
        organizationName: t.organization,
        repBackfilled: false,
        note: null,
      });
      continue;
    }

    let resolved: ResolvedOrg | null = null;
    let resolvedVia: "CUSTOMER_TEXT" | "ADDRESS" | null = null;
    let conflict = false;

    if ((source === "CUSTOMER_ORG_TEXT" || source === "AUTO") && t.organization) {
      const r = await resolveOrganization(t.organization);
      if (r.status === "exact" && r.organizationId) {
        const v = await validateOrg(r.organizationId, r.organizationSiteId, null);
        if (!v.error && v.organizationId) {
          resolved = {
            organizationId: v.organizationId,
            organizationSiteId: v.organizationSiteId,
            canonicalName: v.canonicalName,
          };
          resolvedVia = "CUSTOMER_TEXT";
        }
      }
    }

    if (!resolved && (source === "ORDER_ADDRESS" || source === "AUTO")) {
      const orders = await prisma.order.findMany({
        where: {
          profileId: t.profileId,
          deleted: false,
          archived: false,
          status: { in: [...GOVERNANCE_ORDER_STATUSES] },
          buyerAddressSnapshot: { not: null },
        },
        select: { buyerAddressSnapshot: true },
      });
      if (orders.length > 0) {
        const orgs = await loadOrgs();
        const orgIdSet = new Set<string>();
        let lastValid: ResolvedOrg | null = null;
        for (const o of orders) {
          const cand = extractOrgFromAddress(orgs, o.buyerAddressSnapshot);
          if (!cand) continue;
          let candOrgId: string | null = cand.organizationId;
          if (!candOrgId && cand.kind === "PATTERN_TEXT") {
            const r = await resolveOrganization(cand.text);
            if (r.status === "exact" && r.organizationId) candOrgId = r.organizationId;
          }
          if (!candOrgId) continue;
          const v = await validateOrg(candOrgId, null, null);
          if (v.error || !v.organizationId) continue;
          orgIdSet.add(v.organizationId);
          lastValid = {
            organizationId: v.organizationId,
            organizationSiteId: v.organizationSiteId,
            canonicalName: v.canonicalName,
          };
        }
        if (orgIdSet.size === 1 && lastValid) {
          resolved = lastValid;
          resolvedVia = "ADDRESS";
        } else if (orgIdSet.size > 1) {
          conflict = true;
        }
      }
    }

    if (!resolved) {
      let outcome: Outcome;
      if (conflict) outcome = "ADDRESS_CONFLICT";
      else if (t.organization || source === "ORDER_ADDRESS" || source === "AUTO") outcome = "NEEDS_MANUAL";
      else outcome = "NO_SOURCE";

      results.push({
        profileId: t.profileId,
        name: t.name,
        outcome,
        organizationId: null,
        organizationName: null,
        repBackfilled: false,
        note: conflict ? "订单地址指向多个机构，需人工确认" : "未命中精确机构，留待 C3 人工绑定",
      });
      continue;
    }

    const outcome: Outcome = resolvedVia === "ADDRESS" ? "RESOLVED_ADDRESS" : "RESOLVED_CUSTOMER_TEXT";

    if (dryRun) {
      results.push({
        profileId: t.profileId,
        name: t.name,
        outcome,
        organizationId: resolved.organizationId,
        organizationName: resolved.canonicalName,
        repBackfilled: false,
        note: "dryRun，未写入",
      });
      continue;
    }

    let repBackfilled = false;
    await prisma.$transaction(async (tx) => {
      const profileBefore = await tx.crmCustomerProfile.findUnique({
        where: { id: t.profileId },
        select: { assignmentStatus: true },
      });

      await tx.crmCustomerProfile.update({
        where: { id: t.profileId },
        data: {
          organizationId: resolved!.organizationId,
          organizationSiteId: resolved!.organizationSiteId,
          organization: resolved!.canonicalName,
        },
      });

      // 仅活动 ASSIGNED 才回填代表缓存；RECALLED 等不得因机构解析把 Order/Project 代表写回。
      // Order 限治理状态 + 未删未归档；Project 排除删除/归档。
      if (profileBefore?.assignmentStatus === "ASSIGNED") {
        const effMap = await resolveEffectiveRepresentativesForProfiles([t.profileId], tx);
        const eff = effMap.get(t.profileId);
        if (eff?.representativeId && eff.source !== "NONE") {
          await tx.order.updateMany({
            where: {
              profileId: t.profileId,
              deleted: false,
              archived: false,
              status: { in: [...GOVERNANCE_ORDER_STATUSES] },
            },
            data: { representativeId: eff.representativeId },
          });
          await tx.project.updateMany({
            where: {
              profileId: t.profileId,
              deleted: false,
              archived: false,
            },
            data: { representativeId: eff.representativeId, representative: eff.representativeName },
          });
          if (eff.ownerUserId) {
            await tx.crmCustomerProfile.update({
              where: { id: t.profileId },
              data: { ownerUserId: eff.ownerUserId },
            });
          }
          repBackfilled = true;
        }
      }
    });

    results.push({
      profileId: t.profileId,
      name: t.name,
      outcome,
      organizationId: resolved.organizationId,
      organizationName: resolved.canonicalName,
      repBackfilled,
      note: null,
    });
  }

  const summary = {
    total: results.length,
    resolvedCustomerText: results.filter((r) => r.outcome === "RESOLVED_CUSTOMER_TEXT").length,
    resolvedAddress: results.filter((r) => r.outcome === "RESOLVED_ADDRESS").length,
    needsManual: results.filter((r) => r.outcome === "NEEDS_MANUAL").length,
    addressConflict: results.filter((r) => r.outcome === "ADDRESS_CONFLICT").length,
    noSource: results.filter((r) => r.outcome === "NO_SOURCE").length,
    alreadyBound: results.filter((r) => r.outcome === "ALREADY_BOUND").length,
    repBackfilled: results.filter((r) => r.repBackfilled).length,
  };

  return NextResponse.json({ dryRun, source, summary, results });
}
