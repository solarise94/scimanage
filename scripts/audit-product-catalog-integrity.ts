/**
 * 产品目录与订单—供应链—成本一体化数据完整性审计脚本。
 *
 * 对应设计文档 §12 必须提供的审计指标。结果非 0 的"必须为 0"项表示存在违反不变量的数据，
 * 会阻止切换事实源。可作为 CI/部署前检查运行。
 *
 * 用法：
 *   npx tsx scripts/audit-product-catalog-integrity.ts [--json]
 *
 * 本脚本只读，不改数据。使用 prisma/dev.db（或 DATABASE_URL 指定的库）。
 */
import { prisma } from "../src/lib/prisma";

interface Metric {
  name: string;
  value: number;
  mustBeZero?: boolean;
  description: string;
}

async function main() {
  const metrics: Metric[] = [];

  // 1. ServiceCatalog 未生成 SKU 数
  const serviceCatalogCount = await prisma.serviceCatalog.count();
  const servicesWithSkuAlias = await prisma.productAlias.count({
    where: { source: "LEGACY_SERVICE_KEY" },
  });
  metrics.push({
    name: "serviceCatalog_without_sku",
    value: Math.max(0, serviceCatalogCount - servicesWithSkuAlias),
    description: "ServiceCatalog 未生成 Product/SKU 的条目数",
  });

  // 2. 映射指向不存在/停用目录项数（OrderLineServiceMapping.productSkuId 指向非 ACTIVE SKU）
  const mappingsToInactiveSku = await prisma.orderLineServiceMapping.count({
    where: {
      productSkuId: { not: null },
      productSku: { status: { not: "ACTIVE" } },
    },
  });
  metrics.push({
    name: "mappings_to_inactive_sku",
    value: mappingsToInactiveSku,
    mustBeZero: false,
    description: "OrderLineServiceMapping 指向非 ACTIVE SKU 的数量（治理候选）",
  });

  // 3. OrderLine 无 SKU 绑定数（含完全无 mapping 的历史行）
  const orderLinesWithoutMapping = await prisma.orderLine.count({
    where: {
      OR: [
        { serviceMapping: null },
        { serviceMapping: { productSkuId: null } },
      ],
    },
  });
  metrics.push({
    name: "orderlines_without_sku",
    value: orderLinesWithoutMapping,
    description: "OrderLine 无 productSkuId 绑定数（历史自由文本行）",
  });

  // 4. 新订单无 SKU 绑定数（必须为 0）—— 新订单指 createdById 非空且 mapping 存在但 productSkuId 空
  // 宽松口径：所有 mapping 行里 productSkuId 为空的都算"未完成迁移"
  const newOrdersWithoutSku = await prisma.orderLineServiceMapping.count({
    where: {
      productSkuId: null,
      source: { in: ["AGENT_DRAFT", "MANUAL"] },
    },
  });
  metrics.push({
    name: "new_orderlines_without_sku",
    value: newOrdersWithoutSku,
    mustBeZero: true,
    description: "新业务（AGENT_DRAFT/MANUAL 来源）mapping 无 productSkuId 数（必须为 0）",
  });

  // 5. SupplierQuote 无 SKU FK 数
  const quotesWithoutSku = await prisma.supplierQuote.count({
    where: {
      productSkuId: null,
      serviceKey: null, // 同时为空才算违规（兼容期不变量）
    },
  });
  metrics.push({
    name: "quotes_without_sku_and_servicekey",
    value: quotesWithoutSku,
    mustBeZero: true,
    description: "SupplierQuote productSkuId 与 serviceKey 同时为空数（兼容期必须为 0）",
  });

  // 6. SupplierCapability 无 SKU 且无 serviceKey（兼容期必须为 0）
  const capabilitiesWithoutBoth = await prisma.supplierCapability.count({
    where: { productSkuId: null, serviceKey: null },
  });
  metrics.push({
    name: "capabilities_without_sku_and_servicekey",
    value: capabilitiesWithoutBoth,
    mustBeZero: true,
    description: "SupplierCapability productSkuId 与 serviceKey 同时为空数（必须为 0）",
  });

  // 7. active purchasable SKU 无有效报价数
  const activePurchasableSkus = await prisma.productSku.findMany({
    where: { status: "ACTIVE", purchasable: true },
    select: { id: true },
  });
  const skusWithQuote = await prisma.supplierQuote.groupBy({
    by: ["productSkuId"],
    where: {
      productSkuId: { in: activePurchasableSkus.map((s) => s.id) },
      status: "ACTIVE",
    },
    _count: true,
  });
  const skuIdsWithQuote = new Set(skusWithQuote.map((s) => s.productSkuId));
  metrics.push({
    name: "active_purchasable_skus_without_quote",
    value: activePurchasableSkus.filter((s) => !skuIdsWithQuote.has(s.id)).length,
    description: "active purchasable SKU 无有效报价数（治理候选）",
  });

  // 8. PRJ-OTHER 被普通 OrderProjectLink 引用数（必须为 0）
  const otherProject = await prisma.project.findUnique({
    where: { systemKey: "GENERAL_OTHER_PROJECT" },
    select: { id: true },
  });
  const orderLinksToBucket = otherProject
    ? await prisma.orderProjectLink.count({ where: { projectId: otherProject.id } })
    : 0;
  metrics.push({
    name: "orderlinks_to_governance_bucket",
    value: orderLinksToBucket,
    mustBeZero: true,
    description: "普通 OrderProjectLink 引用 PRJ-OTHER 治理桶数（必须为 0）",
  });

  // 9. GOVERNANCE_BUCKET 出现在正常项目聚合（即 systemType=GOVERNANCE_BUCKET 的总数，仅治理桶应存在）
  const governanceBuckets = await prisma.project.count({
    where: { systemType: "GOVERNANCE_BUCKET" },
  });
  metrics.push({
    name: "governance_buckets_total",
    value: governanceBuckets,
    description: "GOVERNANCE_BUCKET 项目总数（应为 1，即 PRJ-OTHER）",
  });

  // 10. 兼容表中 productSkuId/serviceKey 同时为空数（必须为 0）
  // OrderLineServiceMapping
  const mappingsBothNull = await prisma.orderLineServiceMapping.count({
    where: { productSkuId: null, serviceKey: null },
  });
  metrics.push({
    name: "mappings_both_null",
    value: mappingsBothNull,
    mustBeZero: true,
    description: "OrderLineServiceMapping productSkuId/serviceKey 同时为空数（必须为 0）",
  });

  // 11. SupplyRequirement.definitionHash 缺失数（必须为 0）—— Phase 2 起有意义
  // definitionHash 是 NOT NULL 列，所以"缺失"只能是空字符串（DB 层无法保证非空字符串）
  const requirementsWithoutHash = await prisma.supplyRequirement.count({
    where: { definitionHash: "" },
  });
  metrics.push({
    name: "supply_requirements_without_hash",
    value: requirementsWithoutHash,
    mustBeZero: true,
    description: "SupplyRequirement.definitionHash 为空字符串数（必须为 0；列本身 NOT NULL）",
  });

  // 12. 未解决治理 assignment 数
  const openAssignments = await prisma.projectGovernanceAssignment.count({
    where: { status: "OPEN" },
  });
  metrics.push({
    name: "open_governance_assignments",
    value: openAssignments,
    description: "未解决治理 assignment 数",
  });

  // 13. 编号空洞与重复检测（productCode/skuCode @unique 已保证无重复，这里统计当前最大序号）
  const maxProductSeq = await prisma.businessSequence.findUnique({ where: { key: "PRODUCT" } });
  const maxSkuSeq = await prisma.businessSequence.findUnique({ where: { key: "PRODUCT_SKU" } });
  metrics.push({
    name: "product_sequence_current",
    value: maxProductSeq?.currentValue ?? 0,
    description: `Product 编号序列当前值（PRD-${String((maxProductSeq?.currentValue ?? 0) + 1).padStart(6, "0")} 为下一个）`,
  });
  metrics.push({
    name: "sku_sequence_current",
    value: maxSkuSeq?.currentValue ?? 0,
    description: `SKU 编号序列当前值（SKU-${String((maxSkuSeq?.currentValue ?? 0) + 1).padStart(6, "0")} 为下一个）`,
  });

  // 输出
  const jsonMode = process.argv.includes("--json");
  if (jsonMode) {
    console.log(JSON.stringify(metrics, null, 2));
  } else {
    console.log("=== 产品目录与订单—供应链—成本一体化 数据完整性审计 ===\n");
    for (const m of metrics) {
      const flag = m.mustBeZero && m.value > 0 ? "❌ 违反不变量" : m.mustBeZero ? "✅" : "ℹ️";
      console.log(`${flag} ${m.name}: ${m.value}`);
      console.log(`     ${m.description}`);
    }
    const violations = metrics.filter((m) => m.mustBeZero && m.value > 0);
    console.log(`\n=== 总结：${violations.length} 项违反不变量 ===`);
    if (violations.length > 0) {
      for (const v of violations) {
        console.log(`  ❌ ${v.name} = ${v.value}`);
      }
      process.exitCode = 1;
    }
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("审计脚本失败:", err);
  process.exit(1);
});
