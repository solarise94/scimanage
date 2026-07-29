import type { SearchProvider } from "./types";

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || "";
const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com/v1";
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export class MinimaxSearchProvider implements SearchProvider {
  async search(params: { query: string; maxResults?: number }): Promise<{ results: SearchResult[] }> {
    const max = params.maxResults ?? 5;

    // Try MiniMax Token Plan search first
    if (MINIMAX_API_KEY) {
      try {
        return await this.minimaxSearch(params.query, max);
      } catch (e) {
        console.warn("MiniMax search failed, trying Tavily fallback:", e);
      }
    }

    // Fallback to Tavily
    if (TAVILY_API_KEY) {
      return this.tavilySearch(params.query, max);
    }

    return { results: [] };
  }

  private async minimaxSearch(query: string, max: number): Promise<{ results: SearchResult[] }> {
    const baseHost = MINIMAX_BASE_URL.replace(/\/v1\/?$/, "");
    const res = await fetch(`${baseHost}/v1/coding_plan/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MINIMAX_API_KEY}`,
      },
      body: JSON.stringify({ q: query }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MiniMax search 失败 (${res.status}): ${text}`);
    }

    const data = await res.json();
    const organic: Array<{ title?: string; link?: string; snippet?: string }> = data.organic || [];
    return {
      results: organic.slice(0, max).map((r) => ({
        title: r.title || "",
        url: r.link || "",
        snippet: r.snippet || "",
      })),
    };
  }

  private async tavilySearch(query: string, max: number): Promise<{ results: SearchResult[] }> {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: `${query} 机构 地址 官方信息`,
        max_results: max,
        search_depth: "basic",
      }),
    });

    if (!res.ok) throw new Error(`Tavily search 失败 (${res.status})`);

    const data = await res.json();
    const items: Array<{ title?: string; url?: string; content?: string }> = data.results || [];
    return {
      results: items.slice(0, max).map((r) => ({
        title: r.title || "",
        url: r.url || "",
        snippet: r.content || "",
      })),
    };
  }
}
