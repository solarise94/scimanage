/**
 * Fix imported orders whose buyerOrgNameSnapshot was set to the platform
 * store name (e.g. "总店") instead of the real organization (W6.6 Profile-only).
 *
 * Filters orders where OrderSourceRecord.rawJson contains a storeName
 * and the current buyerOrgNameSnapshot equals that storeName.
 * Backfill from Profile.organization / Profile.org.canonicalName（不再读 Customer 旧列）。
 *
 * Usage:
 *   npx tsx scripts/fix-imported-order-org-snapshot.ts              # dry-run
 *   npx tsx scripts/fix-imported-order-org-snapshot.ts --apply
 *   npx tsx scripts/fix-imported-order-org-snapshot.ts --json
 */

import { prisma } from "../src/lib/prisma";

interface FixReport {
  dryRun: boolean;
  scanned: number;
  matched: number;
  hasProfile: number;
  hasOrg: number;
  backfilled: number;
  skipped: number;
  unchanged: number;
  errors: string[];
  samples: Array<{
    orderId: string;
    orderNo: string;
    profileId: string | null;
    profileName: string | null;
    oldSnapshot: string | null;
    newSnapshot: string | null;
  }>;
}

function getProfileOrgName(profile: {
  organization?: string | null;
  org?: { canonicalName: string } | null;
} | null | undefined): string | null {
  if (!profile) return null;
  return profile.org?.canonicalName?.trim() || profile.organization?.trim() || null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const json = process.argv.includes("--json");

  const report: FixReport = {
    dryRun: !apply,
    scanned: 0,
    matched: 0,
    hasProfile: 0,
    hasOrg: 0,
    backfilled: 0,
    skipped: 0,
    unchanged: 0,
    errors: [],
    samples: [],
  };

  if (!json) {
    console.log(`模式: ${apply ? "APPLY (写入修改)" : "DRY-RUN (只读预览)"}`);
    console.log("");
  }

  const orders = await prisma.order.findMany({
    where: {
      deleted: false,
      source: { notIn: ["MANUAL", "CONTRACT_LEDGER"] },
      sourceRecords: { some: {} },
    },
    select: {
      id: true,
      orderNo: true,
      profileId: true,
      buyerOrgNameSnapshot: true,
      sourceRecords: {
        select: { rawJson: true },
        take: 1,
      },
      profile: {
        select: {
          id: true,
          name: true,
          organization: true,
          org: { select: { canonicalName: true } },
        },
      },
    },
  });

  report.scanned = orders.length;

  for (const order of orders) {
    try {
      const rawJson = order.sourceRecords[0]?.rawJson;
      if (!rawJson) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        continue;
      }

      const storeName = typeof parsed.storeName === "string" ? parsed.storeName.trim() : null;
      if (!storeName) continue;

      const currentSnapshot = order.buyerOrgNameSnapshot?.trim() ?? null;
      if (currentSnapshot !== storeName) {
        report.unchanged++;
        continue;
      }

      report.matched++;

      if (!order.profileId || !order.profile) {
        report.skipped++;
        continue;
      }
      report.hasProfile++;

      const realOrg = getProfileOrgName(order.profile);
      if (!realOrg || realOrg === storeName) {
        report.skipped++;
        continue;
      }
      report.hasOrg++;

      if (report.samples.length < 20) {
        report.samples.push({
          orderId: order.id,
          orderNo: order.orderNo,
          profileId: order.profileId,
          profileName: order.profile.name,
          oldSnapshot: currentSnapshot,
          newSnapshot: realOrg,
        });
      }

      if (apply) {
        await prisma.order.update({
          where: { id: order.id },
          data: { buyerOrgNameSnapshot: realOrg },
        });
      }
      report.backfilled++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "未知错误";
      report.errors.push(`订单 ${order.orderNo}: ${msg}`);
    }
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`扫描订单: ${report.scanned}`);
    console.log(`快照等于店铺名: ${report.matched}`);
    console.log(`  其中已绑定 Profile: ${report.hasProfile}`);
    console.log(`  其中 Profile 有真实单位: ${report.hasOrg}`);
    console.log(`已回填: ${report.backfilled}`);
    console.log(`跳过（无 Profile/无单位）: ${report.skipped}`);
    console.log(`快照已正确: ${report.unchanged}`);
    if (report.errors.length > 0) {
      console.log(`\n错误 (${report.errors.length}):`);
      report.errors.forEach((e) => console.log(`  - ${e}`));
    }
    if (report.samples.length > 0) {
      console.log(`\n样例 (前 ${report.samples.length} 条):`);
      for (const s of report.samples) {
        console.log(
          `  ${s.orderNo} | Profile: ${s.profileName ?? "无"} | "${s.oldSnapshot}" → "${s.newSnapshot}"`,
        );
      }
    }
    if (!apply && report.backfilled > 0) {
      console.log(`\n提示: 添加 --apply 参数执行实际修改`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
