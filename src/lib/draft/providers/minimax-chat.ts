import type { ChatProvider } from "./types";

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || "";
const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com/v1";
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || "MiniMax-M2.7";
const FALLBACK_MODEL = "MiniMax-M2.7";

export class MinimaxChatProvider implements ChatProvider {
  async chat(params: {
    systemPrompt: string;
    userMessage: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ content: string }> {
    const primaryModel = MINIMAX_MODEL || FALLBACK_MODEL;
    let result = await this.callCompletion(primaryModel, params);

    if (!result.ok && result.modelNotSupported && primaryModel !== FALLBACK_MODEL) {
      result = await this.callCompletion(FALLBACK_MODEL, params);
    }

    if (!result.ok) {
      throw new Error(`MiniMax chat 请求失败 (${result.status})`);
    }

    return { content: result.content };
  }

  private async callCompletion(
    model: string,
    params: { systemPrompt: string; userMessage: string; temperature?: number; maxTokens?: number },
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
          { role: "system", content: params.systemPrompt },
          { role: "user", content: params.userMessage },
        ],
        temperature: params.temperature ?? 0.1,
        max_tokens: params.maxTokens ?? 2048,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const modelNotSupported = /not.?support.?model|model.*not.*found|invalid.*model/i.test(text);
      return { ok: false, status: res.status, content: text, modelNotSupported };
    }

    const data = await res.json();
    return {
      ok: true,
      status: res.status,
      content: data.choices?.[0]?.message?.content || "",
      modelNotSupported: false,
    };
  }
}
