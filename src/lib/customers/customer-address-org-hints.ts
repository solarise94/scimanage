import { prisma } from "@/lib/prisma";
import {
  extractOrgFromAddress,
  loadAddressMatchOrganizations,
} from "@/lib/orders/order-address-org";

export interface CustomerAddressOrgHint {
  orgText: string;
  addressText: string;
  sourceLabel: string;
  kind: "CANONICAL_HIT" | "PATTERN_TEXT";
  organizationId: string | null;
}

type AddressSource = {
  text: string | null | undefined;
  sourceLabel: string;
};

function addAddressSource(sources: AddressSource[], text: string | null | undefined, sourceLabel: string) {
  const trimmed = text?.trim();
  if (!trimmed) return;
  sources.push({ text: trimmed, sourceLabel });
}

function collectAddressSources(profile: {
  address?: string | null;
  addressNote?: string | null;
  receiverAddress?: string | null;
  addresses?: Array<{ addressText: string | null; label: string | null; isPrimary: boolean }>;
}): AddressSource[] {
  const sources: AddressSource[] = [];

  addAddressSource(sources, profile.address, "档案通讯地址");
  addAddressSource(sources, profile.addressNote, "档案地址备注");
  addAddressSource(sources, profile.receiverAddress, "档案收货地址");

  for (const address of profile.addresses ?? []) {
    const label = address.label?.trim() || (address.isPrimary ? "主地址" : "地址记录");
    addAddressSource(sources, address.addressText, `CRM ${label}`);
  }

  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.sourceLabel}:${source.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 按 profileId 提取通讯地址中的机构线索（Profile-only：直查 CrmCustomerProfile，
 * 不再经 Customer 锚点反查）。返回 Map<profileId, hints>。
 */
export async function getProfileAddressOrgHints(
  profileIds: string[],
  limitPerProfile = 3,
): Promise<Map<string, CustomerAddressOrgHint[]>> {
  const uniqueIds = [...new Set(profileIds.filter(Boolean))];
  const result = new Map<string, CustomerAddressOrgHint[]>();
  if (uniqueIds.length === 0) return result;

  const [organizations, profiles] = await Promise.all([
    loadAddressMatchOrganizations(),
    prisma.crmCustomerProfile.findMany({
      where: { id: { in: uniqueIds } },
      select: {
        id: true,
        address: true,
        addressNote: true,
        receiverAddress: true,
        addresses: {
          orderBy: [{ isPrimary: "desc" }, { updatedAt: "desc" }],
          take: 5,
          select: { addressText: true, label: true, isPrimary: true },
        },
      },
    }),
  ]);

  for (const profile of profiles) {
    const hints: CustomerAddressOrgHint[] = [];
    const seenHint = new Set<string>();

    for (const source of collectAddressSources(profile)) {
      const candidate = extractOrgFromAddress(organizations, source.text ?? null);
      if (!candidate) continue;
      const key = `${candidate.text}:${source.text}`;
      if (seenHint.has(key)) continue;
      seenHint.add(key);
      hints.push({
        orgText: candidate.text,
        addressText: source.text ?? "",
        sourceLabel: source.sourceLabel,
        kind: candidate.kind,
        organizationId: candidate.organizationId,
      });
      if (hints.length >= limitPerProfile) break;
    }

    result.set(profile.id, hints);
  }

  return result;
}
