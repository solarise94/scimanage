import { createHash } from "crypto";

/**
 * 合同生成「权威事实 digest」——纯函数模块，无 prisma 依赖。
 *
 * 从 generate.ts 抽出，使 digest 计算可被单元测试静态导入而不触发 prisma 单例
 * （generate.ts import prisma，测试静态导入它会在 withTempSmokeDb 设 DATABASE_URL
 * 之前就 new PrismaClient()，污染单例）。
 *
 * digest 覆盖全部「渲染输入 + 落库字段」事实，用于 TOCTOU 防护：渲染前计算期望值，
 * 写事务内用 tx 重载完整渲染事实后比较；任一字段漂移 -> FACT_DIGEST_MISMATCH。
 */

export type ContractFactLine = {
  itemName: string;
  spec: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
};

export type ContractRenderFacts = {
  orderIds: string[];
  lines: ContractFactLine[];
  totalCents: number;
  buyer: {
    buyerName: string;
    buyerOrgName: string;
    buyerTaxId: string;
    buyerAddress: string;
    buyerPhone: string;
    buyerEmail: string;
  };
  seller: {
    id: string;
    name: string;
    taxId: string | null;
    bankName: string | null;
    bankAccount: string | null;
    address: string | null;
    phone: string | null;
    legalRepresentative: string | null;
    archived: boolean;
  };
  template: {
    category: string;
    archived: boolean;
    fileHash: string;
  };
  primaryOrderProjectId: string | null;
};

/**
 * 计算合同渲染事实的权威 digest。
 *
 * lines 保留调用方传入的顺序（与 docx 渲染 / itemsJson 一致），不再二次排序：
 * sortOrder 交换会改变展示顺序，必须触发 FACT_DIGEST_MISMATCH。
 * 查询侧用 orderBy [{ sortOrder: "asc" }, { id: "asc" }] 保证加载顺序稳定，
 * 避免 findMany 同 sortOrder 时非确定返回导致的假阳性。
 */
export function computeFactDigest(facts: ContractRenderFacts): string {
  const linesCanonical = facts.lines.map((l) =>
    JSON.stringify({
      itemName: l.itemName,
      spec: l.spec,
      quantity: l.quantity,
      unit: l.unit,
      unitPrice: l.unitPrice,
      amount: l.amount,
    }),
  );
  const canonical = JSON.stringify({
    orderIds: facts.orderIds,
    lines: linesCanonical,
    totalCents: facts.totalCents,
    buyer: facts.buyer,
    seller: facts.seller,
    template: facts.template,
    primaryOrderProjectId: facts.primaryOrderProjectId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
