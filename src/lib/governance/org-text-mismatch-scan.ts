import { prisma } from "@/lib/prisma";
import { normalizeOrgName } from "@/lib/organization-normalize";

/**
 * M1 语义层扫描（设计文档 §五 5.1 / §八 Phase G6）。
 *
 * 物理层（M1 现状）查的是“指向已归档/已删除机构的客户”——`consistency-scan`。
 * 本扫描补**语义层**：客户档案的机构【文本】说的是 A，但 `organizationId` 指向的机构 B
 * 与该文本归一化后**毫无包含关系**（既不是 B 的全称/简称，也不是 B 的任一别名），
 * 即“文本说 A，orgId 指向 B”的疑似机构混绑。
 *
 * 判定（保守，宁可漏报不可误报——设计要求“无误报”）：
 *   normText = normalizeOrgName(profile.organization)
 *   候选名 = { canonicalName, normalizedName, 每个 alias 的 normalizedAlias }（均再过一遍 normalizeOrgName）
 *   一致 ⇔ 存在某候选 c 使得 c === normText 或 (minLen>=4 且 (c.includes(normText) 或 normText.includes(c)))
 *   不一致（= 命中本扫描）⇔ 与所有候选都无任一方向的包含关系
 *
 * 只读护栏：本函数不写库；换绑由人工在客户档案页确认（M1 tab 仅展示 + 深链）。
 */
export interface OrgTextMismatchRecord {
  customerName: string | null;
  orgText: string;
  normalizedOrgText: string;
  organizationId: string;
  boundOrgName: string;
  boundOrgArchived: boolean;
}

export type MismatchKind =
  | "TEXT_DRIFT"
  | "SITE_OR_ROOM_IN_ORG_TEXT"
  | "INVALID_SITE";

export interface OrgTextDriftScanRecord extends OrgTextMismatchRecord {
  profileId: string;
  customerCodeSnapshot: string | null;
  mismatchKind: MismatchKind;
  organizationSiteId: string | null;
  organizationRawInput: string | null;
  boundOrgCode: string | null;
}

type DbLike = Pick<typeof prisma, "crmCustomerProfile" | "organizationSite">;

// 地点/院区/房间粒度关键词。命中说明该文本更像“在哪办公”而不是“单位名”。
const SITE_OR_ROOM_MARKERS = [
  "院区",
  "基地",
  "楼栋",
  "楼",
  "层",
  "室",
  "房",
  "栋",
  "单元",
  "科室",
  "中心", // 单独“中心”常是院区/科室粒度，如“妇儿中心477”
  "实验室",
  "办公室",
  "房间",
  "副主任室",
  "主任室",
];

// 纯数字房间号正则（允许前缀空格/楼层）
const ROOM_NUMBER_RE = /(?:^|\s)\d+[室房号]?$/;

function hasSiteOrRoomMarker(text: string): boolean {
  for (const marker of SITE_OR_ROOM_MARKERS) {
    if (text.includes(marker)) return true;
  }
  return ROOM_NUMBER_RE.test(text);
}

function isConsistent(normText: string, candidate: string): boolean {
  if (candidate === normText) return true;
  const minLen = Math.min(candidate.length, normText.length);
  if (minLen < 4) return false;
  return candidate.includes(normText) || normText.includes(candidate);
}

export async function scanOrgTextBindingMismatch(
  db: Pick<typeof prisma, "crmCustomerProfile"> = prisma,
): Promise<OrgTextMismatchRecord[]> {
  const records = await scanOrgTextDriftCandidates(db as DbLike);
  return records.map((r) => ({
    customerName: r.customerName,
    orgText: r.orgText,
    normalizedOrgText: r.normalizedOrgText,
    organizationId: r.organizationId,
    boundOrgName: r.boundOrgName,
    boundOrgArchived: r.boundOrgArchived,
  }));
}

