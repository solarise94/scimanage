/**
 * 从订单买家地址快照（buyerAddressSnapshot）抽取机构候选（设计文档 §3.3.3 / §八 Phase G2）。
 *
 * 用于 C2 空壳客户「地址辅助解析」：当客户本身无机构文本，但其关联订单地址里常含真实单位
 * （如「温州医科大学附属第一医院」）。此 helper 把候选抽出来，调用方再用 resolveOrganization()
 * 做二次确认，仅 EXACT 自动补 orgId。
 *
 * 与 finance/pingoodmice-match 里私有的 matchOrgAgainstOrderAddress 的关键差异：
 *  - **禁用 storeName fallback**（原 Priority 3）：店铺名（"总店"等）不是机构，禁止据此补机构。
 *  - 明确区分「canonical/alias 命中」（强）与「大学/研究所/医院/公司 模式抽取」（弱，需二次确认）。
 */
import { prisma } from "@/lib/prisma";
import { normalizeText } from "@/lib/orders/match-scoring";

export interface AddressMatchOrg {
  id: string;
  canonicalName: string;
  normalizedName: string | null;
  aliases: { alias: string }[];
}

/** 加载机构主数据用于地址匹配（canonical + normalized + alias）。 */
export async function loadAddressMatchOrganizations(): Promise<AddressMatchOrg[]> {
  return prisma.organization.findMany({
    where: { deleted: false, archived: false },
    select: { id: true, canonicalName: true, normalizedName: true, aliases: { select: { alias: true } } },
  });
}

export interface OrderAddressOrgCandidate {
  /** CANONICAL_HIT：地址里直接出现了已有机构名/别名，强命中（organizationId 已知）。
   *  PATTERN_TEXT：仅从地址按「大学/研究所/医院/公司」模式抽到文本，需 resolveOrganization 二次确认。 */
  kind: "CANONICAL_HIT" | "PATTERN_TEXT";
  organizationId: string | null;
  /** 命中机构的 canonicalName，或模式抽取出的机构文本。 */
  text: string;
}

/**
 * 从单条地址抽取机构候选。无命中返回 null。
 * 注意：不做 storeName fallback——这是与旧逻辑的关键区别。
 */
export function extractOrgFromAddress(
  organizations: AddressMatchOrg[],
  address: string | null,
): OrderAddressOrgCandidate | null {
  const addrNorm = normalizeText(address);
  if (!addrNorm) return null;

  // 强命中：已有机构 canonicalName / normalizedName / alias 出现在地址中（长度≥4 防短词误命中）。
  for (const org of organizations) {
    const names = [org.canonicalName, org.normalizedName, ...(org.aliases || []).map((a) => a.alias)]
      .filter((n): n is string => !!n)
      .map((n) => normalizeText(n));
    for (const name of names) {
      if (name && name.length >= 4 && addrNorm.includes(name)) {
        return { kind: "CANONICAL_HIT", organizationId: org.id, text: org.canonicalName };
      }
    }
  }

  // 弱命中：按机构模式抽取文本，交回调用方走 resolveOrganization 二次确认。
  const patterns = [/([一-龥]+大学)/, /([一-龥]+学院)/, /([一-龥]+研究所)/, /([一-龥]+医院)/, /([一-龥]+公司)/];
  for (const re of patterns) {
    const m = addrNorm.match(re);
    if (m) return { kind: "PATTERN_TEXT", organizationId: null, text: m[1] };
  }

  // 店铺名 fallback 已禁用（§3.3.3）：店铺名不是机构。
  return null;
}
