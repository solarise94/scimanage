/**
 * ServiceCatalog 种子数据。
 *
 * 初始化单细胞/空间组学常见标准服务项。
 * 只创建缺失的系统预置项——已存在的 serviceKey 完全跳过，不覆盖任何字段。
 * 这样部署后管理员通过 UI 修改的名称、类别、别名、描述都不会被重置。
 *
 * 用法：npx tsx prisma/seed-service-catalog.ts
 *
 * 注意：本脚本不创建任何用户账号、不触碰凭据，仅初始化服务项字典。
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface ServiceSeed {
  serviceKey: string;
  name: string;
  category: string; // SERVICE_CATEGORY: SERVICE | PRODUCT | MIXED | OTHER
  domain: string; // SERVICE_DOMAIN: SEQUENCING | LIBRARY_PREP | SPATIAL | BIOINFORMATICS | LOGISTICS | OTHER
  aliases: string[];
  description: string;
}

const SERVICE_SEEDS: ServiceSeed[] = [
  {
    serviceKey: "scrna-seq",
    name: "单细胞 RNA 测序",
    category: "SERVICE",
    domain: "SEQUENCING",
    aliases: ["scRNA-seq", "单细胞转录组", "single cell RNA-seq", "scRNA"],
    description: "单细胞水平转录组测序",
  },
  {
    serviceKey: "snrna-seq",
    name: "单核 RNA 测序",
    category: "SERVICE",
    domain: "SEQUENCING",
    aliases: ["snRNA-seq", "单核转录组", "single nucleus RNA-seq"],
    description: "单核水平转录组测序",
  },
  {
    serviceKey: "single-cell-library-prep",
    name: "单细胞文库构建",
    category: "SERVICE",
    domain: "LIBRARY_PREP",
    aliases: ["单细胞建库", "scRNA library prep", "10x 建库"],
    description: "单细胞测序文库制备",
  },
  {
    serviceKey: "visium",
    name: "Visium 空间转录组",
    category: "SERVICE",
    domain: "SPATIAL",
    aliases: ["Visium", "10x 空间转录组", "Visium 空间组学"],
    description: "10x Genomics Visium 空间转录组测序",
  },
  {
    serviceKey: "stereo-seq",
    name: "Stereo-seq 空间转录组",
    category: "SERVICE",
    domain: "SPATIAL",
    aliases: ["Stereo-seq", "华大空间转录组", "spatial transcriptomics Stereo"],
    description: "华大 Stereo-seq 空间转录组测序",
  },
  {
    serviceKey: "spatial-library-prep",
    name: "空间转录组文库构建",
    category: "SERVICE",
    domain: "LIBRARY_PREP",
    aliases: ["空间建库", "spatial library prep"],
    description: "空间转录组测序文库制备",
  },
  {
    serviceKey: "bulk-rna-seq",
    name: "普通转录组测序",
    category: "SERVICE",
    domain: "SEQUENCING",
    aliases: ["bulk RNA-seq", "普通 RNA-seq", "转录组测序"],
    description: "组织或细胞群体水平的转录组测序",
  },
  {
    serviceKey: "sample-qc",
    name: "样本质控",
    category: "SERVICE",
    domain: "OTHER",
    aliases: ["QC", "样本质量检测", "sample quality control"],
    description: "样本质量检测与质控",
  },
  {
    serviceKey: "sequencing",
    name: "测序服务",
    category: "SERVICE",
    domain: "SEQUENCING",
    aliases: ["sequencing", "上机测序", "NovaSeq", "测序"],
    description: "通用测序上机服务",
  },
  {
    serviceKey: "bioinformatics-analysis",
    name: "生物信息分析",
    category: "SERVICE",
    domain: "BIOINFORMATICS",
    aliases: ["生信分析", "bioinformatics", "数据分析", "下游分析"],
    description: "测序数据生物信息学分析",
  },
  {
    serviceKey: "logistics-cold-chain",
    name: "冷链物流",
    category: "SERVICE",
    domain: "LOGISTICS",
    aliases: ["冷链运输", "干冰物流", "样本运输", "cold chain"],
    description: "样本冷链运输物流",
  },
];

async function main() {
  console.log("Seeding ServiceCatalog (create-missing-only)...");

  let created = 0;
  let skipped = 0;

  for (const seed of SERVICE_SEEDS) {
    // 只创建缺失项——已存在则完全跳过，不覆盖任何字段
    const existing = await prisma.serviceCatalog.findUnique({
      where: { serviceKey: seed.serviceKey },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }

    await prisma.serviceCatalog.create({
      data: {
        serviceKey: seed.serviceKey,
        name: seed.name,
        category: seed.category,
        domain: seed.domain,
        aliasesJson: JSON.stringify(seed.aliases),
        description: seed.description,
        active: true,
      },
    });
    created++;
    console.log(`  ✓ ${seed.serviceKey} — ${seed.name}`);
  }

  console.log(`Done. Created ${created}, skipped ${skipped} (already exist). Total seeds: ${SERVICE_SEEDS.length}.`);
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
