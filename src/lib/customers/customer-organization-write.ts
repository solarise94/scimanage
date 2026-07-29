import { prisma } from "@/lib/prisma";
import { validateOrg } from "@/lib/crm/customer-application-review";
import type { Prisma } from "@prisma/client";

export type OrgWriteInput = {
  organizationId?: string | null;
  organizationSiteId?: string | null;
  organizationText?: string | null;
  organizationRawInput?: string | null;
  existingOrganizationId?: string | null;
  existingOrganizationSiteId?: string | null;
};

export type OrgWriteResult =
  | {
      ok: true;
      organizationId: string | null;
      organizationSiteId: string | null;
      organization: string | null;
      organizationRawInput: string | null;
    }
  | { ok: false; status: number; message: string };

/** 已解析机构 + 可选院区时的确定性 Profile 机构写入块（含 canonical 快照）。 */
export type CanonicalOrganizationBindingPatch = {
  organizationId: string;
  organization: string;
  organizationSiteId: string | null;
};

type DbClient = Prisma.TransactionClient | typeof prisma;

function trimOrNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t || null;
}

/**
 * 从已校验的机构/院区事实构造 Profile 写入 patch。
 * 禁止调用方自行拼 organization 文本；快照必须来自 Organization.canonicalName。
 */
export function buildCanonicalOrganizationBindingPatch(input: {
  organizationId: string;
  canonicalName: string;
  organizationSiteId?: string | null;
}): CanonicalOrganizationBindingPatch {
  const organizationId = trimOrNull(input.organizationId);
  const canonicalName = trimOrNull(input.canonicalName);
  if (!organizationId || !canonicalName) {
    throw new Error("buildCanonicalOrganizationBindingPatch 需要非空 organizationId 与 canonicalName");
  }
  return {
    organizationId,
    organization: canonicalName,
    organizationSiteId: trimOrNull(input.organizationSiteId),
  };
}

/**
 * 按院区 ID 解析批量挂院区所需的一致性写入块。
 * 一次查出 site + 所属机构 canonicalName，供 batch-assign-site 等路径复用。
 */
export async function resolveCanonicalOrganizationBindingFromSiteId(
  organizationSiteId: string,
  db: DbClient = prisma,
): Promise<
  | {
      ok: true;
      patch: CanonicalOrganizationBindingPatch;
      siteName: string;
    }
  | { ok: false; status: number; message: string }
> {
  const siteId = trimOrNull(organizationSiteId);
  if (!siteId) {
    return { ok: false, status: 400, message: "organizationSiteId 必填" };
  }

  const site = await db.organizationSite.findUnique({
    where: { id: siteId },
    select: {
      id: true,
      siteName: true,
      organizationId: true,
      archived: true,
      organization: {
        select: { id: true, canonicalName: true, deleted: true, archived: true },
      },
    },
  });
  if (!site) return { ok: false, status: 404, message: "目标院区不存在" };
  if (site.archived) return { ok: false, status: 400, message: "目标院区已归档，无法挂载" };
  if (!site.organization || site.organization.deleted) {
    return { ok: false, status: 400, message: "目标院区所属机构无效" };
  }
  if (site.organization.archived) {
    return { ok: false, status: 400, message: "目标院区所属机构已归档，无法挂载" };
  }

  return {
    ok: true,
    patch: buildCanonicalOrganizationBindingPatch({
      organizationId: site.organizationId,
      canonicalName: site.organization.canonicalName,
      organizationSiteId: site.id,
    }),
    siteName: site.siteName,
  };
}

/**
 * 统一解析客户机构写入参数。
 *
 * 规则：
 * 1. 有 organizationId → 强制返回 organization = canonicalName，原始输入只进 organizationRawInput。
 * 2. 无 organizationId 但有文本 → 必须 exact resolve；否则报错，禁止“有文本无 FK”。
 * 3. 已有 organizationId 的客户不允许清空机构（必须走换绑或治理）。
 * 4. 统一走 validateOrg，补齐 isInvoiceSubject / site 归属 / archived / deleted 校验。
 *
 * 本函数不直接写库，返回纯数据供各写入口在事务中使用。
 */
export async function resolveCustomerOrganizationWrite(
  input: OrgWriteInput,
  db: DbClient = prisma,
): Promise<OrgWriteResult> {
  const requestedOrgId = trimOrNull(input.organizationId);
  const requestedSiteId = trimOrNull(input.organizationSiteId);
  const organizationText = trimOrNull(input.organizationText);
  const providedRawInput = trimOrNull(input.organizationRawInput);
  const existingOrgId = trimOrNull(input.existingOrganizationId);

  // 想清空已有机构？禁止直接清空，必须走换绑或治理流程。
  if (existingOrgId && !requestedOrgId && !organizationText) {
    return {
      ok: false,
      status: 400,
      message: "已绑定机构的客户不允许直接清空机构，请通过换绑或治理流程处理",
    };
  }

  const rawOrgText = providedRawInput ?? organizationText;
  const orgValidation = await validateOrg(requestedOrgId, requestedSiteId, rawOrgText, db);

  if (orgValidation.error) {
    return { ok: false, status: 400, message: orgValidation.error };
  }

  // validateOrg 无 organizationId 时只在 exact resolve 成功才返回 organizationId；
  // 否则 organizationId 为 null。这正好对应“有文本无 FK 禁止保存”。
  if (!orgValidation.organizationId) {
    if (organizationText) {
      return {
        ok: false,
        status: 400,
        message: "机构文本未精确匹配到已有单位，请选择机构或先创建单位",
      };
    }
    // 完全没有机构
    return {
      ok: true,
      organizationId: null,
      organizationSiteId: null,
      organization: null,
      organizationRawInput: null,
    };
  }

  // 最终原始输入：显式提供的 raw > 用户可见文本 > 旧的 raw（由调用方在 input 中传入）> canonicalName
  const finalRawInput =
    providedRawInput ?? organizationText ?? null;

  return {
    ok: true,
    organizationId: orgValidation.organizationId,
    organizationSiteId: orgValidation.organizationSiteId,
    organization: orgValidation.canonicalName,
    organizationRawInput: finalRawInput,
  };
}
