/**
 * Agent 运行时状态三态（docs Part 1 §1.3）。
 *
 * 双端（桌面 workbench / 移动 shell）共享同一份类型与样式映射，消除排障信息
 * 不对称。移动端 `agent-mobile-header.tsx` 与桌面端 `chat-panel.tsx` 顶栏均
 * 渲染该状态点。
 *
 * - available  : pi 流式正常（默认）。
 * - degraded   : runtime 不可用，已回退 legacy（非流式，每页一次提示）。
 * - unavailable: 网络/服务异常，本次未返回结果。
 */
export type AgentRuntimeStatus = "available" | "degraded" | "unavailable";

export const RUNTIME_STATUS_COLORS: Record<AgentRuntimeStatus, string> = {
  available: "bg-emerald-500",
  degraded: "bg-amber-500",
  unavailable: "bg-rose-500",
};

export const RUNTIME_STATUS_LABELS: Record<AgentRuntimeStatus, string> = {
  available: "可用",
  degraded: "降级",
  unavailable: "不可用",
};
