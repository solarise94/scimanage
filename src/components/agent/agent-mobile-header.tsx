"use client";

import { Menu, Plus, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMobileNavStore } from "@/lib/stores/mobile-nav-store";
import {
  RUNTIME_STATUS_COLORS,
  RUNTIME_STATUS_LABELS,
  type AgentRuntimeStatus,
} from "@/lib/agent/runtime-status";

// Re-export so existing imports (`type AgentRuntimeStatus` from this module) keep
// working; the canonical definition lives in the shared lib (docs Part 1 §1.3).
export type { AgentRuntimeStatus };

/**
 * Agent 移动端顶部浮件（docs Part 2 §2.1）。
 *
 * 由原先的 sticky 通栏 header 改造为三个悬浮控件，覆盖在消息流之上：
 * - 左：圆形浮动按钮 ☰ → 打开导航抽屉（openDrawer 不变）；
 * - 中：标题 pill（SciManage Agent + ChevronDown + runtime 状态点）→ 打开
 *   session sheet（onOpenSessions 不变）；MVP 常驻，不做滚动隐藏；
 * - 右：圆形浮动按钮 ＋ → 新会话（onNewSession + disabled=busy 不变）。
 *
 * 本组件自带 absolute overlay 容器（top-0 inset-x-0 z-20 + safe-area paddingTop），
 * 父级（agent-mobile-shell.tsx）只需把它作为消息流容器的兄弟节点放入 relative 容器。
 */
export function AgentMobileHeader({
  runtimeStatus,
  onOpenSessions,
  onNewSession,
  busy,
}: {
  runtimeStatus: AgentRuntimeStatus;
  onOpenSessions: () => void;
  onNewSession: () => void;
  busy: boolean;
}) {
  const openDrawer = useMobileNavStore((s) => s.openDrawer);

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-2 px-3 pb-2 pt-2"
      style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)" }}
    >
      {/* Left: 圆形浮动菜单钮 */}
      <button
        type="button"
        onClick={openDrawer}
        aria-label="打开菜单"
        className={cn(
          "pointer-events-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/50 bg-background/80 shadow-sm backdrop-blur transition-colors hover:bg-muted/70",
        )}
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Center: 标题 pill */}
      <button
        type="button"
        onClick={onOpenSessions}
        className="pointer-events-auto flex shrink-0 items-center gap-2 rounded-full bg-background/80 px-3 py-1.5 shadow-sm backdrop-blur transition-colors hover:bg-muted/70"
      >
        <span className="text-sm font-semibold">SciManage Agent</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        <span
          className={cn("h-2 w-2 rounded-full", RUNTIME_STATUS_COLORS[runtimeStatus])}
          title={`Runtime ${RUNTIME_STATUS_LABELS[runtimeStatus]}`}
        />
      </button>

      {/* Right: 圆形浮动新会话钮 */}
      <button
        type="button"
        onClick={onNewSession}
        disabled={busy}
        aria-label="新建会话"
        className={cn(
          "pointer-events-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/50 bg-background/80 shadow-sm backdrop-blur transition-colors hover:bg-muted/70",
          busy && "pointer-events-none opacity-50",
        )}
      >
        <Plus className="h-5 w-5" />
      </button>
    </div>
  );
}
