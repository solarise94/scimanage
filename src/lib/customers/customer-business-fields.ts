import { getCustomerOrganizationName } from "@/lib/customer-organization";

/**
 * CrmCustomerProfile 业务字段定义与旧 API 扁平响应 adapter。
 * Customer 已是纯锚点表；本文件不再读取、选择或回填任何 Customer 业务列。
 */
export const CRM_PROFILE_BUSINESS_FIELDS = [
  "name", "customerCode", "nameDisambiguator", "principal", "labOrGroup",
  "phone", "wechat", "email", "miniProgramId", "address", "addressNote",
  "receiverPhone", "receiverAddress", "organization", "organizationId",
  "organizationSiteId", "organizationRawInput",
] as const;
export type CrmProfileBusinessField = (typeof CRM_PROFILE_BUSINESS_FIELDS)[number];

export const profileBusinessSelect = {
  name: true, customerCode: true, nameDisambiguator: true, principal: true,
  labOrGroup: true, phone: true, wechat: true, email: true, miniProgramId: true,
  address: true, addressNote: true, receiverPhone: true, receiverAddress: true,
  organization: true, organizationId: true, organizationSiteId: true,
  organizationRawInput: true,
  org: { select: { canonicalName: true } },
  orgSite: { select: { siteName: true } },
} as const;

export const customerCrmProfileSelect = {
  id: true,
  archived: true,
  assignmentStatus: true,
  ownerUser: { select: { email: true, role: true } },
  ...profileBusinessSelect,
} as const;

type OrgRel = { canonicalName?: string | null } | null | undefined;
type SiteRel = { siteName?: string | null } | null | undefined;
type BusinessShape = {
  name?: string | null; customerCode?: string | null; nameDisambiguator?: string | null;
  principal?: string | null; labOrGroup?: string | null; phone?: string | null;
  wechat?: string | null; email?: string | null; miniProgramId?: string | null;
  address?: string | null; addressNote?: string | null; receiverPhone?: string | null;
  receiverAddress?: string | null; organization?: string | null; organizationId?: string | null;
  organizationSiteId?: string | null; organizationRawInput?: string | null;
  org?: OrgRel; orgSite?: SiteRel;
};

export type CustomerWithProfileRow = { crmProfile?: BusinessShape | null };

export type ResolvedCustomerBusinessFields = {
  name: string | null; customerCode: string | null; nameDisambiguator: string | null;
  principal: string | null; labOrGroup: string | null; phone: string | null;
  wechat: string | null; email: string | null; miniProgramId: string | null;
  address: string | null; addressNote: string | null; receiverPhone: string | null;
  receiverAddress: string | null; organization: string | null; organizationId: string | null;
  organizationSiteId: string | null; organizationRawInput: string | null;
};

/** CRM 接口使用的 Profile 主权客户展示模型。`id` 恒为 CrmCustomerProfile.id。 */
export type CrmProfileCustomerView = ResolvedCustomerBusinessFields & {
  id: string;
  archived: boolean;
};

function toOrgRel(org: OrgRel): { canonicalName: string } | null {
  return org && typeof org.canonicalName === "string" ? { canonicalName: org.canonicalName } : null;
}
function toSiteRel(site: SiteRel): { siteName: string } | null {
  return site && typeof site.siteName === "string" ? { siteName: site.siteName } : null;
}

/** 将 Profile 主权字段组装为旧 API 所需的扁平 response。 */
export function buildLegacyCustomerFields(row: CustomerWithProfileRow): ResolvedCustomerBusinessFields {
  const p = row.crmProfile ?? null;
  const organization = p
    ? getCustomerOrganizationName({
        organization: p.organization ?? null,
        org: toOrgRel(p.org),
        orgSite: toSiteRel(p.orgSite),
      })
    : null;
  return {
    name: p?.name ?? null, customerCode: p?.customerCode ?? null,
    nameDisambiguator: p?.nameDisambiguator ?? null, principal: p?.principal ?? null,
    labOrGroup: p?.labOrGroup ?? null, phone: p?.phone ?? null, wechat: p?.wechat ?? null,
    email: p?.email ?? null, miniProgramId: p?.miniProgramId ?? null, address: p?.address ?? null,
    addressNote: p?.addressNote ?? null, receiverPhone: p?.receiverPhone ?? null,
    receiverAddress: p?.receiverAddress ?? null, organization,
    organizationId: p?.organizationId ?? null, organizationSiteId: p?.organizationSiteId ?? null,
    organizationRawInput: p?.organizationRawInput ?? null,
  };
}

/**
 * 将任意 Profile 查询结果投影为 CRM UI 的扁平客户视图。
 * `id` 只认 profile.id。
 */
export function buildCrmProfileCustomerView(profile: BusinessShape & {
  id: string;
  archived?: boolean;
}): CrmProfileCustomerView {
  return {
    id: profile.id,
    archived: profile.archived ?? false,
    ...buildLegacyCustomerFields({ crmProfile: profile }),
  };
}
