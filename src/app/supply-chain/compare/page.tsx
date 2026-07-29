"use client";

import { useState, Suspense } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Sparkles, AlertCircle, CheckCircle2, Lock, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/ui/page-header";
import { MoneyText } from "@/components/ui/money-text";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { canAccessSupplyChain } from "@/lib/role-guards";
import { useConfirm } from "@/components/ui/confirm-dialog";

interface CandidateQuote {
  quoteId: string;
  supplierId: string;
  supplierName: string;
  unitCost: number;
  leadDays: number | null;
  discountRate: number | null;
}

interface CandidateLine {
  orderLineId: string;
  productSkuId: string | null;
  source?: "DIRECT" | "BOM";
  role?: string | null;
  itemName: string;
  spec: string | null;
  unit: string | null;
  quantity: number | null;
  serviceKey: string | null;
  needsConfirmation: boolean;
  quotes: CandidateQuote[];
  selectedQuote: CandidateQuote | null;
  lineAmount: number;
}

interface Candidate {
  orderId: string;
  planType: string;
  lines: CandidateLine[];
  totalQuotedCost: number;
  expectedLeadDays: number | null;
  supplierCount: number;
  readyToLock: boolean;
  blockingIssues: string[];
}

const PLAN_TYPE_OPTIONS = [
  { value: "LOWEST_COST", label: "最低成本" },
  { value: "FASTEST", label: "最快交付" },
  { value: "BALANCED", label: "均衡" },
] as const;

const PLAN_TYPE_LABELS: Record<string, string> = {
  LOWEST_COST: "最低成本",
  FASTEST: "最快交付",
  BALANCED: "均衡",
  MANUAL: "手工",
};

export default function ComparePage() {
  return (
    <Suspense
      fallback={
        <PageShell>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64" />
        </PageShell>
      }
    >
      <CompareContent />
    </Suspense>
  );
}

