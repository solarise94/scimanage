/**
 * ServiceCatalog → Product/SKU 迁移脚本（Phase 0 第 4 步）。
 *
 * 对应设计文档 §11 Phase 0："将现有 ServiceCatalog 一项迁为一个 Product + 默认 SKU"。
 *
 * 规则：
 *  - 每个 ServiceCatalog 一项 → 一个 Product（kind 由 category 映射）+ 一个默认 SKU；
 *  - serviceKey 作为 ProductAlias（source=LEGACY_SERVICE_KEY）保留，便于历史匹配；
 *  - aliasesJson 解析后也写入 ProductAlias；
 *  - 默认 SKU 状态 = ServiceCatalog.active ? ACTIVE : DRAFT；
 *  - 幂等：已迁移（有 LEGACY_SERVICE_KEY alias）的跳过；
 *  - dry-run 模式默认，--apply 才真正写入。
 *
 * 用法：
 *   npx tsx scripts/migrate-service-catalog-to-products.ts --dry-run
 *   npx tsx scripts/migrate-service-catalog-to-products.ts --apply
 */
import { prisma } from "../src/lib/prisma";
import { nextProductCode, nextSkuCode } from "../src/lib/business-sequence";
import {
  PRODUCT_KIND,
  PRODUCT_STATUS,
  PRODUCT_ALIAS_SOURCE,
  PRODUCT_DOMAIN as SC_DOMAIN_MAP,
  normalizeAlias,
} from "../src/lib/products/constants";

const CATEGORY_TO_KIND: Record<string, string> = {
  SERVICE: PRODUCT_KIND.SERVICE,
  PRODUCT: PRODUCT_KIND.PHYSICAL,
  MIXED: PRODUCT_KIND.COMPOSITE,
  OTHER: PRODUCT_KIND.OTHER,
};

function parseAliasesJson(aliasesJson: string | null): string[] {
  if (!aliasesJson) return [];
  try {
    const parsed = JSON.parse(aliasesJson);
    if (Array.isArray(parsed)) {
      return parsed.filter((a): a is string => typeof a === "string" && a.trim().length > 0);
    }
  } catch {
    // 非 JSON，按分隔符拆
    return aliasesJson
      .split(/[,，;；\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

async function main() {
  const apply = process.argv.includes("--apply");
  const dryRun = !apply;
  console.log(`=== ServiceCatalog → Product/SKU 迁移（${dryRun ? "DRY-RUN" : "APPLY"}）===\n`);

  const services = await prisma.serviceCatalog.findMany({ orderBy: { serviceKey: "asc" } });
  console.log(`ServiceCatalog 共 ${services.length} 项`);

  // 已迁移的 serviceKey 集合（通过 LEGACY_SERVICE_KEY alias 查）
  const migratedAliases = await prisma.productAlias.findMany({
    where: { source: PRODUCT_ALIAS_SOURCE.LEGACY_SERVICE_KEY },
    select: { normalizedAlias: true },
  });
  const migratedKeys = new Set(migratedAliases.map((a) => a.normalizedAlias));

  const toMigrate = services.filter((s) => !migratedKeys.has(normalizeAlias(s.serviceKey)));
  console.log(`待迁移：${toMigrate.length}（已跳过 ${services.length - toMigrate.length}）\n`);

  if (dryRun) {
    for (const s of toMigrate) {
      const kind = CATEGORY_TO_KIND[s.category] ?? PRODUCT_KIND.OTHER;
      console.log(`  [DRY] ${s.serviceKey} → Product(kind=${kind}) + 默认 SKU "${s.name}"`);
    }
    console.log(`\n[DRY-RUN] 未写入。加 --apply 执行迁移。`);
    await prisma.$disconnect();
    return;
  }

  // 需要一个系统 actor 用于 createdById。取第一个 ADMIN user。
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true, name: true } });
  if (!admin) {
    console.error("未找到 ADMIN 用户，无法执行迁移（需要 createdById）。请先创建管理员。");
    process.exit(1);
  }
  console.log(`使用管理员 actor: ${admin.name} (${admin.id})\n`);

  let migrated = 0;
  let failed = 0;
  for (const s of toMigrate) {
    try {
      await prisma.$transaction(async (tx) => {
        const kind = CATEGORY_TO_KIND[s.category] ?? PRODUCT_KIND.OTHER;
        const productCode = await nextProductCode(tx);
        const product = await tx.product.create({
          data: {
            productCode,
            name: s.name,
            kind,
            domain: s.domain && (SC_DOMAIN_MAP as readonly string[]).includes(s.domain) ? s.domain : null,
            status: PRODUCT_STATUS.ACTIVE,
            description: s.description ?? null,
            createdById: admin.id,
          },
        });

        // serviceKey 作为 alias（LEGACY_SERVICE_KEY）
        await tx.productAlias.create({
          data: {
            productId: product.id,
            alias: s.serviceKey,
            normalizedAlias: normalizeAlias(s.serviceKey),
            source: PRODUCT_ALIAS_SOURCE.LEGACY_SERVICE_KEY,
          },
        });

        // aliasesJson 中的别名
        const extraAliases = parseAliasesJson(s.aliasesJson);
        for (const a of extraAliases) {
          const norm = normalizeAlias(a);
          try {
            await tx.productAlias.create({
              data: {
                productId: product.id,
                alias: a,
                normalizedAlias: norm,
                source: PRODUCT_ALIAS_SOURCE.IMPORT,
              },
            });
          } catch {
            // 同产品下 normalizedAlias 重复则跳过
          }
        }

        // 默认 SKU
        const skuCode = await nextSkuCode(tx);
        const skuStatus = s.active ? PRODUCT_STATUS.ACTIVE : PRODUCT_STATUS.DRAFT;
        await tx.productSku.create({
          data: {
            skuCode,
            productId: product.id,
            name: s.name,
            spec: null,
            standardUnit: "项",
            sellable: s.active,
            purchasable: s.active,
            fulfillmentMode: "EXTERNAL_OR_INTERNAL",
            status: skuStatus,
            createdById: admin.id,
          },
        });

        await tx.productChangeLog.create({
          data: {
            productId: product.id,
            action: "PRODUCT_CREATED",
            note: `从 ServiceCatalog(${s.serviceKey}) 迁移`,
            createdById: admin.id,
          },
        });

        console.log(`  ✅ ${s.serviceKey} → ${productCode} / ${skuCode}`);
      });
      migrated++;
    } catch (err) {
      console.error(`  ❌ ${s.serviceKey} 迁移失败:`, err);
      failed++;
    }
  }

  console.log(`\n=== 迁移完成：成功 ${migrated}，失败 ${failed} ===`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("迁移脚本失败:", err);
  process.exit(1);
});
