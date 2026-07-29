/**
 * Server-only UI feature-flag layer.
 *
 * Reads private environment variables on the server and exposes them as plain
 * booleans to client components.  Client components must NEVER read these env
 * vars directly — they receive the values as props from a Server Component or
 * server layout.
 *
 * Pattern mirrors `src/lib/agent-runtime/config.ts`.
 */

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (!value) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

export interface AgentUiConfig {
  /** Mobile Agent 入口与渲染是否启用。关闭时 /agent 跳转 /crm。 */
  mobileEnabled: boolean;
  /** 桌面 Agent UI 是否启用。关闭时桌面 /agent 跳转 /dashboard。 */
  desktopEnabled: boolean;
  /** GenUI 业务卡片是否启用。关闭时回退到安全文本/tool 状态。 */
  genuiEnabled: boolean;
}

export function getAgentUiConfig(): AgentUiConfig {
  return {
    mobileEnabled: parseBoolean(process.env.AGENT_MOBILE_ENABLED, true),
    desktopEnabled: parseBoolean(process.env.AGENT_DESKTOP_ENABLED, false),
    genuiEnabled: parseBoolean(process.env.AGENT_GENUI_ENABLED, true),
  };
}
