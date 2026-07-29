"use client";

/**
 * TicketDetailView — shared ticket detail surface.
 *
 * Extracted from `src/app/tickets/[id]/page.tsx` so the same data loading,
 * mutations and four detail blocks can render either as the standalone page
 * (`mode="page"`) or embedded inside the Agent workspace Resource Panel /
 * Sheet (`mode="panel" | "sheet"`).
 *
 * Cache: shares the `["ticket", ticketId]` queryKey with the page so opening
 * the embedded view after viewing the page is instant and mutations on either
 * side refresh both.
 *
 * Navigation differences by mode:
 *   - PageHeader back arrow: only rendered in `page` mode.
 *   - Project link: `page` mode keeps the Next `<Link>`; panel/sheet mode
 *     goes through `useResourceNavigation().onNavigateResource` so it pushes
 *     onto the Agent resource history instead of leaving the workspace.
 *   - Delete success: `page` mode uses `router.push("/tickets")`; panel/sheet
 *     mode delegates to `useResourceNavigation().onNavigateHref?.("/tickets")`.
 *
 * All API, permissions and mutation logic is unchanged from the original page.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Ticket,
  Send,
  Loader2,
  ExternalLink,
  CheckCircle2,
  Circle,
  Clock,
  MoreHorizontal,
  Trash2,
  AlertCircle,
} from "lucide-react";
import { TicketItem, TicketReplyItem } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { zhCN } from "date-fns/locale";
import Link from "next/link";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  useResourceNavigation,
  type ResourceViewMode,
} from "@/components/agent/resource-navigation-context";

const PRIORITY_CONFIG: Record<
  string,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  LOW: { label: "低", variant: "secondary" },
  MEDIUM: { label: "中", variant: "default" },
  HIGH: { label: "高", variant: "destructive" },
  URGENT: { label: "紧急", variant: "destructive" },
};

const STATUS_CONFIG: Record<
  string,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive"; icon: React.ElementType }
> = {
  OPEN: { label: "打开", variant: "secondary", icon: Circle },
  IN_PROGRESS: { label: "处理中", variant: "default", icon: Clock },
  CLOSED: { label: "已关闭", variant: "outline", icon: CheckCircle2 },
};

export interface TicketDetailViewProps {
  ticketId: string;
  mode: ResourceViewMode;
}

export function TicketDetailView({ ticketId, mode }: TicketDetailViewProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { confirm } = useConfirm();
  const { onNavigateResource, onNavigateHref } = useResourceNavigation();
  const [reply, setReply] = useState("");

  const isEmbedded = mode !== "page";

  const { data, isLoading, error } = useQuery<{
    ticket: TicketItem;
    replies: TicketReplyItem[];
    permissions: { canContribute: boolean; canManage: boolean };
  }>({
    queryKey: ["ticket", ticketId],
    queryFn: async () => {
      const res = await fetch(`/api/tickets/${ticketId}`);
      if (!res.ok) throw new Error("Failed to load ticket");
      return res.json();
    },
  });

  const replyMutation = useMutation({
    mutationFn: async (content: string) => {
      const res = await fetch(`/api/tickets/${ticketId}/replies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error("Failed to post reply");
      return res.json();
    },
    onSuccess: () => {
      setReply("");
      queryClient.invalidateQueries({ queryKey: ["ticket", ticketId] });
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const statusMutation = useMutation({
    mutationFn: async (status: string) => {
      const res = await fetch(`/api/tickets/${ticketId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error("Failed to update status");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ticket", ticketId] });
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/tickets/${ticketId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete ticket");
    },
    onSuccess: () => {
      toast.success("工单已删除");
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
      // page mode: stay in the router; embedded mode: hand off to the
      // Agent resource navigator so it leaves the workspace to the list.
      if (isEmbedded) {
        onNavigateHref?.("/tickets");
      } else {
        router.push("/tickets");
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // --- Loading / error / empty states differ by mode ----------------------

  if (isLoading) {
    if (isEmbedded) {
      return (
        <div className="space-y-3 p-4">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      );
    }
    return (
      <PageShell>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 mt-4" />
        <Skeleton className="h-20 mt-4" />
      </PageShell>
    );
  }

  if (error && !data?.ticket) {
    if (isEmbedded) {
      return (
        <div className="p-4">
          <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
            <div className="flex items-center gap-2 font-medium">
              <AlertCircle className="h-4 w-4" />
              加载失败
            </div>
            <p className="mt-1 text-destructive/80">
              {error instanceof Error ? error.message : "请稍后重试"}
            </p>
          </div>
        </div>
      );
    }
  }

  if (!data?.ticket) {
    if (isEmbedded) {
      return (
        <div className="p-4">
          <div className="rounded-lg border p-6 text-center">
            <h2 className="text-base font-medium">工单不存在或无权访问</h2>
          </div>
        </div>
      );
    }
    return (
      <PageShell>
        <EmptyState icon={Ticket} title="工单不存在或无权访问" />
      </PageShell>
    );
  }

  const { ticket, replies, permissions } = data;
  const StatusIcon = STATUS_CONFIG[ticket.status]?.icon || Circle;
  const canContribute = permissions?.canContribute ?? false;
  const canManage = permissions?.canManage ?? false;

  const projectButton = ticket.project ? (
    isEmbedded ? (
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          onNavigateResource?.("project", ticket.project!.id, "打开项目")
        }
      >
        <ExternalLink className="h-4 w-4 mr-1" />项目
      </Button>
    ) : (
      <Link href={`/projects/${ticket.project.id}?tab=tickets`}>
        <Button variant="outline" size="sm">
          <ExternalLink className="h-4 w-4 mr-1" />项目
        </Button>
      </Link>
    )
  ) : null;

  const headerActions = (
    <div className="flex items-center gap-2">
      {projectButton}
      {canManage && (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="icon" className="h-11 w-11"><MoreHorizontal className="h-4 w-4" /></Button>} />
          <DropdownMenuContent align="end">
            {ticket.status !== "OPEN" && (
              <DropdownMenuItem onClick={() => statusMutation.mutate("OPEN")}>
                <Circle className="mr-2 h-4 w-4" />标记为打开
              </DropdownMenuItem>
            )}
            {ticket.status !== "IN_PROGRESS" && (
              <DropdownMenuItem onClick={() => statusMutation.mutate("IN_PROGRESS")}>
                <Clock className="mr-2 h-4 w-4" />标记为处理中
              </DropdownMenuItem>
            )}
            {ticket.status !== "CLOSED" && (
              <DropdownMenuItem onClick={() => statusMutation.mutate("CLOSED")}>
                <CheckCircle2 className="mr-2 h-4 w-4" />标记为已关闭
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              className="text-red-600"
              onClick={async () => {
                const ok = await confirm({ title: "删除工单", description: "确定要删除该工单吗？此操作不可撤销。" });
                if (ok) deleteMutation.mutate();
              }}
            >
              <Trash2 className="mr-2 h-4 w-4" />删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );

  const detailBody = (
    <>
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_CONFIG[ticket.status]?.variant || "secondary"}>
              <StatusIcon className="h-3 w-3 mr-1" />
              {STATUS_CONFIG[ticket.status]?.label || ticket.status}
            </Badge>
            <Badge variant={PRIORITY_CONFIG[ticket.priority]?.variant || "secondary"}>
              {PRIORITY_CONFIG[ticket.priority]?.label || ticket.priority}
            </Badge>
          </div>
          <div className="text-sm text-muted-foreground space-y-1">
            {ticket.project && <p>项目: {ticket.project.name}</p>}
            {ticket.assignee && <p>负责人: {ticket.assignee.name}</p>}
            <p>创建于 {formatDistanceToNow(new Date(ticket.createdAt), { addSuffix: true, locale: zhCN })}</p>
          </div>
          {ticket.description && (
            <div className="text-sm whitespace-pre-wrap border-t pt-3">{ticket.description}</div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h3 className="font-medium">回复 ({replies.length})</h3>
        {replies.length === 0 ? (
          <div className="text-sm text-muted-foreground">暂无回复</div>
        ) : (
          <div className="space-y-3">
            {replies.map((r) => (
              <Card key={r.id}>
                <CardContent className="p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Avatar className="h-6 w-6">
                      <AvatarFallback className="text-[10px]">{r.author.name?.slice(0, 2)?.toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <span className="text-sm font-medium">{r.author.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(r.createdAt), { addSuffix: true, locale: zhCN })}
                    </span>
                  </div>
                  <div className="text-sm whitespace-pre-wrap">{r.content}</div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {canContribute && (
        <div className="flex gap-2">
          <Textarea
            placeholder="输入回复..."
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            className="min-h-[80px] resize-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (reply.trim()) replyMutation.mutate(reply);
              }
            }}
          />
          <Button
            size="icon"
            className="shrink-0 h-10 w-10 self-stretch"
            disabled={!reply.trim() || replyMutation.isPending}
            onClick={() => replyMutation.mutate(reply)}
            aria-label="发送回复"
          >
            {replyMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      )}
    </>
  );

  // --- Render by mode -----------------------------------------------------

  if (isEmbedded) {
    // Compact container suitable for Panel/Sheet — no PageShell, no back arrow.
    return (
      <div className="flex flex-col gap-3 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground truncate">
              {ticket.title}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              工单
            </div>
          </div>
          {headerActions}
        </div>
        {detailBody}
      </div>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title={ticket.title}
        backHref="/tickets"
        backLabel="返回工单列表"
        actions={headerActions}
      />
      {detailBody}
    </PageShell>
  );
}
