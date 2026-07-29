/**
 * 为合同台账 MATCH_ONLY 首次导入预置 Profile-only fixture。
 * 机构解析与 commitContractLedger 对齐；不创建 Customer。
 *
 * 去重键必须是解析后的 (client, organizationId)，不能用 organizationRaw：
 * 同一人在「浙江省农科院 / 浙江省农业科学院」等别名下会解析到同一 org，
 * 若各建一条 Profile，MATCH 会因双 85 分 AMBIGUOUS 拒收。
 */
import type { ContractLedgerRow } from "../../src/lib/orders/contract-ledger-parser";

type SeedDeps = {
  resolveOrCreateOrganizationWithSiteForImport: typeof import("../../src/lib/orders/import-masterdata").resolveOrCreateOrganizationWithSiteForImport;
  createCrmCustomerProfile: typeof import("../../src/lib/crm/create-profile").createCrmCustomerProfile;
  prisma: typeof import("../../src/lib/prisma").prisma;
};

type SeedBucket = {
  client: string;
  organizationId: string;
  organizationSiteId: string | null;
  organizationLabel: string | null;
  siteIds: Set<string>;
};

function profileKey(client: string, organizationId: string): string {
  return `${client}\u0000${organizationId}`;
}

/**
 * 对解析行按 (client, organizationId) 去重后建 Profile-only。
 * site：若该键下所有行同一 site 则写入；否则 siteId 置空（避免多 site 同名造成 AMBIGUOUS）。
 */
export async function seedContractLedgerMatchProfiles(
  rows: ContractLedgerRow[],
  ownerUserId: string,
  deps: SeedDeps,
): Promise<{ seeded: number; skippedNoClient: number; skippedNoOrg: number }> {
  const { resolveOrCreateOrganizationWithSiteForImport, createCrmCustomerProfile, prisma } = deps;
  const buckets = new Map<string, SeedBucket>();
  let skippedNoClient = 0;
  let skippedNoOrg = 0;

  for (const row of rows) {
    const client = row.client?.trim();
    if (!client) {
      skippedNoClient++;
      continue;
    }

    const orgRes = row.orgMapping
      ? await resolveOrCreateOrganizationWithSiteForImport(
          row.orgMapping.canonicalName,
          row.orgMapping.siteName,
          row.orgMapping.siteType,
          "CREATE_IF_MISSING",
          prisma,
          row.organizationRaw,
        )
      : await resolveOrCreateOrganizationWithSiteForImport(
          row.organizationRaw,
          null,
          null,
          "CREATE_IF_MISSING",
          prisma,
          row.organizationRaw,
        );

    if (!orgRes.organizationId) {
      skippedNoOrg++;
      continue;
    }

    const key = profileKey(client, orgRes.organizationId);
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        client,
        organizationId: orgRes.organizationId,
        organizationSiteId: orgRes.organizationSiteId,
        organizationLabel:
          row.organizationRaw?.trim() || orgRes.canonicalName || null,
        siteIds: new Set(
          orgRes.organizationSiteId ? [orgRes.organizationSiteId] : [],
        ),
      });
      continue;
    }

    if (orgRes.organizationSiteId) {
      existing.siteIds.add(orgRes.organizationSiteId);
    }
    // 保留更“具体”的原始单位名（更长）便于 org 变体打分
    const label = row.organizationRaw?.trim();
    if (label && (!existing.organizationLabel || label.length > existing.organizationLabel.length)) {
      existing.organizationLabel = label;
    }
  }

  let seeded = 0;
  for (const bucket of buckets.values()) {
    const siteId =
      bucket.siteIds.size === 1 ? [...bucket.siteIds][0]! : null;

    await createCrmCustomerProfile(
      {
        name: bucket.client,
        organizationId: bucket.organizationId,
        organizationSiteId: siteId,
        organization: bucket.organizationLabel,
        ownerUserId,
        assignmentStatus: "ASSIGNED",
        stage: "ACTIVE",
        sourceHint: "ORDER_IMPORT",
      },
      prisma,
    );
    seeded++;
  }

  return { seeded, skippedNoClient, skippedNoOrg };
}
