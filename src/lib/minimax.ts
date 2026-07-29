const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || "";
const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com/v1";
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || "MiniMax-M2.7";
const FALLBACK_MODEL = "MiniMax-M2.7";

export interface OrgMatchResult {
  organization: string;
  address: string | null;
  confidence: number;
}

export interface OrgSearchResponse {
  results: OrgMatchResult[];
  raw?: string;
  modelUsed?: string;
}

export function isMinimaxConfigured(): boolean {
  return !!MINIMAX_API_KEY;
}

async function callChatCompletion(
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<{ ok: boolean; status: number; content: string; modelNotSupported: boolean }> {
  const res = await fetch(`${MINIMAX_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MINIMAX_API_KEY}`,
    },
    body: JSON.stringify({
      model,
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
    const modelNotSupported = /not.?support.?model|model.*not.*found|invalid.*model/i.test(text);
    console.error(`MiniMax API error [model=${model}]:`, res.status, text);
    return { ok: false, status: res.status, content: text, modelNotSupported };
  }

  const data = await res.json();
  return {
    ok: true,
    status: res.status,
    content: data.choices?.[0]?.message?.content || "[]",
    modelNotSupported: false,
  };
}

function parseOrgResults(content: string): OrgMatchResult[] {
  const jsonStr = content.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  const parsed = JSON.parse(jsonStr) as Array<{
    organization: string;
    address: string | null;
    confidence: number;
  }>;

  return parsed
    .filter((r) => r.organization)
    .slice(0, 5)
    .map((r) => ({
      organization: r.organization,
      address: r.address || null,
      confidence: Math.min(1, Math.max(0, r.confidence || 0)),
    }));
}

const ORG_SYSTEM_PROMPT = `你是一个中国高校和科研机构名称标准化助手。用户会输入一个机构名称（可能是简称、别称或不完整的名称），你需要：
1. 识别用户想查找的机构
2. 返回最多 5 个最可能匹配的机构，按匹配度从高到低排列
3. 对每个机构给出标准全称、通讯地址（如果知道）、和匹配置信度（0-1）

严格按以下 JSON 格式返回，不要包含其他文字：
[{"organization":"标准全称","address":"通讯地址或null","confidence":0.95}]

如果完全无法识别，返回空数组 []。`;

/**
 * Use MiniMax chat completion to search and standardize organization names.
 * Tries configured model first; falls back to FALLBACK_MODEL on "model not supported".
 */
export async function searchOrganization(query: string): Promise<OrgSearchResponse> {
  if (!MINIMAX_API_KEY) {
    throw new Error("MiniMax API 未配置");
  }

  const primaryModel = MINIMAX_MODEL || FALLBACK_MODEL;
  let result = await callChatCompletion(primaryModel, ORG_SYSTEM_PROMPT, query);

  // Auto-retry with fallback model if primary is not supported
  let modelUsed = primaryModel;
  if (!result.ok && result.modelNotSupported && primaryModel !== FALLBACK_MODEL) {
    console.warn(`MiniMax model "${primaryModel}" not supported, retrying with "${FALLBACK_MODEL}"`);
    result = await callChatCompletion(FALLBACK_MODEL, ORG_SYSTEM_PROMPT, query);
    modelUsed = FALLBACK_MODEL;
  }

  if (!result.ok) {
    if (result.modelNotSupported) {
      throw new Error("当前 AI 模型配置不受套餐支持，请联系管理员更新 MiniMax 模型配置");
    }
    throw new Error(`MiniMax API 请求失败 (${result.status})`);
  }

  try {
    const results = parseOrgResults(result.content);
    return { results, raw: result.content, modelUsed };
  } catch {
    console.error("Failed to parse MiniMax response:", result.content);
    return { results: [], raw: result.content, modelUsed };
  }
}
