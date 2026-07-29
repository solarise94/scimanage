"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { crmKeys } from "@/lib/crm/query-keys";
import {
  PREFERENCE_CATEGORY_LABELS,
  COMPLAINT_CATEGORY_LABELS,
  COMPLAINT_SEVERITY_LABELS,
  COMPLAINT_SEVERITY_COLORS,
  COMPLAINT_STATUS_LABELS,
  COMPLAINT_STATUS_COLORS,
} from "@/lib/crm/constants";
import { PreferenceFormDialog } from "@/components/crm/preference-form-dialog";
import { PreferenceInsightCard } from "@/components/crm/preference-insight-card";
import { ComplaintFormDialog } from "@/components/crm/complaint-form-dialog";
import { ComplaintDetailDialog } from "@/components/crm/complaint-detail-dialog";
import { CrmEmptyState } from "@/components/crm/empty-state";
import { toast } from "sonner";
import { Star, Sparkles, AlertCircle, Pin, Archive, RefreshCw } from "lucide-react";

interface CustomerPreferencePanelProps {
  profileId: string;
}

interface PreferenceItem {
  id: string;
  profileId: string;
  category: string;
  label: string;
  valueText: string | null;
  sourceType: string;
  confidence: number | null;
  evidenceType: string | null;
  status: string;
  reviewStatus: string;
  pinned: boolean;
  createdById: string;
  createdBy?: { name: string };
  updatedAt: string;
}

interface ComplaintItem {
  id: string;
  title: string;
  category: string;
  severity: string;
  status: string;
  ownerUserId: string | null;
  ownerUser?: { name: string } | null;
  expectedResolutionAt: string | null;
  updatedAt: string;
}

