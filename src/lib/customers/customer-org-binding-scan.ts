import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveOrganization } from "@/lib/organization-resolver";
import { getProfileAddressOrgHints } from "@/lib/customers/customer-address-org-hints";

export interface ScanResult {
  scanned: number;
  created: number;
  updated: number;
  skipped: number;
  reopened: number;
  byConfidence: { EXACT: number; CANDIDATE: number; UNMATCHED: number };
}

type Confidence = "EXACT" | "CANDIDATE" | "UNMATCHED";

interface Suggested {
  organizationId: string | null;
  siteId: string | null;
  confidence: Confidence;
  reasons: string[];
}

/**
 * 扫描无机构 Profile（organizationId=null），按 profileId upsert CustomerOrgBindingTask。
 *
 * Phase E contract：
 *  - 主体 = 活动 CrmCustomerProfile（Profile-only）
 *  - 幂等键 = profileId
 * 地址线索按 profileId 直查 Profile。
 */
export async function scanUnboundCustomers(
  scannedByUserId: string,
  force = false,
): Promise<ScanResult> {
  const profiles = await prisma.crmCustomerProfile.findMany({
    where: {
      deleted: false,
      archived: false,
      mergedIntoProfileId: null,
      organizationId: null,
    },
    select: {
      id: true,
      name: true,
      organization: true,
      organizationRawInput: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const addressOrgHintsMap = await getProfileAddressOrgHints(
    profiles.map((p) => p.id),
    1,
  );

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let reopened = 0;
  const byConfidence = { EXACT: 0, CANDIDATE: 0, UNMATCHED: 0 };

  for (const p of profiles) {
    const orgText = p.organization;
    const orgRawInput = p.organizationRawInput;
    const rawText = (orgRawInput || orgText || "").trim();
    let suggested: Suggested = {
      organizationId: null,
      siteId: null,
      confidence: "UNMATCHED",
      reasons: [],
    };

    if (rawText) {
      const resolved = await resolveOrganization(rawText);
      if (resolved.status === "exact" && resolved.organizationId) {
        suggested = {
          organizationId: resolved.organizationId,
          siteId: resolved.organizationSiteId,
          confidence: "EXACT",
          reasons: ["文本精确匹配"],
        };
      } else if (resolved.status === "candidate" && resolved.bestSuggestion?.organizationId) {
        suggested = {
          organizationId: resolved.bestSuggestion.organizationId,
          siteId: resolved.bestSuggestion.organizationSiteId,
          confidence: "CANDIDATE",
          reasons: ["文本模糊匹配候选"],
        };
      }
    } else {
      const addressHint = addressOrgHintsMap.get(p.id)?.[0];
      if (addressHint?.organizationId) {
        suggested = {
          organizationId: addressHint.organizationId,
          siteId: null,
          confidence: "CANDIDATE",
          reasons: [`通讯地址命中机构：${addressHint.orgText}`],
        };
      } else if (addressHint?.orgText) {
        const resolved = await resolveOrganization(addressHint.orgText);
        if (resolved.status === "exact" && resolved.organizationId) {
          suggested = {
            organizationId: resolved.organizationId,
            siteId: resolved.organizationSiteId,
            confidence: "CANDIDATE",
            reasons: [`通讯地址推断机构：${addressHint.orgText}`],
          };
        } else if (resolved.status === "candidate" && resolved.bestSuggestion?.organizationId) {
          suggested = {
            organizationId: resolved.bestSuggestion.organizationId,
            siteId: resolved.bestSuggestion.organizationSiteId,
            confidence: "CANDIDATE",
            reasons: [`通讯地址推断候选：${addressHint.orgText}`],
          };
        }
      }
    }
    byConfidence[suggested.confidence]++;

    const existing = await prisma.customerOrgBindingTask.findUnique({
      where: { profileId: p.id },
    });

    if (existing) {
      if (existing.status === "RESOLVED") {
        skipped++;
        continue;
      }
      if (existing.status === "PROCESSING") {
        skipped++;
        continue;
      }
      if (existing.status === "IGNORED" && !force) {
        skipped++;
        continue;
      }
    }

    const isReopenFromIgnored = !!(existing && existing.status === "IGNORED" && force);

    const baseData = {
      profileId: p.id,
      customerName: p.name ?? "未命名客户",
      organizationText: orgText ?? null,
      organizationRawInput: orgRawInput ?? null,
      suggestedOrganizationId: suggested.organizationId,
      suggestedSiteId: suggested.siteId,
      matchConfidence: suggested.confidence,
      matchReasonsJson: JSON.stringify(suggested.reasons),
      scannedById: scannedByUserId,
      scannedAt: new Date(),
      status: "PENDING" as const,
    };

    if (existing) {
      if (isReopenFromIgnored) {
        const r = await prisma.customerOrgBindingTask.updateMany({
          where: { id: existing.id, status: "IGNORED" },
          data: {
            ...baseData,
            resolvedOrganizationId: null,
            resolvedSiteId: null,
            resolvedById: null,
            resolvedAt: null,
          },
        });
        if (r.count === 1) reopened++;
        else skipped++;
      } else {
        const r = await prisma.customerOrgBindingTask.updateMany({
          where: { id: existing.id, status: "PENDING" },
          data: baseData,
        });
        if (r.count === 1) updated++;
        else skipped++;
      }
    } else {
      try {
        await prisma.customerOrgBindingTask.create({ data: baseData });
        created++;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          skipped++;
        } else {
          throw e;
        }
      }
    }
  }

  return {
    scanned: profiles.length,
    created,
    updated,
    skipped,
    reopened,
    byConfidence,
  };
}
