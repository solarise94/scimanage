/**
 * G1.1: Historical weak organization batch enrichment script.
 *
 * Scans all organizations with taxId=null && deleted=false,
 * calls the invoice API to fill in taxId + four elements,
 * deduplicates by taxId, and generates OrganizationReviewTask for misses.
 *
 * Usage:
 *   npx tsx scripts/enrich-organizations-taxid.ts [--dry-run]
 */

import { PrismaClient } from "@prisma/client";
import { rebindOrganizationReferences } from "../src/lib/organization-rebind";

const prisma = new PrismaClient();

// Inline invoice API lookup (avoids Next.js module resolution issues in raw tsx)
async function lookupByName(name: string): Promise<{
  unitName: string;
  unitTaxNo: string;
  unitAddress: string;
  unitPhone: string;
  bankName: string;
  bankNo: string;
} | null> {
  try {
    const fs = await import("fs");
    const path = await import("path");
    const crypto = await import("crypto");

    const confPath = path.join(process.cwd(), "invoice-api.conf");
    if (!fs.existsSync(confPath)) {
      console.warn("  ⚠️  invoice-api.conf not found — skipping API lookup");
      return null;
    }

    const raw = fs.readFileSync(confPath, "utf-8");
    const config: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      config[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }

    if (!config.SECRET_ID || !config.SECRET_KEY) {
      console.warn("  ⚠️  invoice-api.conf missing credentials");
      return null;
    }

    const host = config.HOST || "market.api.qcloud.com";
    const endpoint = config.ENDPOINT || "/v2/index.php";
    const now = Math.floor(Date.now() / 1000);
    const params: Record<string, string> = {
      Action: "GetInvoiceInfoByUnitName",
      Region: "ap-guangzhou",
      Timestamp: String(now),
      Nonce: String(Math.floor(Math.random() * 100000)),
      SecretId: config.SECRET_ID,
      Version: "2018-01-01",
      unitName: name,
    };

    const sortedKeys = Object.keys(params).sort();
    const urlParamStr = sortedKeys.map((k) => `${k}=${encodeURIComponent(params[k])}`).join("&");
    const signStr = `GET${host}${endpoint}?${urlParamStr}`;
    const signature = crypto.createHmac("sha1", config.SECRET_KEY).update(signStr).digest("base64");
    const finalUrl = `https://${host}${endpoint}?${urlParamStr}&Signature=${encodeURIComponent(signature)}`;

    const res = await fetch(finalUrl);
    if (!res.ok) {
      console.warn(`  ⚠️  API returned ${res.status}`);
      return null;
    }

    const json = (await res.json()) as { code?: number; data?: { list?: { unitName: string; unitTaxNo: string; unitAddress: string; unitPhone: string; bankName: string; bankNo: string }[] } };
    if (json.code && json.code !== 0) {
      console.warn(`  ⚠️  API error ${json.code}`);
      return null;
    }

    const list = json.data?.list;
    if (!list || list.length === 0) return null;
    return list[0]; // highest frequency
  } catch (err) {
    console.warn(`  ⚠️  API call failed: ${err}`);
    return null;
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const orgs = await prisma.organization.findMany({
    where: { taxId: null, deleted: false },
    orderBy: { createdAt: "asc" },
  });

  console.log(`\n🔍 Found ${orgs.length} organizations without taxId\n`);

  let enriched = 0;
  let pending = 0;
  const skipped = 0;

  for (const org of orgs) {
    console.log(`  📋 ${org.canonicalName} (${org.orgCode})`);

    const result = await lookupByName(org.canonicalName);
    if (!result || !result.unitTaxNo) {
      if (!dryRun) {
        // Generate OrganizationReviewTask for admin
        await prisma.organizationReviewTask.create({
          data: {
            rawInput: org.canonicalName,
            normalizedInput: org.normalizedName,
            confidence: 0,
            status: "PENDING",
            sourceType: "LEGACY_ORG_ENRICH",
            sourceId: org.id,
          },
        });
      }
      console.log(`    → API 未命中，生成 PENDING 审核任务`);
      pending++;
      continue;
    }

    // Check for existing org with same taxId
    const existing = await prisma.organization.findFirst({
      where: { taxId: result.unitTaxNo, id: { not: org.id }, deleted: false },
      select: { id: true, canonicalName: true },
    });

    if (dryRun) {
      console.log(`    → 命中: ${result.unitName} (${result.unitTaxNo})${existing ? ` — 将归并到 ${existing.canonicalName}` : ""}`);
      enriched++;
      continue;
    }

    if (existing) {
      // Merge into existing subject — delegate to shared rebind function so the
      // reference migration stays in lockstep with /api/organizations/[id]/merge.
      // (rebinds Customer, FinanceReceipt, CrmCustomerApplication,
      //  RepresentativeOrganization + text backfill; does NOT touch invoice buyer)
      console.log(`    → 归并到已有主体: ${existing.canonicalName}`);

      await prisma.$transaction(async (tx) => {
        await rebindOrganizationReferences(
          tx,
          org.id,
          existing.id,
          existing.canonicalName,
          org.canonicalName,
        );

        // Add source's canonical name as a FORMER_NAME alias on target so
        // historical lookups by the old name still resolve.
        await tx.organizationAlias.create({
          data: {
            organizationId: existing.id,
            alias: org.canonicalName,
            normalizedAlias: org.normalizedName,
            aliasType: "FORMER_NAME",
          },
        }).catch(() => {
          // unique(normalizedAlias) collision — alias already present, ignore
        });

        // Archive source's sites so none remain pointing at the soft-deleted org.
        await tx.organizationSite.updateMany({
          where: { organizationId: org.id },
          data: { archived: true },
        });

        // Soft-delete the merged org, persisting the verified taxId + four
        // elements on the now-archived record for audit.
        await tx.organization.update({
          where: { id: org.id },
          data: {
            deleted: true,
            taxId: result.unitTaxNo,
            isInvoiceSubject: true,
            taxIdVerifiedAt: new Date(),
            taxIdVerifySource: "API",
            orgDataSource: "GOVERNANCE",
            invoiceAddress: result.unitAddress || null,
            invoicePhone: result.unitPhone || null,
            invoiceBankName: result.bankName || null,
            invoiceBankAccount: result.bankNo || null,
          },
        });
      });
    } else {
      // Fill in taxId + four elements
      await prisma.organization.update({
        where: { id: org.id },
        data: {
          canonicalName: result.unitName,
          taxId: result.unitTaxNo,
          invoiceAddress: result.unitAddress || null,
          invoicePhone: result.unitPhone || null,
          invoiceBankName: result.bankName || null,
          invoiceBankAccount: result.bankNo || null,
          isInvoiceSubject: true,
          taxIdVerifiedAt: new Date(),
          taxIdVerifySource: "API",
          orgDataSource: "GOVERNANCE",
        },
      });
      console.log(`    → 已补全: ${result.unitName} (${result.unitTaxNo})`);
    }
    enriched++;
  }

  if (dryRun) {
    console.log(`\n  ℹ️  DRY RUN — 未实际修改数据库\n`);
  }

  console.log(`\n✅ 完成: ${enriched} 补全, ${pending} 待审核, ${skipped} 跳过\n`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
