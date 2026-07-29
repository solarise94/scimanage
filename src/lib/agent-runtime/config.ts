declare global {
  var __agentRuntimeDevToken: string | undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (!value) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

export function getAgentRuntimeMode(): "legacy" | "pi" {
  return process.env.AGENT_RUNTIME === "pi" ? "pi" : "legacy";
}

export function isPiAgentRuntimeEnabled() {
  return getAgentRuntimeMode() === "pi";
}

export function getAgentRuntimeBaseUrl() {
  return (process.env.AGENT_RUNTIME_URL || "http://127.0.0.1:31110").trim().replace(/\/+$/, "");
}

export function getAgentRuntimeToken() {
  const configured = process.env.AGENT_RUNTIME_TOKEN?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AGENT_RUNTIME_TOKEN must be set in production.");
  }
  if (!globalThis.__agentRuntimeDevToken) {
    globalThis.__agentRuntimeDevToken = "dev-agent-runtime-token";
    console.warn("[agent-runtime] AGENT_RUNTIME_TOKEN not set, using insecure dev-only token.");
  }
  return globalThis.__agentRuntimeDevToken;
}

export function isValidAgentRuntimeToken(token: string | null | undefined) {
  return Boolean(token && token === getAgentRuntimeToken());
}

export function getAgentRuntimeFlags() {
  return {
    compactionEnabled: parseBoolean(process.env.AGENT_COMPACTION_ENABLED, true),
    memoryEnabled: parseBoolean(process.env.AGENT_MEMORY_ENABLED, true),
    proactiveEnabled: parseBoolean(process.env.AGENT_PROACTIVE_ENABLED, false),
    viewControlEnabled: parseBoolean(process.env.AGENT_VIEW_CONTROL_ENABLED, false),
    webSearchEnabled: parseBoolean(process.env.AGENT_WEB_SEARCH_ENABLED, true),
    dynamicToolBundlesEnabled: process.env.AGENT_DYNAMIC_TOOL_BUNDLES_ENABLED === "true",
    contextWindowTokens: Number(process.env.AGENT_CONTEXT_WINDOW_TOKENS || "1000000"),
    keepRecentTokens: Number(process.env.AGENT_COMPACTION_KEEP_RECENT_TOKENS || "12000"),
  };
}
