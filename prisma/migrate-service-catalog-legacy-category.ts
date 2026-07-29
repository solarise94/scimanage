/**
 * ServiceCatalog 旧类别一次性迁移。
 *
 * 背景：旧版种子把业务域（SEQUENCING / LIBRARY_PREP / SPATIAL / BIOINFORMATICS / LOGISTICS）
 * 错误写入了 category 字段。引入 domain 字段后，category 应回归 SERVICE/PRODUCT/MIXED/OTHER，
 * 业务域应写入 domain。但 seed-service-catalog.ts 对已存在 key 完全跳过，旧数据不会被自动修正。
 *
 * 本脚本做严格条件的一次性迁移：
 * - 只处理 category 命中 LEGACY_DOMAIN_AS_CATEGORY 白名单 且 domain IS NULL 的记录。
 * - category → SERVICE，domain ← 旧 category 值。
 * - 用户后续手工编辑过 domain 或 category 的记录（domain 非空或 category 不在白名单）一律不动。
 * - 幂等：再跑一次因 domain 已非空，全部跳过。
 *
 * 用法：npx tsx prisma/migrate-service-catalog-legacy-category.ts
 *
 * 注意：只在停服窗口或低峰期运行。本脚本只读 ServiceCatalog，不碰其他表。
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// 旧版被误写入 category 的业务域值。
const LEGACY_DOMAIN_AS_CATEGORY: Record<string, string> = {
  SEQUENCING: "SEQUENCING",
  LIBRARY_PREP: "LIBRARY_PREP",
  SPATIAL: "SPATIAL",
  BIOINFORMATICS: "BIOINFORMATICS",
  LOGISTICS: "LOGISTICS",
};

async function main() {
  console.log("Migrating legacy ServiceCatalog category → domain (conditional)...");

  const all = await prisma.serviceCatalog.findMany({
    select: { id: true, serviceKey: true, category: true, domain: true },
  });

  let migrated = 0;
  let skipped = 0;

  for (const item of all) {
    const legacyDomain = LEGACY_DOMAIN_AS_CATEGORY[item.category];
    // 仅当 category 命中旧值且 domain 未设置时迁移，避免覆盖任何人工编辑。
    if (!legacyDomain || item.domain != null) {
      skipped++;
      continue;
    }

    await prisma.serviceCatalog.update({
      where: { id: item.id },
      data: {
        category: "SERVICE",
        domain: legacyDomain,
      },
    });
    migrated++;
    console.log(`  ✓ ${item.serviceKey}: ${item.category} → SERVICE / ${legacyDomain}`);
  }

  console.log(`Done. Migrated ${migrated}, skipped ${skipped} (not legacy or already has domain). Total: ${all.length}.`);
}

main()
  .catch((e) => {
    console.error("Migration failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
