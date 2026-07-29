"use client";

import { type ReactNode } from "react";
import { CheckCircle2, Loader2, XCircle, AlertCircle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentUiState } from "../agent-ui-types";

const STATE_ICON: Record<AgentUiState, typeof CheckCircle2> = {
  loading: Loader2,
  loaded: CheckCircle2,
  draft: Clock,
  pending: Clock,
  saved: CheckCircle2,
  cancelled: XCircle,
  error: AlertCircle,
};

const STATE_ICON_CLASS: Record<AgentUiState, string> = {
  loading: "text-info animate-spin",
  loaded: "text-muted-foreground",
  draft: "text-muted-foreground",
  pending: "text-warning",
  saved: "text-success",
  cancelled: "text-muted-foreground",
  error: "text-danger",
};

const STATE_LABEL: Record<AgentUiState, string> = {
  loading: "加载中",
  loaded: "已加载",
  draft: "草稿",
  pending: "待确认",
  saved: "已保存",
  cancelled: "已取消",
  error: "出错",
};

/**
 * Shared card frame for all GenUI business cards.
 *
 * Flat style: borderless surface with a soft shadow (matches the app-wide
 * card language). Header shows title + quiet state label.
 */
export function CardShell({
  title,
  state,
  children,
  footer,
  className,
}: {
  title: string;
  state: AgentUiState;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const Icon = STATE_ICON[state];
  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-2xl bg-card shadow-sm",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-1">
        <div className="flex min-w-0 items-center gap-2">
          {state === "loading" || state === "error" ? (
            <Icon className={cn("h-3.5 w-3.5 shrink-0", STATE_ICON_CLASS[state])} />
          ) : null}
          <span className="truncate text-[15px] font-medium tracking-tight text-foreground">{title}</span>
        </div>
        <span className="shrink-0 text-[11px] text-muted-foreground/80">{STATE_LABEL[state]}</span>
      </div>
      {children ? <div className="px-4 py-3">{children}</div> : null}
      {footer ? <div className="px-4 pb-3.5 pt-0.5">{footer}</div> : null}
    </div>
  );
}

/** Minimal fallback card for unrecognized tool results. */
export function FallbackToolCard({
  actionKey,
  label,
  error,
}: {
  actionKey: string;
  label?: string;
  error?: string;
}) {
  return (
    <div className="w-full rounded-2xl bg-card px-4 py-3 text-xs shadow-sm">
      <div className="font-medium text-foreground">{label || actionKey}</div>
      {error ? <div className="mt-1 text-danger">{error}</div> : null}
    </div>
  );
}
