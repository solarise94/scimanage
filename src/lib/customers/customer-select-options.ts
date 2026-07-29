import { resolveEffectiveRepresentativesForProfiles } from "@/lib/crm/customer-effective-representative";

export interface CustomerSelectOption {
  profileId: string;
  /** 与 profileId 相同（选择器兼容 id 字段） */
  id: string;
  customerCode: string;
  name: string;
  organization: string | null;
  organizationId: string | null;
  principal: string | null;
  wechat: string | null;
  address: string | null;
  representativeId: string | null;
  representativeName: string | null;
}

type ProfileRepRow = {
  id: string;
  customerCode?: string | null;
  name?: string | null;
  organization?: string | null;
  organizationId?: string | null;
  principal?: string | null;
  wechat?: string | null;
  address?: string | null;
};

/**
 * W6.9.4：只认 profileId。批量解析 effective 代表并合并到 Profile 行。
 */
export async function appendProfileRepresentativeInfo<T extends { id: string }>(
  profiles: T[],
): Promise<Array<T & { representativeId: string | null; representativeName: string | null }>> {
  if (profiles.length === 0) return [];

  const effectiveMap = await resolveEffectiveRepresentativesForProfiles(
    profiles.map((p) => p.id),
  );

  return profiles.map((p) => {
    const effective = effectiveMap.get(p.id);
    return {
      ...p,
      representativeId: effective?.representativeId ?? null,
      representativeName: effective?.representativeName ?? null,
    };
  });
}

/**
 * Narrow helper for CustomerSelect / POST quick-create response.
 * 入参 `id` 必须是 Profile.id。
 */
export async function resolveCustomerSelectOptions(
  profiles: ProfileRepRow[],
): Promise<CustomerSelectOption[]> {
  const resolved = await appendProfileRepresentativeInfo(profiles);
  return resolved.map((p) => ({
    profileId: p.id,
    id: p.id,
    customerCode: p.customerCode ?? "------",
    name: p.name ?? "未命名客户",
    organization: p.organization ?? null,
    organizationId: p.organizationId ?? null,
    principal: p.principal ?? null,
    wechat: p.wechat ?? null,
    address: p.address ?? null,
    representativeId: p.representativeId,
    representativeName: p.representativeName,
  }));
}

/** Resolve a single profile to a CustomerSelectOption (with rep info). */
export async function resolveSingleCustomerOption(
  profile: ProfileRepRow,
): Promise<CustomerSelectOption> {
  const [result] = await resolveCustomerSelectOptions([profile]);
  return result;
}
