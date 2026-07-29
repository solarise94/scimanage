"use client";

import { Loader2, MessageSquare, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export interface AgentSessionSummary {
  id: string;
  agentRunId?: string | null;
  title?: string | null;
  status: string;
  lastMessageAt: string;
  messageCount: number;
}

function formatSessionTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Shared session list body (loading / empty / rows).  Used by the mobile
 * bottom Sheet and the desktop Popover so both stay in sync.
 */
export function AgentSessionList({
  sessions,
  activeSessionId,
  loading,
  onSelect,
  onDelete,
  compact = false,
}: {
  sessions: AgentSessionSummary[];
  activeSessionId: string | null;
  loading: boolean;
  onSelect: (sessionId: string) => void;
  /** 提供时每行显示删除按钮（确认逻辑由调用方处理）。 */
  onDelete?: (sessionId: string) => void;
  /** Desktop popover: slightly tighter rows. */
  compact?: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 justify-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        加载中
      </div>
    );
  }
  if (sessions.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        还没有历史会话
      </div>
    );
  }
  return (
    <div className="space-y-1">
      {sessions.map((session) => {
        const isActive = session.id === activeSessionId;
        return (
          <div
            key={session.id}
            className={cn(
              "group flex w-full items-center gap-1 rounded-xl pr-1 transition-colors",
              isActive ? "bg-primary/10" : "hover:bg-muted",
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(session.id)}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 text-left",
                compact ? "py-2" : "py-3",
              )}
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
                <MessageSquare className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {session.title?.trim() || "未命名会话"}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {formatSessionTime(session.lastMessageAt)}
                </div>
              </div>
              <Badge variant={isActive ? "secondary" : "outline"} className="shrink-0 rounded-md text-[10px]">
                {session.messageCount}
              </Badge>
            </button>
            {onDelete ? (
              <button
                type="button"
                onClick={() => onDelete(session.id)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:bg-rose-50 hover:text-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 md:focus-visible:opacity-100"
                aria-label="删除会话"
                title="删除会话"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Bottom sheet listing recent sessions.  Mobile-only chrome; the desktop
 * chat panel uses a Popover around {@link AgentSessionList} instead.
 */
export function AgentSessionSheet({
  open,
  onOpenChange,
  sessions,
  activeSessionId,
  loading,
  onSelect,
  onNewSession,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: AgentSessionSummary[];
  activeSessionId: string | null;
  loading: boolean;
  onSelect: (sessionId: string) => void;
  onNewSession: () => void;
  /** 提供时每行显示删除按钮（确认逻辑由调用方处理）。 */
  onDelete?: (sessionId: string) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="flex max-h-[75vh] flex-col rounded-t-3xl p-0"
      >
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="text-base">会话列表</SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-3 py-2">
          <AgentSessionList
            sessions={sessions}
            activeSessionId={activeSessionId}
            loading={loading}
            onSelect={onSelect}
            onDelete={onDelete}
          />
        </div>

        <div className="border-t p-3" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}>
          <Button
            className="w-full"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              onNewSession();
            }}
          >
            <Plus className="h-4 w-4" />
            新建会话
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
