export interface RuntimeConfig {
  host: string;
  port: number;
  token: string;
  provider: "minimax";
  model: string;
  minimaxBaseUrl: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  contextWindowTokens: number;
  keepRecentTokens: number;
  compactionTriggerTokens: number;
  /**
   * Phase A 动态工具 bundle（≤15 tools/turn，3-hop 自动链）。
   * 默认 false：runtime 用 chat-stream 一次性传来的 request.availableTools，行为字节级不变。
   * true：runtime 启动前 + 每个 tool turn 后用 bridge token 调 Next /api/agent/tools/select-bundle
   * 取最新 ≤15 bundle，并改调 /api/agent/tools/execute-public（只认 publicToolKey）。
   * 仅在 B 的只读 facade + execute-public 端到端测试绿后才应在受控环境打开。
   */
  dynamicToolBundlesEnabled: boolean;
  /**
   * 仓库唯一的 build 版本标识，复用 `APP_BUILD_VERSION`（与 next.config.ts / build-version
   * route 同源）。runtime `/health` 与 `/chat-stream` SSE header 暴露它，Next.js 在读取任何
   * runtime body 字节前校验一致性，mismatch → 503 STREAM_TRANSPORT_MISMATCH（design §6.1）。
   * 不得另建一套 runtime release id。缺省为 `"development"`。
   */
  appBuildVersion: string;
}

export function getRuntimeConfig(): RuntimeConfig {
  const token = process.env.AGENT_RUNTIME_TOKEN?.trim();
  if (!token) {
    if (process.env.NODE_ENV === "production") {
      console.error("[agent-runtime] FATAL: AGENT_RUNTIME_TOKEN must be set in production.");
      process.exit(1);
    }
    console.warn("[agent-runtime] AGENT_RUNTIME_TOKEN not set, using insecure dev-only token.");
  }
  const appBuildVersion = (process.env.APP_BUILD_VERSION || process.env.NEXT_PUBLIC_APP_BUILD_VERSION || "development").trim() || "development";
  return {
    host: process.env.AGENT_RUNTIME_HOST || "127.0.0.1",
    port: Number(process.env.AGENT_RUNTIME_PORT || "31110"),
    token: token || "dev-agent-runtime-token",
    provider: "minimax",
    model: process.env.MINIMAX_MODEL || "MiniMax-M2.7",
    minimaxBaseUrl: process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com/v1",
    thinkingLevel: (
      process.env.AGENT_RUNTIME_THINKING_LEVEL === "off" ||
      process.env.AGENT_RUNTIME_THINKING_LEVEL === "minimal" ||
      process.env.AGENT_RUNTIME_THINKING_LEVEL === "low" ||
      process.env.AGENT_RUNTIME_THINKING_LEVEL === "high" ||
      process.env.AGENT_RUNTIME_THINKING_LEVEL === "xhigh"
    )
      ? process.env.AGENT_RUNTIME_THINKING_LEVEL
      : "medium",
    contextWindowTokens: Number(process.env.AGENT_CONTEXT_WINDOW_TOKENS || "1000000"),
    keepRecentTokens: Number(process.env.AGENT_COMPACTION_KEEP_RECENT_TOKENS || "12000"),
    compactionTriggerTokens: Number(process.env.AGENT_COMPACTION_TRIGGER_TOKENS || "400000"),
    dynamicToolBundlesEnabled: process.env.AGENT_DYNAMIC_TOOL_BUNDLES_ENABLED === "true",
    appBuildVersion,
  };
}
