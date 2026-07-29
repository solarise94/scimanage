"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { crmKeys } from "@/lib/crm/query-keys";
import {
  PREFERENCE_CATEGORY_LABELS,
  PREFERENCE_REVIEW_STATUS_LABELS,
} from "@/lib/crm/constants";
import { toast } from "sonner";
import { Pin, PinOff, Check, X, Copy } from "lucide-react";

interface InsightCardProps {
  preference: {
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
  };
  isAdmin?: boolean;
}

export function PreferenceInsightCard({ preference, isAdmin }: InsightCardProps) {
  const queryClient = useQueryClient();

  const patchMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await fetch(`/api/crm/preferences/${preference.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "操作失败");
      }
      return res.json();
    },
    onSuccess: async () => {
      const promises: Promise<void>[] = [
        queryClient.invalidateQueries({ queryKey: crmKeys.preferences(preference.profileId) }),
      ];
      promises.push(queryClient.invalidateQueries({ queryKey: crmKeys.profile(preference.profileId) }));
      await Promise.all(promises);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const convertToManual = useMutation({
    mutationFn: async () => {
      // 单事务原子操作：创建人工偏好 + 原洞察标 SUPERSEDED
      const res = await fetch(`/api/crm/preferences/${preference.id}/convert-to-manual`, {
        method: "POST",
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "转换失败");
      }
      return res.json();
    },
    onSuccess: async () => {
      toast.success("已转为人工偏好");
      const promises: Promise<void>[] = [
        queryClient.invalidateQueries({ queryKey: crmKeys.preferences(preference.profileId) }),
      ];
      promises.push(queryClient.invalidateQueries({ queryKey: crmKeys.profile(preference.profileId) }));
      await Promise.all(promises);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const isDismissed = preference.status === "DISMISSED";
  const isAccepted = preference.reviewStatus === "ACCEPTED";

  return (
    <Card className={isDismissed ? "opacity-50" : ""}>
      <CardContent className="pt-4 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="secondary">{PREFERENCE_CATEGORY_LABELS[preference.category] || preference.category}</Badge>
          {preference.confidence != null && (
            <span className="text-xs text-muted-foreground">
              置信度 {Math.round(preference.confidence * 100)}%
            </span>
          )}
          {isAccepted && (
            <Badge className="bg-success-bg text-success">已采纳</Badge>
          )}
          {isDismissed && <Badge variant="outline">已隐藏</Badge>}
          {preference.pinned && <Pin className="h-3 w-3 text-primary" />}
          <span className="text-xs text-muted-foreground ml-auto">
            {PREFERENCE_REVIEW_STATUS_LABELS[preference.reviewStatus] || preference.reviewStatus}
          </span>
        </div>
        <p className="text-sm font-medium">{preference.label}</p>
        {preference.valueText && (
          <p className="text-sm text-muted-foreground break-words">{preference.valueText}</p>
        )}
        {preference.evidenceType && (
          <p className="text-xs text-muted-foreground">
            证据来源：{preference.evidenceType}
          </p>
        )}
        <div className="flex flex-wrap gap-1.5 pt-1">
          {!isAccepted && !isDismissed && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => patchMutation.mutate({ reviewStatus: "ACCEPTED" })}
              disabled={patchMutation.isPending}
            >
              <Check className="h-3 w-3 mr-1" />采纳
            </Button>
          )}
          {!isDismissed ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-muted-foreground"
              onClick={() => patchMutation.mutate({ status: "DISMISSED", reviewStatus: "REJECTED" })}
              disabled={patchMutation.isPending}
            >
              <X className="h-3 w-3 mr-1" />隐藏
            </Button>
          ) : (
            isAdmin ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => patchMutation.mutate({ status: "ACTIVE" })}
                disabled={patchMutation.isPending}
              >
                恢复
              </Button>
            ) : null
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => patchMutation.mutate({ pinned: !preference.pinned })}
            disabled={patchMutation.isPending}
          >
            {preference.pinned ? <PinOff className="h-3 w-3 mr-1" /> : <Pin className="h-3 w-3 mr-1" />}
            {preference.pinned ? "取消置顶" : "置顶"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => convertToManual.mutate()}
            disabled={convertToManual.isPending}
          >
            <Copy className="h-3 w-3 mr-1" />转人工
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
