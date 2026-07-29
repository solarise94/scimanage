"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectDisplay,
} from "@/components/ui/select";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable } from "@/components/ui/data-table";
import { MobileCard } from "@/components/ui/mobile-card";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { MoneyText } from "@/components/ui/money-text";
import { useMediaQuery } from "@/hooks/use-media-query";
import { canAccessCosting } from "@/lib/role-guards";

interface CostEntry {
  id: string;
  subjectType: string;
  orderId: string | null;
  order: { id: string; orderNo: string; title: string } | null;
  bucket: string;
  costType: string;
  status: string;
  amount: number;
  sourceType: string;
  remark: string | null;
  occurredAt: string;
  supplier: { id: string; name: string } | null;
}

const BUCKET_LABELS: Record<string, string> = {
  REAL: "真实成本",
  CIRCULATION: "流通成本",
  TAX: "税费",
};

const STATUS_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  ESTIMATED: { label: "预测", variant: "secondary" },
  QUOTED: { label: "报价", variant: "secondary" },
  COMMITTED: { label: "已承诺", variant: "default" },
  ACTUAL: { label: "实际", variant: "default" },
  SETTLED: { label: "已结清", variant: "default" },
  CANCELLED: { label: "已取消", variant: "destructive" },
};

export default function CostLedgerPage() {
  return (
    <Suspense
      fallback={
        <PageShell>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64" />
        </PageShell>
      }
    >
      <CostLedgerContent />
    </Suspense>
  );
}

function CostLedgerContent() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const sp = useSearchParams();
  const isDesktop = useMediaQuery("(min-width: 768px)");

  const [orderId, setOrderId] = useState(sp.get("orderId") || "");
  const [bucket, setBucket] = useState(sp.get("bucket") || "");
  const [entryStatus, setEntryStatus] = useState(sp.get("status") || "");
  const [sourceType, setSourceType] = useState(sp.get("sourceType") || "");

  const { data, isLoading } = useQuery({
    queryKey: ["costing", "entries", orderId, bucket, entryStatus, sourceType],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (orderId) params.set("orderId", orderId);
      if (bucket) params.set("bucket", bucket);
      if (entryStatus) params.set("status", entryStatus);
      if (sourceType) params.set("sourceType", sourceType);
      params.set("pageSize", "100");
      const res = await fetch(`/api/costing/entries?${params}`);
      if (!res.ok) throw new Error("加载失败");
      return res.json();
    },
    enabled: status === "authenticated",
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
  if (!canAccessCosting(session.user.role)) {
    router.push("/dashboard");
    return null;
  }

  const entries: CostEntry[] = data?.entries ?? [];
  const totalAmount = entries.reduce((s, e) => s + e.amount, 0);

  return (
    <PageShell>
      <PageHeader
        title="成本台账"
        description="全部成本条目明细"
        backHref="/costing"
        backLabel="返回成本核算"
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="订单 ID 筛选"
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            className="pl-8"
          />
        </div>
        <Select value={bucket} onValueChange={(v) => { setBucket(v ?? ""); }}>
          <SelectTrigger className="w-[140px]">
            <SelectDisplay label="成本桶" valueLabel={bucket ? (BUCKET_LABELS[bucket] || bucket) : "全部"} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">全部</SelectItem>
            <SelectItem value="REAL">真实成本</SelectItem>
            <SelectItem value="CIRCULATION">流通成本</SelectItem>
            <SelectItem value="TAX">税费</SelectItem>
          </SelectContent>
        </Select>
        <Select value={entryStatus} onValueChange={(v) => { setEntryStatus(v ?? ""); }}>
          <SelectTrigger className="w-[140px]">
            <SelectDisplay label="状态" valueLabel={entryStatus ? (STATUS_LABELS[entryStatus]?.label || entryStatus) : "全部"} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">全部</SelectItem>
            <SelectItem value="ESTIMATED">预测</SelectItem>
            <SelectItem value="QUOTED">报价</SelectItem>
            <SelectItem value="COMMITTED">已承诺</SelectItem>
            <SelectItem value="ACTUAL">实际</SelectItem>
            <SelectItem value="SETTLED">已结清</SelectItem>
            <SelectItem value="CANCELLED">已取消</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card className="p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">共 {entries.length} 条</span>
          <span>合计：<MoneyText value={totalAmount} className="font-medium" /></span>
        </div>
      </Card>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : entries.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">暂无成本数据</Card>
      ) : isDesktop ? (
        <DataTable
          data={entries}
          keyExtractor={(e) => e.id}
          columns={[
            { key: "occurredAt", header: "日期", render: (e) => new Date(e.occurredAt).toLocaleDateString("zh-CN") },
            { key: "bucket", header: "桶", render: (e) => <Badge variant="outline">{BUCKET_LABELS[e.bucket] || e.bucket}</Badge> },
            { key: "costType", header: "类型", render: (e) => e.costType },
            { key: "amount", header: "金额", money: true, align: "right" },
            { key: "status", header: "状态", render: (e) => {
              const st = STATUS_LABELS[e.status] ?? { label: e.status, variant: "secondary" as const };
              return <Badge variant={st.variant}>{st.label}</Badge>;
            } },
            { key: "sourceType", header: "来源", render: (e) => <span className="text-xs text-muted-foreground">{e.sourceType}</span> },
            { key: "supplier", header: "供应商", render: (e) => e.supplier?.name || "—" },
            { key: "order", header: "订单", render: (e) => e.order?.orderNo || "—" },
          ]}
        />
      ) : (
        <div className="space-y-2">
          {entries.map((e) => {
            const st = STATUS_LABELS[e.status] ?? { label: e.status, variant: "secondary" as const };
            return (
              <MobileCard
                key={e.id}
                title={`${BUCKET_LABELS[e.bucket] || e.bucket} · ${e.costType}`}
                badge={<Badge variant={st.variant}>{st.label}</Badge>}
                subtitle={e.supplier?.name || "无供应商"}
                metrics={[
                  { label: "金额", value: <MoneyText value={e.amount} className="font-medium" /> },
                  { label: "日期", value: new Date(e.occurredAt).toLocaleDateString("zh-CN") },
                ]}
              />
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
