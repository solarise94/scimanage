"use client";

import { useState } from "react";
import { FormSheet } from "@/components/ui/form-sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { crmKeys } from "@/lib/crm/query-keys";
import {
  COMPLAINT_CATEGORY_LABELS,
  COMPLAINT_SEVERITY_LABELS,
  COMPLAINT_SEVERITY_COLORS,
  COMPLAINT_STATUS_LABELS,
  COMPLAINT_STATUS_COLORS,
} from "@/lib/crm/constants";
import { ComplaintTimeline } from "@/components/crm/complaint-timeline";
import { toast } from "sonner";
import { Loader2, CheckCircle2, XCircle, RotateCcw, MessageSquarePlus } from "lucide-react";

interface ComplaintDetailDialogProps {
  complaintId: string;
  profileId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ComplaintDetailDialog({
  complaintId,
  profileId,
  open,
  onOpenChange,
}: ComplaintDetailDialogProps) {
  const queryClient = useQueryClient();
  const [eventContent, setEventContent] = useState("");
  const [showAddEvent, setShowAddEvent] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: crmKeys.complaintDetail(complaintId),
    queryFn: async () => {
      const res = await fetch(`/api/crm/complaints/${complaintId}`);
      if (!res.ok) throw new Error("加载失败");
      return res.json();
    },
    enabled: open,
  });

  const invalidateAll = async () => {
    const promises: Promise<void>[] = [
      queryClient.invalidateQueries({ queryKey: crmKeys.complaintDetail(complaintId) }),
      queryClient.invalidateQueries({ queryKey: crmKeys.complaints(profileId) }),
      queryClient.invalidateQueries({ queryKey: crmKeys.profile(profileId) }),
    ];
    await Promise.all(promises);
  };

  const actionMutation = useMutation({
    mutationFn: async (params: { action: string; body?: Record<string, unknown> }) => {
      const res = await fetch(`/api/crm/complaints/${complaintId}/${params.action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params.body || {}),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "操作失败");
      }
      return res.json();
    },
    onSuccess: async () => {
      await invalidateAll();
      setEventContent("");
      setShowAddEvent(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const addEventMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/crm/complaints/${complaintId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventType: "COMMENT", content: eventContent }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "添加失败");
      }
      return res.json();
    },
    onSuccess: async () => {
      toast.success("已添加处理记录");
      await invalidateAll();
      setEventContent("");
      setShowAddEvent(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const complaint = data?.complaint;

  return (
    <FormSheet
      open={open}
      onOpenChange={onOpenChange}
      title="客诉详情"
      desktopVariant="scrollable"
      desktopMaxW="sm:max-w-lg"
    >
      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !complaint ? (
        <p className="text-sm text-muted-foreground text-center py-8">客诉不存在或已被删除</p>
      ) : (
        <div className="space-y-4">
          {/* 基本信息 */}
          <Card>
            <CardContent className="pt-4 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge className={COMPLAINT_STATUS_COLORS[complaint.status] || "bg-muted"}>
                  {COMPLAINT_STATUS_LABELS[complaint.status] || complaint.status}
                </Badge>
                <Badge className={COMPLAINT_SEVERITY_COLORS[complaint.severity] || "bg-muted"}>
                  {COMPLAINT_SEVERITY_LABELS[complaint.severity] || complaint.severity}
                </Badge>
                <Badge variant="secondary">
                  {COMPLAINT_CATEGORY_LABELS[complaint.category] || complaint.category}
                </Badge>
              </div>
              <h3 className="text-base font-medium">{complaint.title}</h3>
              {complaint.description && (
                <p className="text-sm text-muted-foreground break-words whitespace-pre-wrap">
                  {complaint.description}
                </p>
              )}
              <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground pt-1">
                {complaint.ownerUser && (
                  <div>负责人：{complaint.ownerUser.name}</div>
                )}
                {complaint.expectedResolutionAt && (
                  <div>期望解决：{new Date(complaint.expectedResolutionAt).toLocaleDateString("zh-CN")}</div>
                )}
                {complaint.resolvedAt && (
                  <div>解决时间：{new Date(complaint.resolvedAt).toLocaleDateString("zh-CN")}</div>
                )}
                {complaint.closedAt && (
                  <div>关闭时间：{new Date(complaint.closedAt).toLocaleDateString("zh-CN")}</div>
                )}
                {complaint.customerSatisfied !== null && complaint.customerSatisfied !== undefined && (
                  <div>客户满意：{complaint.customerSatisfied ? "是" : "否"}</div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* 状态流转按钮 */}
          {(complaint.status === "OPEN" || complaint.status === "IN_PROGRESS" || complaint.status === "WAITING_CUSTOMER") && (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => actionMutation.mutate({ action: "resolve" })}
                disabled={actionMutation.isPending}
              >
                <CheckCircle2 className="h-3.5 w-3.5 mr-1" />标记解决
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => actionMutation.mutate({ action: "cancel" })}
                disabled={actionMutation.isPending}
              >
                <XCircle className="h-3.5 w-3.5 mr-1" />取消客诉
              </Button>
            </div>
          )}
          {complaint.status === "RESOLVED" && (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="default"
                onClick={() => actionMutation.mutate({ action: "close" })}
                disabled={actionMutation.isPending}
              >
                <CheckCircle2 className="h-3.5 w-3.5 mr-1" />关闭客诉
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => actionMutation.mutate({ action: "reopen" })}
                disabled={actionMutation.isPending}
              >
                <RotateCcw className="h-3.5 w-3.5 mr-1" />重新打开
              </Button>
            </div>
          )}
          {complaint.status === "CLOSED" && (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => actionMutation.mutate({ action: "reopen" })}
                disabled={actionMutation.isPending}
              >
                <RotateCcw className="h-3.5 w-3.5 mr-1" />重新打开
              </Button>
            </div>
          )}

          {/* 处理时间线 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">处理记录</CardTitle>
            </CardHeader>
            <CardContent>
              <ComplaintTimeline events={complaint.events || []} />
              {showAddEvent ? (
                <div className="mt-3 space-y-2 border-t pt-3">
                  <Textarea
                    value={eventContent}
                    onChange={(e) => setEventContent(e.target.value)}
                    placeholder="添加处理记录..."
                    rows={2}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => addEventMutation.mutate()}
                      disabled={addEventMutation.isPending || !eventContent.trim()}
                    >
                      提交
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setShowAddEvent(false); setEventContent(""); }}>
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-3 text-xs"
                  onClick={() => setShowAddEvent(true)}
                >
                  <MessageSquarePlus className="h-3.5 w-3.5 mr-1" />添加处理记录
                </Button>
              )}
            </CardContent>
          </Card>

          {/* 关闭时确认客户满意度 */}
          {actionMutation.isPending && (
            <p className="text-xs text-muted-foreground text-center">
              <Loader2 className="h-3 w-3 inline animate-spin mr-1" />处理中...
            </p>
          )}
        </div>
      )}
    </FormSheet>
  );
}