/**
 * 扫描所有需要进入 M1b 治理的 Profile。
 *
 * 只保留 Profile 文本 / FK / site 一致性：
 * organizationId 有值，但 organization 文本与绑定机构不一致
 * （TEXT_DRIFT / SITE_OR_ROOM_IN_ORG_TEXT / INVALID_SITE）。
 *
 * 旧 kind（LEGACY_MIRROR_DRIFT / PROFILE_ORG_UNBACKFILLED）依赖已删除的 Customer 业务列，
 * 物理删列后不可能再产生，已从扫描与 allow-list 移除。
 */
export async function scanOrgTextDriftCandidates(
  db: DbLike = prisma,
): Promise<OrgTextDriftScanRecord[]> {
  const mainProfiles = await db.crmCustomerProfile.findMany({
      where: {
        archived: false,
        deleted: false,
        mergedIntoProfileId: null,
        organizationId: { not: null },
        org: { deleted: false },
      },
      select: {
        id: true,
        name: true,
        customerCode: true,
        organization: true,
        organizationId: true,
        organizationSiteId: true,
        organizationRawInput: true,
        org: {
          select: {
            id: true,
            orgCode: true,
            canonicalName: true,
            normalizedName: true,
            deleted: true,
            archived: true,
            aliases: { select: { normalizedAlias: true } },
          },
        },
        orgSite: { select: { id: true, organizationId: true, archived: true } },
      },
    });

  const records: OrgTextDriftScanRecord[] = [];

  for (const p of mainProfiles) {
    if (!p.organizationId || !p.org) continue;
    // bound org deleted/archived → 归入 M1a 物理异常，不生成 M1b 任务。
    if (p.org.deleted || p.org.archived) continue;

    const rawText = (p.organization ?? "").trim();
    const normText = normalizeOrgName(rawText);

    // 1. site 归属/归档检查
    let mismatchKind: MismatchKind | null = null;
    if (p.organizationSiteId) {
      const site = p.orgSite;
      if (!site || site.organizationId !== p.organizationId || site.archived) {
        mismatchKind = "INVALID_SITE";
      }
    }

    // 2. organization 为空 → 文本漂移（低风险）
    if (!mismatchKind && !rawText) {
      mismatchKind = "TEXT_DRIFT";
    }

    // 3. 地点/院区/房间粒度
    if (!mismatchKind && hasSiteOrRoomMarker(rawText)) {
      mismatchKind = "SITE_OR_ROOM_IN_ORG_TEXT";
    }

    // 4. 归一化一致性（最短长度 4 的保守规则）
    if (!mismatchKind && normText) {
      const candidates = [
        normalizeOrgName(p.org.canonicalName),
        normalizeOrgName(p.org.normalizedName),
        ...p.org.aliases.map((a) => normalizeOrgName(a.normalizedAlias)),
      ].filter((c): c is string => Boolean(c));

      const consistent = candidates.some((c) => isConsistent(normText, c));
      if (!consistent) {
        mismatchKind = "TEXT_DRIFT";
      }
    }

    if (!mismatchKind) continue;

    records.push({
      profileId: p.id,
      customerName: p.name ?? null,
      customerCodeSnapshot: p.customerCode,
      orgText: rawText,
      normalizedOrgText: normText,
      organizationId: p.organizationId,
      organizationSiteId: p.organizationSiteId,
      organizationRawInput: p.organizationRawInput,
      boundOrgName: p.org.canonicalName,
      boundOrgCode: p.org.orgCode,
      boundOrgArchived: p.org.archived,
      mismatchKind,
    });
  }

  records.sort((a, b) => {
    const priority = (k: MismatchKind) => {
      switch (k) {
        case "INVALID_SITE":
          return 0;
        case "TEXT_DRIFT":
          return 1;
        case "SITE_OR_ROOM_IN_ORG_TEXT":
          return 2;
        default:
          return 3;
      }
    };
    const pa = priority(a.mismatchKind);
    const pb = priority(b.mismatchKind);
    if (pa !== pb) return pa - pb;
    return a.orgText.localeCompare(b.orgText, "zh-CN");
  });

  return records;
}
