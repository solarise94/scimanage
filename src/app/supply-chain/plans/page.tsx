"use client";

import { useState, Suspense } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Lock, XCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectDisplay,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable } from "@/components/ui/data-table";
import { MobileCard } from "@/components/ui/mobile-card";
import { MoneyText } from "@/components/ui/money-text";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { useMediaQuery } from "@/hooks/use-media-query";
import { canAccessSupplyChain } from "@/lib/role-guards";

interface SupplyPlan {
  id: string;
  name: string | null;
  status: string;
  planType: string;
  totalQuotedCost: number;
  expectedLeadDays: number | null;
  lockedAt: string | null;
  updatedAt: string;
  order: { id: string; orderNo: string; title: string | null } | null;
}

const STATUS_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "destructive" }> = {
  DRAFT: { label: "草稿", variant: "secondary" },
  QUOTED: { label: "已报价", variant: "default" },
  NEGOTIATING: { label: "协商中", variant: "default" },
  SELECTED: { label: "已选定", variant: "default" },
  LOCKED: { label: "已锁定", variant: "default" },
  SUPERSEDED: { label: "已替代", variant: "secondary" },
  CANCELLED: { label: "已取消", variant: "destructive" },
};

const STATUS_OPTIONS = Object.entries(STATUS_LABELS).map(([value, { label }]) => ({ value, label }));

const PLAN_TYPE_LABELS: Record<string, string> = {
  LOWEST_COST: "最低成本",
  FASTEST: "最快交付",
  BALANCED: "均衡",
  MANUAL: "手工",
};

export default function PlansPage() {
  return (
    <Suspense
      fallback={
        <PageShell>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64" />
        </PageShell>
      }
    >
      <PlansContent />
    </Suspense>
  );
}

function PlansContent() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { confirm } = useConfirm();
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const [orderId, setOrderId] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const params = new URLSearchParams();
  if (orderId) params.set("orderId", orderId);
  if (statusFilter) params.set("status", statusFilter);
  params.set("pageSize", "100");

  const queryKey = ["supply", "plans", orderId, statusFilter];

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await fetch(`/api/supply/plans?${params}`);
      if (!res.ok) throw new Error("加载失败");
      return res.json();
    },
    enabled: status === "authenticated",
  });

  const invalidatePlans = () => queryClient.invalidateQueries({ queryKey: ["supply", "plans"] });

  const lockMutation = useMutation({
    mutationFn: async (planId: string) => {
      const res = await fetch(`/api/supply/plans/${planId}/lock`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || "锁定失败");
      return d;
    },
    onSuccess: async () => {
      toast.success("方案已锁定");
      await invalidatePlans();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelMutation = useMutation({
    mutationFn: async (planId: string) => {
      const res = await fetch(`/api/supply/plans/${planId}/cancel`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || "取消失败");
      return d;
    },
    onSuccess: async () => {
      toast.success("方案已取消");
      await invalidatePlans();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleLock = async (planId: string) => {
    const ok = await confirm({
      title: "锁定供应方案",
      description: "锁定后将生成成本记录，且同订单不允许其他方案同时锁定。确定锁定？",
    });
    if (ok) lockMutation.mutate(planId);
  };

  const handleCancel = async (planId: string) => {
    const ok = await confirm({
      title: "取消供应方案",
      description: "取消后方案不可恢复。确定取消？",
    });
    if (ok) cancelMutation.mutate(planId);
  };

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

  const plans: SupplyPlan[] = data?.plans ?? [];

  return (
    <PageShell>
      <PageHeader
        title="供应方案"
        description="订单供应方案候选与锁定管理"
        backHref="/supply-chain"
        backLabel="返回供应链"
      />

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="订单 ID"
          value={orderId}
          onChange={(e) => setOrderId(e.target.value)}
          className="h-9 w-[160px] rounded-md border border-input bg-background px-3 text-sm"
        />
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v ?? ""); }}>
          <SelectTrigger className="w-[140px]">
            <SelectDisplay
              label="状态"
              valueLabel={statusFilter ? STATUS_LABELS[statusFilter]?.label : "全部"}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">全部</SelectItem>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : plans.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          暂无供应方案
        </Card>
      ) : isDesktop ? (
        <DataTable
          data={plans}
          keyExtractor={(p) => p.id}
          columns={[
            {
              key: "order",
              header: "订单号",
              render: (p) => p.order?.orderNo || "—",
            },
            {
              key: "status",
              header: "状态",
              render: (p) => {
                const st = STATUS_LABELS[p.status] ?? { label: p.status, variant: "secondary" as const };
                return <Badge variant={st.variant}>{st.label}</Badge>;
              },
            },
            {
              key: "planType",
              header: "方案类型",
              render: (p) => PLAN_TYPE_LABELS[p.planType] || p.planType,
            },
            {
              key: "totalQuotedCost",
              header: "报价总成本",
              align: "right",
              render: (p) => <MoneyText value={p.totalQuotedCost} tone="expense" />,
            },
            {
              key: "expectedLeadDays",
              header: "预计货期",
              render: (p) => (p.expectedLeadDays != null ? `${p.expectedLeadDays} 天` : "—"),
            },
            {
              key: "lockedAt",
              header: "锁定时间",
              render: (p) => p.lockedAt?.slice(0, 10) || "—",
            },
            {
              key: "actions",
              header: "操作",
              render: (p) => (
                <div className="flex gap-1">
                  {p.status === "DRAFT" && (
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleLock(p.id)}>
                      <Lock className="h-3 w-3 mr-1" />锁定
                    </Button>
                  )}
                  {p.status === "LOCKED" && (
                    <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={() => handleCancel(p.id)}>
                      <XCircle className="h-3 w-3 mr-1" />取消
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
        />
      ) : (
        <div className="space-y-2">
          {plans.map((p) => {
            const st = STATUS_LABELS[p.status] ?? { label: p.status, variant: "secondary" as const };
            return (
              <MobileCard
                key={p.id}
                title={p.order?.orderNo || "未知订单"}
                badge={<Badge variant={st.variant}>{st.label}</Badge>}
                subtitle={`${PLAN_TYPE_LABELS[p.planType] || p.planType} · 预计 ${p.expectedLeadDays != null ? `${p.expectedLeadDays} 天` : "—"}`}
                metrics={[
                  { label: "报价总成本", value: <MoneyText value={p.totalQuotedCost} tone="expense" /> },
                  { label: "锁定时间", value: p.lockedAt?.slice(0, 10) || "—" },
                ]}
              />
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
