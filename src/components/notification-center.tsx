"use client";

import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell, Check, CheckCheck, ClipboardCheck, Clock, Ticket, MessageSquare, Activity, AlertCircle, Mail, MailX, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { NotificationItem } from "@/lib/types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { formatDistanceToNow } from "date-fns";
import { zhCN } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const TYPE_ICONS: Record<string, React.ElementType> = {
  REMINDER: Clock,
  CRM_FOLLOW_UP_REMINDER: Clock,
  CRM_APPLICATION_REVIEW: ClipboardCheck,
  TICKET: Ticket,
  COMMENT: MessageSquare,
  STATUS: Activity,
  SYSTEM: AlertCircle,
};

const TYPE_COLORS: Record<string, string> = {
  REMINDER: "text-amber-500",
  CRM_FOLLOW_UP_REMINDER: "text-amber-500",
  CRM_APPLICATION_REVIEW: "text-orange-500",
  TICKET: "text-blue-500",
  COMMENT: "text-green-500",
  STATUS: "text-purple-500",
  SYSTEM: "text-slate-500",
};

const REMINDER_TYPES = new Set(["REMINDER", "CRM_FOLLOW_UP_REMINDER", "CRM_APPLICATION_REVIEW"]);

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const seenReminderIds = useRef<Set<string>>(
    new Set(JSON.parse(typeof window !== "undefined" ? sessionStorage.getItem("seenNotificationIds") || "[]" : "[]"))
  );

  const { data, isLoading } = useQuery<{ notifications: NotificationItem[]; unreadCount: number }>({
    queryKey: ["notifications"],
    queryFn: async () => {
      const res = await fetch("/api/notifications?limit=10");
      if (!res.ok) throw new Error("Failed to load notifications");
      return res.json();
    },
    refetchInterval: 30000,
  });

  // Toast for new unread reminder notifications
  useEffect(() => {
    if (!data?.notifications) return;
    for (const n of data.notifications) {
      if (!n.read && REMINDER_TYPES.has(n.type) && !seenReminderIds.current.has(n.id)) {
        seenReminderIds.current.add(n.id);
        try { sessionStorage.setItem("seenNotificationIds", JSON.stringify([...seenReminderIds.current])); } catch { /* ignore quota */ }
        toast(n.title, {
          description: n.content.length > 80 ? n.content.slice(0, 80) + "..." : n.content,
          action: {
            label: "查看",
            onClick: () => {
              fetch(`/api/notifications/${n.id}`, { method: "PATCH" }).catch(() => {});
              if (n.link) window.location.href = n.link;
            },
          },
          duration: 6000,
        });
      }
    }
  }, [data]);

  const markReadMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/notifications/${id}`, { method: "PATCH" });
      if (!res.ok) throw new Error("Failed to mark as read");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const markAllReadMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/notifications/read-all", { method: "PATCH" });
      if (!res.ok) throw new Error("Failed to mark all as read");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const retryEmailMutation = useMutation({
    mutationFn: async (notificationId: string) => {
      const res = await fetch("/api/notifications/retry-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationId }),
      });
      if (!res.ok) throw new Error("Failed to retry email");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const notifications = data?.notifications || [];
  const unreadCount = data?.unreadCount || 0;

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        className="relative"
        onClick={() => setOpen(!open)}
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-medium flex items-center justify-center">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/20 md:bg-transparent" onClick={() => setOpen(false)} />
          <Card className="fixed left-3 right-3 top-16 max-h-[70dvh] overflow-hidden md:absolute md:right-0 md:left-auto md:top-full md:mt-2 md:w-[360px] md:max-w-[calc(100vw-2rem)] md:max-h-none z-50 shadow-lg">
            <CardHeader className="p-3 pb-2 flex flex-row items-center justify-between">
              <span className="text-sm font-semibold">通知中心</span>
              {unreadCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => markAllReadMutation.mutate()}
                  disabled={markAllReadMutation.isPending}
                >
                  <CheckCheck className="mr-1 h-3 w-3" />
                  全部已读
                </Button>
              )}
            </CardHeader>
            <Separator />
            <CardContent className="p-0">
              {isLoading ? (
                <div className="p-4 text-center text-sm text-muted-foreground">加载中...</div>
              ) : notifications.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  <Bell className="mx-auto h-8 w-8 mb-2 opacity-40" />
                  暂无通知
                </div>
              ) : (
                <ScrollArea className="h-[320px]">
                  <div className="divide-y">
                    {notifications.map((n) => {
                      const Icon = TYPE_ICONS[n.type] || AlertCircle;
                      return (
                        <div
                          key={n.id}
                          className={cn(
                            "flex gap-3 p-3 hover:bg-muted/50 transition-colors cursor-pointer",
                            !n.read && "bg-muted/30"
                          )}
                          onClick={() => {
                            if (!n.read) markReadMutation.mutate(n.id);
                            if (n.link) { setOpen(false); window.location.href = n.link; }
                          }}
                        >
                          <div className={cn("mt-0.5 shrink-0", TYPE_COLORS[n.type] || "text-slate-500")}>
                            <Icon className="h-4 w-4" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2">
                              <p className={cn("text-sm", !n.read && "font-medium")}>{n.title}</p>
                              {!n.read && (
                                <span className="h-2 w-2 rounded-full bg-primary shrink-0 mt-1.5" />
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{n.content}</p>
                            <p className="text-[10px] text-muted-foreground mt-1">
                              {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true, locale: zhCN })}
                            </p>
                            {n.emailStatus === "sent" && (
                              <span className="inline-flex items-center gap-0.5 text-[10px] text-green-600 mt-0.5">
                                <Mail className="h-2.5 w-2.5" />邮件已发送
                              </span>
                            )}
                            {n.emailStatus === "pending" && (
                              <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-600 mt-0.5">
                                <Mail className="h-2.5 w-2.5" />邮件发送中
                              </span>
                            )}
                            {n.emailStatus === "failed" && (
                              <span className="inline-flex items-center gap-1 text-[10px] text-red-600 mt-0.5">
                                <MailX className="h-2.5 w-2.5" />
                                邮件发送失败
                                <button
                                  type="button"
                                  className="inline-flex items-center gap-0.5 text-blue-600 hover:underline"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    retryEmailMutation.mutate(n.id);
                                  }}
                                  disabled={retryEmailMutation.isPending}
                                >
                                  <RefreshCw className="h-2.5 w-2.5" />重发
                                </button>
                              </span>
                            )}
                          </div>
                          {!n.read && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 hover:opacity-100"
                              onClick={(e) => {
                                e.stopPropagation();
                                markReadMutation.mutate(n.id);
                              }}
                            >
                              <Check className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
