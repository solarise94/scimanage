/**
 * Canonical actor-aware CRM name / pinyin resolution (T5.1).
 *
 * Shared by Agent `crm.resolve_customer_name` and `crm.search_customers_by_pinyin`.
 * Candidates are scope-first via `gatherNameResolutionCandidates`; out-of-scope
 * profiles never appear in results.
 */
import type { BusinessActor } from "@/lib/application/actor";
import {
  gatherNameResolutionCandidates,
  scoreAndResolve,
  toPinyinToneless,
  type NameResolutionHints,
} from "@/lib/crm/customer-name-resolver";
import { assertCrmAgentReadAccess } from "@/lib/crm/application/crm-agent-access";

export type ResolveCustomerNameParams = {
  spokenName: string;
  organizationHint?: string | null;
  principalHint?: string | null;
  limit?: number;
};

export type ResolveCustomerNameResult = {
  normalizedSpokenName: string;
  resolution: "UNIQUE" | "AMBIGUOUS" | "NO_MATCH";
  candidates: Array<{
    profileId: string;
    name: string;
    organization: string;
    ownerName: string;
    score: number;
    reasons: string[];
  }>;
};

/** Map scoreAndResolve reasons to Agent pinyin search matchType labels. */
export function mapNameMatchType(
  reasons: string[],
): "exact-homophone" | "pinyin-initial" | "near-sound" | "name-contains" {
  if (reasons.some((r) => r.includes("发音相同"))) return "exact-homophone";
  if (reasons.some((r) => r.includes("发音相近"))) return "near-sound";
  if (reasons.some((r) => r.includes("拼音/首字母命中"))) return "pinyin-initial";
  return "name-contains";
}

export async function resolveCustomerNameForActor(
  actor: BusinessActor,
  params: ResolveCustomerNameParams,
): Promise<ResolveCustomerNameResult> {
  assertCrmAgentReadAccess(actor);

  const limit = Math.max(1, Math.min(10, Math.trunc(params.limit ?? 5)));
  const gathered = await gatherNameResolutionCandidates(actor, params.spokenName);
  const scored = scoreAndResolve(
    params.spokenName,
    gathered,
    {
      organizationHint: params.organizationHint,
      principalHint: params.principalHint,
    } satisfies NameResolutionHints,
    { limit },
  );

  return {
    normalizedSpokenName: scored.normalizedSpokenName,
    resolution: scored.resolution,
    candidates: scored.candidates.map((c) => ({
      profileId: c.profileId,
      name: c.name,
      organization: c.organization ?? "",
      ownerName: c.ownerName ?? "",
      score: c.score,
      reasons: c.reasons,
    })),
  };
}

export type SearchCustomersByPinyinParams = {
  spokenName: string;
  limit?: number;
};

export type SearchCustomersByPinyinResult = {
  query: string;
  queryPinyin: string;
  resolution: "UNIQUE" | "AMBIGUOUS" | "NO_MATCH";
  candidates: Array<{
    profileId: string;
    name: string;
    namePinyin: string;
    organization: string;
    principal: string;
    ownerName: string;
    score: number;
    matchType: ReturnType<typeof mapNameMatchType>;
    signals: string[];
  }>;
  total: number;
};

export async function searchCustomersByPinyinForActor(
  actor: BusinessActor,
  params: SearchCustomersByPinyinParams,
): Promise<SearchCustomersByPinyinResult> {
  assertCrmAgentReadAccess(actor);

  const limit = Math.max(1, Math.min(10, Math.trunc(params.limit ?? 5)));
  const gathered = await gatherNameResolutionCandidates(actor, params.spokenName);
  const scored = scoreAndResolve(params.spokenName, gathered, {}, { limit });

  return {
    query: params.spokenName,
    queryPinyin: toPinyinToneless(params.spokenName),
    resolution: scored.resolution,
    candidates: scored.candidates.map((c) => ({
      profileId: c.profileId,
      name: c.name,
      namePinyin:
        gathered.find((g) => g.profileId === c.profileId)?.namePinyin
        ?? toPinyinToneless(c.name)
        ?? "",
      organization: c.organization ?? "",
      principal: gathered.find((g) => g.profileId === c.profileId)?.principal ?? "",
      ownerName: c.ownerName ?? "",
      score: c.score,
      matchType: mapNameMatchType(c.reasons),
      signals: c.reasons,
    })),
    total: scored.candidates.length,
  };
}