function CompareContent() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const { confirm } = useConfirm();
  const [orderId, setOrderId] = useState("");
  const [mode, setMode] = useState<string>("BALANCED");
  const [previewCandidate, setPreviewCandidate] = useState<Candidate | null>(null);
  const [savedPlanId, setSavedPlanId] = useState<string | null>(null);
  const [savedCandidate, setSavedCandidate] = useState<Candidate | null>(null);

  const previewMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/supply/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, mode, action: "preview" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "生成失败");
      return data as { candidate: Candidate };
    },
    onSuccess: (data) => {
      setPreviewCandidate(data.candidate);
      setSavedPlanId(null);
      setSavedCandidate(null);
    },
    onError: (e: Error) => {
      toast.error(e.message);
      setPreviewCandidate(null);
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/supply/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, mode, action: "create" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "保存失败");
      return data as { planId: string; candidate: Candidate };
    },
    onSuccess: (data) => {
      toast.success("方案已保存，请确认最终结果后锁定");
      setSavedPlanId(data.planId);
      setSavedCandidate(data.candidate);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const lockMutation = useMutation({
    mutationFn: async (planId: string) => {
      const res = await fetch(`/api/supply/plans/${planId}/lock`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "锁定失败");
      return data;
    },
    onSuccess: () => {
      toast.success("方案已锁定，已生成成本记录");
      setSavedPlanId(null);
      setPreviewCandidate(null);
      setSavedCandidate(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (status === "loading") {
    return (
      <PageShell>
        <Skeleton className="h-8 w-48" />
      </PageShell>
    );
  }
  if (!session) {
    router.push("/login");
    return null;
  }
  if (!canAccessSupplyChain(session.user.role)) {
    router.push("/dashboard");
    return null;
  }

  const handlePreview = () => {
    if (!orderId.trim()) {
      toast.error("请输入订单 ID");
      return;
    }
    previewMutation.mutate();
  };

  const handleSave = () => {
    createMutation.mutate();
  };

  const handleLock = async () => {
    if (!savedPlanId) return;
    const ok = await confirm({
      title: "锁定供应方案",
      description: "锁定后将生成成本记录（COMMITTED），且同订单不允许其他方案同时锁定。确定锁定？",
    });
    if (ok) lockMutation.mutate(savedPlanId);
  };

  // 优先展示保存后的最终结果（create 会重新执行候选生成）
  const displayCandidate = savedCandidate || previewCandidate;
  const isPreviewPhase = !savedPlanId;

  return (
    <PageShell>
      <PageHeader
        title="比价工具"
        description="生成供应方案候选并锁定"
        backHref="/supply-chain"
        backLabel="返回供应链"
      />

      <Card className="p-4 space-y-3">
        <div className="space-y-1.5">
          <Label>订单 ID</Label>
          <div className="flex gap-2">
            <Input
              placeholder="输入订单 ID"
              value={orderId}
              onChange={(e) => setOrderId(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handlePreview(); }}
            />
            <Select value={mode} onValueChange={(v) => v && setMode(v)}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLAN_TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={handlePreview} disabled={previewMutation.isPending}>
              {previewMutation.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-1 h-4 w-4" />
              )}
              生成候选
            </Button>
          </div>
        </div>
      </Card>

      {previewMutation.isPending && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {displayCandidate && !previewMutation.isPending && (
        <div className="space-y-4">
          {/* Summary */}
          <Card className="p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {displayCandidate.readyToLock ? (
                  <CheckCircle2 className="h-5 w-5 text-success" />
                ) : (
                  <AlertCircle className="h-5 w-5 text-warning" />
                )}
                <h3 className="text-sm font-medium">
                  {PLAN_TYPE_LABELS[displayCandidate.planType] || displayCandidate.planType} 方案
                  {savedPlanId ? " · 已保存" : " · 预览"}
                  {displayCandidate.readyToLock ? " · 可锁定" : " · 需处理"}
                </h3>
              </div>
              <span className="text-sm">
                合计：<MoneyText value={displayCandidate.totalQuotedCost} unit="cents" tone="expense" className="font-medium" />
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
              <span>涉及供应商：{displayCandidate.supplierCount} 家</span>
              <span>预计货期：{displayCandidate.expectedLeadDays != null ? `${displayCandidate.expectedLeadDays} 天` : "—"}</span>
              <span>订单行：{displayCandidate.lines.length} 行</span>
            </div>
          </Card>

          {/* Blocking issues */}
          {!displayCandidate.readyToLock && displayCandidate.blockingIssues.length > 0 && (
            <Card className="p-4 border-warning/40">
              <div className="flex items-center gap-2 mb-2">
                <AlertCircle className="h-4 w-4 text-warning" />
                <h3 className="text-sm font-medium">阻止锁定的问题</h3>
              </div>
              <ul className="space-y-2">
                {displayCandidate.blockingIssues.map((issue, idx) => (
                  <li key={idx} className="flex items-start gap-2 text-sm">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                    <span>{issue}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* Lines */}
          <div className="space-y-2">
            {displayCandidate.lines.map((line, idx) => (
              <Card key={`${line.orderLineId}:${line.productSkuId ?? line.serviceKey ?? idx}`} className="p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{line.itemName}</span>
                      {line.role === "INTERNAL" && (
                        <Badge variant="secondary">内部成本</Badge>
                      )}
                      {line.source === "BOM" && line.role !== "INTERNAL" && (
                        <Badge variant="outline">BOM</Badge>
                      )}
                      {line.needsConfirmation && (
                        <Badge variant="destructive">需确认服务项</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {line.serviceKey || line.productSkuId || "未映射"}
                      {line.spec ? ` · ${line.spec}` : ""}
                      {line.quantity != null ? ` · 数量 ${line.quantity}` : ""}
                    </p>
                  </div>
                  <span className="text-sm shrink-0">
                    <MoneyText value={line.lineAmount} unit="cents" tone="expense" className="font-medium" />
                  </span>
                </div>
                {line.selectedQuote ? (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>供应商：<span className="text-foreground font-medium">{line.selectedQuote.supplierName}</span></span>
                    <span>单价：<MoneyText value={line.selectedQuote.unitCost} unit="cents" /></span>
                    {line.selectedQuote.leadDays != null && <span>货期：{line.selectedQuote.leadDays} 天</span>}
                    <span>候选报价：{line.quotes.length} 条</span>
                  </div>
                ) : line.role === "INTERNAL" ? (
                  <div className="text-xs text-muted-foreground">
                    内部实验/人工组件，不强制供应商报价
                  </div>
                ) : (
                  <div className="flex items-center gap-1 text-xs text-warning">
                    <AlertCircle className="h-3.5 w-3.5" />
                    <span>无可用报价</span>
                  </div>
                )}
              </Card>
            ))}
          </div>

          {/* Actions */}
          <div className="flex gap-2 justify-end">
            {isPreviewPhase && displayCandidate.readyToLock && (
              <Button onClick={handleSave} disabled={createMutation.isPending}>
                {createMutation.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-1 h-4 w-4" />
                )}
                保存为方案
              </Button>
            )}
            {!isPreviewPhase && savedPlanId && (
              <Button onClick={handleLock} disabled={lockMutation.isPending || !displayCandidate.readyToLock}>
                {lockMutation.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Lock className="mr-1 h-4 w-4" />
                )}
                确认并锁定
              </Button>
            )}
          </div>
        </div>
      )}
    </PageShell>
  );
}
