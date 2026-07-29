"use client";

import { useState, Suspense } from "react";
import { useRouter } from "next/navigation";
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

interface Payable {
  id: string;
  supplier: { id: string; name: string } | null;
  order: { id: string; orderNo: string; title: string } | null;
  amount: number;
  paidAmount: number;
  status: string;
  dueAt: string | null;
  note: string | null;
  sourceType: string;
}

const STATUS_META: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  UNPAID: { label: "未付款", variant: "secondary" },
  PARTIAL: { label: "部分付款", variant: "default" },
  PAID: { label: "已付清", variant: "default" },
  OVERPAID: { label: "超付", variant: "destructive" },
  CANCELLED: { label: "已取消", variant: "destructive" },
};

export default function PayablesPage() {
  return (
    <Suspense
      fallback={
        <PageShell>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64" />
        </PageShell>
      }
    >
      <PayablesContent />
    </Suspense>
  );
}

function PayablesContent() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const isDesktop = useMediaQuery("(min-width: 768px)");

  const [supplierId, setSupplierId] = useState("");
  const [payableStatus, setPayableStatus] = useState("");

  const { data, isLoading } = useQuery<{ payables: Payable[]; total: number }>({
    queryKey: ["finance", "payables", supplierId, payableStatus],
    queryFn: async () => {
      const params = new URLSearchParams({ pageSize: "100" });
      if (supplierId.trim()) params.set("supplierId", supplierId.trim());
      if (payableStatus) params.set("status", payableStatus);
      const res = await fetch(`/api/finance/payables?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "加载失败");
      return json;
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
  if (session.user.role !== "ADMIN" && session.user.role !== "USER") {
    router.push("/dashboard");
    return null;
  }

  const payables: Payable[] = data?.payables ?? [];
  const totalAmount = payables.reduce((s, p) => s + p.amount, 0);
  const totalUnpaid = payables.reduce(
    (s, p) => s + Math.max(p.amount - p.paidAmount, 0),
    0,
  );

  return (
    <PageShell>
      <PageHeader
        title="供应商应付"
        description="按供应商与付款状态筛选应付账款"
        backHref="/finance"
        backLabel="返回财务"
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="供应商 ID 筛选"
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            className="pl-8"
          />
        </div>
        <Select value={payableStatus} onValueChange={(v) => { setPayableStatus(v ?? ""); }}>
          <SelectTrigger className="w-[140px]">
            <SelectDisplay
              label="状态"
              valueLabel={payableStatus ? (STATUS_META[payableStatus]?.label || payableStatus) : "全部"}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">全部</SelectItem>
            <SelectItem value="UNPAID">未付款</SelectItem>
            <SelectItem value="PARTIAL">部分付款</SelectItem>
            <SelectItem value="PAID">已付清</SelectItem>
            <SelectItem value="OVERPAID">超付</SelectItem>
            <SelectItem value="CANCELLED">已取消</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">共 {payables.length} 笔</span>
          <span>应付总额：<MoneyText value={totalAmount} className="font-medium" /></span>
          <span>未付余额：<MoneyText value={totalUnpaid} tone="warning" className="font-medium" /></span>
        </div>
      </Card>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : payables.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">暂无应付数据</Card>
      ) : isDesktop ? (
        <DataTable
          data={payables}
          keyExtractor={(p) => p.id}
          columns={[
            { key: "supplier", header: "供应商", render: (p) => p.supplier?.name || "—" },
            { key: "amount", header: "应付金额", money: true, align: "right" },
            { key: "paidAmount", header: "已付金额", money: true, align: "right" },
            {
              key: "status",
              header: "状态",
              render: (p) => {
                const meta = STATUS_META[p.status] ?? { label: p.status, variant: "secondary" as const };
                return <Badge variant={meta.variant}>{meta.label}</Badge>;
              },
            },
            {
              key: "dueAt",
              header: "到期日",
              render: (p) => (p.dueAt ? new Date(p.dueAt).toLocaleDateString("zh-CN") : "—"),
            },
            {
              key: "order",
              header: "订单",
              render: (p) => p.order?.orderNo || "—",
            },
          ]}
        />
      ) : (
        <div className="space-y-2">
          {payables.map((p) => {
            const meta = STATUS_META[p.status] ?? { label: p.status, variant: "secondary" as const };
            return (
              <MobileCard
                key={p.id}
                title={p.supplier?.name || "未知供应商"}
                badge={<Badge variant={meta.variant}>{meta.label}</Badge>}
                subtitle={p.order?.orderNo ? `订单：${p.order.orderNo}` : "无关联订单"}
                metrics={[
                  { label: "应付", value: <MoneyText value={p.amount} className="font-medium" /> },
                  { label: "已付", value: <MoneyText value={p.paidAmount} /> },
                  { label: "到期", value: p.dueAt ? new Date(p.dueAt).toLocaleDateString("zh-CN") : "—" },
                ]}
              />
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
