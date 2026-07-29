import { resolveOrganization, type ResolveResult } from "@/lib/organization-resolver";
import { isMinimaxConfigured } from "@/lib/minimax";

const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "";
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || "";
const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com/v1";
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || "MiniMax-M2.7";

export interface EnrichmentDraft {
  canonicalName: string;
  address: string | null;
  aliases: string[];
  sites: Array<{ siteName: string; address: string | null }>;
  confidence: number;
}

export interface EnrichmentEvidence {
  title: string;
  url: string;
  snippet: string;
}

export type EnrichmentResult =
  | { kind: "existing"; resolveResult: ResolveResult }
  | { kind: "candidates"; resolveResult: ResolveResult }
  | { kind: "draft"; draft: EnrichmentDraft; evidence: EnrichmentEvidence[] }
  | { kind: "failed"; reason: string };

export function isEnrichmentConfigured(): boolean {
  return !!TAVILY_API_KEY && isMinimaxConfigured();
}

/**
 * Enrich an organization query:
 * 1. Try local DB resolve first
 * 2. If no exact match, search Tavily for web evidence
 * 3. Pass evidence to MiniMax for structured extraction
 */
export async function enrichOrganization(
  query: string,
  options: { skipLocalResolve?: boolean } = {},
): Promise<EnrichmentResult> {
  // Step 1: Try local resolve
  if (!options.skipLocalResolve) {
    const resolved = await resolveOrganization(query);
    if (resolved.status === "exact") {
      return { kind: "existing", resolveResult: resolved };
    }
    if (resolved.status === "candidate" && resolved.candidates.length > 0) {
      return { kind: "candidates", resolveResult: resolved };
    }
  }

  if (!TAVILY_API_KEY) {
    return { kind: "failed", reason: "Tavily API 未配置" };
  }
  if (!MINIMAX_API_KEY) {
    return { kind: "failed", reason: "MiniMax API 未配置" };
  }

  // Step 2: Tavily search
  let evidence: EnrichmentEvidence[] = [];
  try {
    evidence = await searchTavily(query);
  } catch (err) {
    console.error("Tavily search failed:", err);
    return { kind: "failed", reason: "网络搜索失败" };
  }

  if (evidence.length === 0) {
    return { kind: "failed", reason: "未找到相关信息" };
  }

  // Step 3: MiniMax extraction
  try {
    const draft = await extractWithMinimax(query, evidence);
    return { kind: "draft", draft, evidence };
  } catch (err) {
    console.error("MiniMax extraction failed:", err);
    return { kind: "failed", reason: "AI 抽取失败" };
  }
}

async function searchTavily(query: string): Promise<EnrichmentEvidence[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      query: `${query} 机构 地址 院区 校区 分院`,
      max_results: 5,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tavily API error: ${res.status} ${text}`);
  }

  const data = await res.json();
  const results = (data.results || []) as Array<{
    title: string;
    url: string;
    content: string;
  }>;

  return results.slice(0, 5).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: (r.content || "").slice(0, 500),
  }));
}

async function extractWithMinimax(
  query: string,
  evidence: EnrichmentEvidence[],
): Promise<EnrichmentDraft> {
  const evidenceText = evidence
    .map((e, i) => `[${i + 1}] ${e.title}\n${e.snippet}`)
    .join("\n\n");

  const systemPrompt = `你是一个中国机构信息抽取助手。根据用户查询和搜索结果，提取机构的结构化信息。机构类型包括但不限于：医院、大学、研究所、企业、政府机关等。

严格按以下 JSON 格式返回，不要包含其他文字：
{
  "canonicalName": "机构标准全称",
  "address": "总部/主院区通讯地址或null",
  "aliases": ["常用简称1", "常用简称2"],
  "sites": [{"siteName": "分支/院区/校区名称", "address": "地址或null"}],
  "confidence": 0.85
}

规则：
- canonicalName 必须是官方全称
- aliases 只包含广泛使用的简称/别称，不要编造
- sites 应尽量完整地列出该机构的院区、校区、分院、分部、分支机构等。医院通常有多个院区（如总院、分院、东院、西院、南院等），大学通常有多个校区，研究所可能有多个园区。根据搜索结果中能找到的信息尽量补全，每个 site 尽量附带地址
- confidence 反映信息可靠程度（0-1）
- 如果搜索结果不足以确定，confidence 应低于 0.5`;

  const userMessage = `查询: ${query}\n\n搜索结果:\n${evidenceText}`;

  const res = await fetch(`${MINIMAX_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MINIMAX_API_KEY}`,
    },
    body: JSON.stringify({
      model: MINIMAX_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.1,
      max_tokens: 1024,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MiniMax API error: ${res.status} ${text}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  // Strip MiniMax <think> tags and markdown code blocks
  let jsonStr = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  jsonStr = jsonStr.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    const match = jsonStr.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
    else throw new Error("无法从 AI 返回中提取 JSON");
  }

  return {
    canonicalName: parsed.canonicalName || query,
    address: parsed.address || null,
    aliases: Array.isArray(parsed.aliases) ? parsed.aliases.filter(Boolean).slice(0, 10) : [],
    sites: Array.isArray(parsed.sites)
      ? parsed.sites
          .filter((s: { siteName?: string }) => s.siteName)
          .slice(0, 10)
          .map((s: { siteName: string; address?: string }) => ({
            siteName: s.siteName,
            address: s.address || null,
          }))
      : [],
    confidence: Math.min(1, Math.max(0, parsed.confidence || 0)),
  };
}