export function CustomerPreferencePanel({ profileId }: CustomerPreferencePanelProps) {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const [selectedComplaintId, setSelectedComplaintId] = useState<string | null>(null);
  const isAdmin = session?.user?.role === "ADMIN";

  const { data: prefData, isLoading: prefLoading } = useQuery({
    queryKey: crmKeys.preferences(profileId),
    queryFn: async () => {
      const res = await fetch(`/api/crm/profiles/${profileId}/preferences`);
      if (!res.ok) throw new Error("加载偏好失败");
      return res.json();
    },
  });

  const { data: complaintData } = useQuery({
    queryKey: crmKeys.complaints(profileId),
    queryFn: async () => {
      const res = await fetch(`/api/crm/profiles/${profileId}/complaints`);
      if (!res.ok) throw new Error("加载客诉失败");
      return res.json();
    },
  });

  const refreshInsightsMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/crm/profiles/${profileId}/preferences/refresh-insights`, {
        method: "POST",
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "刷新失败");
      }
      return res.json();
    },
    onSuccess: async (data) => {
      toast.success(`洞察已刷新（新建 ${data.created}，更新 ${data.updated}，跳过 ${data.skipped}）`);
      await queryClient.invalidateQueries({ queryKey: crmKeys.preferences(profileId) });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const archiveMutation = useMutation({
    mutationFn: async (preferenceId: string) => {
      const res = await fetch(`/api/crm/preferences/${preferenceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ARCHIVED" }),
      });
      if (!res.ok) throw new Error("归档失败");
      return res.json();
    },
    onSuccess: async () => {
      toast.success("已归档");
      await queryClient.invalidateQueries({ queryKey: crmKeys.preferences(profileId) });
      await queryClient.invalidateQueries({ queryKey: crmKeys.profile(profileId) });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const allPrefs: PreferenceItem[] = prefData?.preferences || [];
  const allComplaints: ComplaintItem[] = complaintData?.complaints || [];

  const manualPrefs = allPrefs.filter((p) => p.sourceType === "MANUAL" && p.status !== "ARCHIVED");
  // 自动洞察严格限定为 ORDER_RULE / INTERACTION_AI / SYSTEM，
  // 不含 COMPLAINT（客诉摘要单独展示在客诉区域）
  const AUTO_INSIGHT_SOURCES = ["ORDER_RULE", "INTERACTION_AI", "SYSTEM"];
  const autoInsights = allPrefs.filter((p) => AUTO_INSIGHT_SOURCES.includes(p.sourceType) && p.status === "ACTIVE");
  const dismissedInsights = allPrefs.filter((p) => AUTO_INSIGHT_SOURCES.includes(p.sourceType) && p.status === "DISMISSED");
  const complaintSummaries = allPrefs.filter((p) => p.sourceType === "COMPLAINT" && p.status === "ACTIVE");

  const openComplaints = allComplaints.filter((c) =>
    ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED"].includes(c.status),
  );
  const closedComplaints = allComplaints.filter((c) => ["CLOSED", "CANCELLED"].includes(c.status));

  return (
    <div className="space-y-6">
      {/* ── 人工标注 ── */}
      <section>
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-medium flex items-center gap-1.5">
            <Star className="h-4 w-4 text-primary" />
            人工标注
            <span className="text-xs text-muted-foreground">({manualPrefs.length})</span>
          </h3>
          <PreferenceFormDialog profileId={profileId} />
        </div>
        {prefLoading ? (
          <p className="text-sm text-muted-foreground">加载中...</p>
        ) : manualPrefs.length === 0 ? (
          <CrmEmptyState icon={Star} title="暂无人工偏好" description="点击上方按钮添加客户偏好" />
        ) : (
          <div className="space-y-2">
            {manualPrefs.map((p) => (
              <Card key={p.id}>
                <CardContent className="pt-3 pb-3">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <Badge variant="secondary">{PREFERENCE_CATEGORY_LABELS[p.category] || p.category}</Badge>
                    {p.pinned && <Pin className="h-3 w-3 text-primary" />}
                    <span className="text-xs text-muted-foreground ml-auto">
                      {new Date(p.updatedAt).toLocaleDateString("zh-CN")}
                    </span>
                  </div>
                  <p className="text-sm font-medium">{p.label}</p>
                  {p.valueText && <p className="text-sm text-muted-foreground break-words mt-0.5">{p.valueText}</p>}
                  {(isAdmin || p.createdById === session?.user?.id) && (
                  <div className="flex gap-1.5 mt-2">
                    <PreferenceFormDialog
                      profileId={profileId}
                      triggerVariant="inline"
                      editing={{
                        id: p.id,
                        category: p.category,
                        label: p.label,
                        valueText: p.valueText,
                        pinned: p.pinned,
                      }}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-muted-foreground"
                      onClick={() => archiveMutation.mutate(p.id)}
                    >
                      <Archive className="h-3 w-3 mr-1" />归档
                    </Button>
                  </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* ── 自动洞察 ── */}
      <section>
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-medium flex items-center gap-1.5">
            <Sparkles className="h-4 w-4 text-info" />
            自动洞察
            <span className="text-xs text-muted-foreground">({autoInsights.length})</span>
          </h3>
          {isAdmin && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => refreshInsightsMutation.mutate()}
              disabled={refreshInsightsMutation.isPending}
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${refreshInsightsMutation.isPending ? "animate-spin" : ""}`} />
              刷新洞察
            </Button>
          )}
        </div>
        {autoInsights.length === 0 && dismissedInsights.length === 0 ? (
          <CrmEmptyState
            icon={Sparkles}
            title="暂无自动洞察"
            description={isAdmin ? "点击「刷新洞察」从订单数据生成偏好洞察" : "需要管理员触发洞察刷新"}
          />
        ) : (
          <div className="space-y-2">
            {autoInsights.map((p) => (
              <PreferenceInsightCard
                key={p.id}
                preference={p}
                isAdmin={isAdmin}
              />
            ))}
            {dismissedInsights.length > 0 && (
              <details className="mt-2">
                <summary className="text-xs text-muted-foreground cursor-pointer">
                  已隐藏的洞察 ({dismissedInsights.length})
                </summary>
                <div className="space-y-2 mt-2 opacity-60">
                  {dismissedInsights.map((p) => (
                    <PreferenceInsightCard
                      key={p.id}
                      preference={p}
                      isAdmin={isAdmin}
                    />
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </section>

      {/* ── 客诉与处理 ── */}
      <section>
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-medium flex items-center gap-1.5">
            <AlertCircle className="h-4 w-4 text-warning" />
            客诉与处理
            <span className="text-xs text-muted-foreground">({allComplaints.length})</span>
          </h3>
          <ComplaintFormDialog profileId={profileId} />
        </div>

        {/* 未关闭客诉 */}
        {openComplaints.length > 0 && (
          <div className="mb-3">
            <p className="text-xs font-medium text-muted-foreground mb-2">未关闭 ({openComplaints.length})</p>
            <div className="space-y-2">
              {openComplaints.map((c) => (
                <ComplaintCard
                  key={c.id}
                  complaint={c}
                  onClick={() => setSelectedComplaintId(c.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* 历史客诉 */}
        {closedComplaints.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">历史客诉 ({closedComplaints.length})</p>
            <div className="space-y-2 opacity-75">
              {closedComplaints.map((c) => (
                <ComplaintCard
                  key={c.id}
                  complaint={c}
                  onClick={() => setSelectedComplaintId(c.id)}
                />
              ))}
            </div>
          </div>
        )}

        {allComplaints.length === 0 && complaintSummaries.length === 0 && (
          <CrmEmptyState icon={AlertCircle} title="暂无客诉记录" description="点击上方按钮新建客诉" />
        )}

        {/* 客诉摘要偏好 */}
        {complaintSummaries.length > 0 && (
          <div className="mt-4 pt-3 border-t">
            <p className="text-xs font-medium text-muted-foreground mb-2">客诉摘要（关闭后自动生成）</p>
            <div className="space-y-2">
              {complaintSummaries.map((p) => (
                <Card key={p.id}>
                  <CardContent className="pt-3">
                    <Badge variant="secondary" className="mb-1">{PREFERENCE_CATEGORY_LABELS[p.category]}</Badge>
                    <p className="text-sm font-medium">{p.label}</p>
                    {p.valueText && <p className="text-sm text-muted-foreground break-words mt-0.5">{p.valueText}</p>}
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* 客诉详情弹窗 */}
      {selectedComplaintId && (
        <ComplaintDetailDialog
          complaintId={selectedComplaintId}
          profileId={profileId}
          open={!!selectedComplaintId}
          onOpenChange={(v) => { if (!v) setSelectedComplaintId(null); }}
        />
      )}
    </div>
  );
}

function ComplaintCard({ complaint, onClick }: { complaint: ComplaintItem; onClick: () => void }) {
  return (
    <Card className="cursor-pointer hover:border-primary/30 transition-colors" >
      <CardContent className="pt-3 pb-3" onClick={onClick} >
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <Badge className={COMPLAINT_STATUS_COLORS[complaint.status] || "bg-muted"}>
            {COMPLAINT_STATUS_LABELS[complaint.status] || complaint.status}
          </Badge>
          <Badge className={COMPLAINT_SEVERITY_COLORS[complaint.severity] || "bg-muted"}>
            {COMPLAINT_SEVERITY_LABELS[complaint.severity] || complaint.severity}
          </Badge>
          <Badge variant="secondary">
            {COMPLAINT_CATEGORY_LABELS[complaint.category] || complaint.category}
          </Badge>
          <span className="text-xs text-muted-foreground ml-auto">
            {new Date(complaint.updatedAt).toLocaleDateString("zh-CN")}
          </span>
        </div>
        <p className="text-sm font-medium">{complaint.title}</p>
        {complaint.ownerUser && (
          <p className="text-xs text-muted-foreground mt-0.5">负责人：{complaint.ownerUser.name}</p>
        )}
      </CardContent>
    </Card>
  );
}
