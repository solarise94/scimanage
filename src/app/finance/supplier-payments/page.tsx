"use client";

import { useState, Suspense } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable } from "@/components/ui/data-table";
import { MobileCard } from "@/components/ui/mobile-card";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { MoneyText } from "@/components/ui/money-text";
import { useMediaQuery } from "@/hooks/use-media-query";

interface PaymentAllocation {
  id: string;
  amount: number;
  payable: { id: string; amount: number; orderId: string | null } | null;
}
interface SupplierPayment {
  id: string;
  supplier: { id: string; name: string } | null;
  amount: number;
  paidAt: string;
  method: string | null;
  voucherNo: string | null;
  remark: string | null;
  allocations: PaymentAllocation[];
}

const METHOD_LABELS: Record<string, string> = {
  BANK_TRANSFER: "银行转账",
  ALIPAY: "支付宝",
  WECHAT_PAY: "微信支付",
  CASH: "现金",
  CHECK: "支票",
  OTHER: "其他",
};

export default function SupplierPaymentsPage() {
  return (
    <Suspense
      fallback={
        <PageShell>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64" />
        </PageShell>
      }
    >
      <SupplierPaymentsContent />
    </Suspense>
  );
}

function SupplierPaymentsContent() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const isDesktop = useMediaQuery("(min-width: 768px)");

  const [supplierId, setSupplierId] = useState("");

  const { data, isLoading } = useQuery<{ payments: SupplierPayment[]; total: number }>({
    queryKey: ["finance", "supplier-payments", supplierId],
    queryFn: async () => {
      const params = new URLSearchParams({ pageSize: "100" });
      if (supplierId.trim()) params.set("supplierId", supplierId.trim());
      const res = await fetch(`/api/finance/supplier-payments?${params}`);
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

  const payments: SupplierPayment[] = data?.payments ?? [];
  const totalAmount = payments.reduce((s, p) => s + p.amount, 0);

  return (
    <PageShell>
      <PageHeader
        title="供应商付款流水"
        description="按供应商筛选付款记录及核销明细"
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
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">共 {payments.length} 笔</span>
          <span>付款总额：<MoneyText value={totalAmount} className="font-medium" /></span>
        </div>
      </Card>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : payments.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">暂无付款流水</Card>
      ) : isDesktop ? (
        <DataTable
          data={payments}
          keyExtractor={(p) => p.id}
          columns={[
            {
              key: "paidAt",
              header: "付款日期",
              render: (p) => new Date(p.paidAt).toLocaleDateString("zh-CN"),
            },
            { key: "supplier", header: "供应商", render: (p) => p.supplier?.name || "—" },
            { key: "amount", header: "金额", money: true, align: "right" },
            {
              key: "method",
              header: "付款方式",
              render: (p) =>
                p.method ? (
                  <Badge variant="outline">{METHOD_LABELS[p.method] || p.method}</Badge>
                ) : (
                  "—"
                ),
            },
            {
              key: "voucherNo",
              header: "凭证号",
              render: (p) =>
                p.voucherNo ? (
                  <span className="text-xs text-muted-foreground">{p.voucherNo}</span>
                ) : (
                  "—"
                ),
            },
            {
              key: "allocations",
              header: "核销笔数",
              align: "center",
              render: (p) =>
                p.allocations.length > 0 ? (
                  <Badge variant="secondary">{p.allocations.length} 笔</Badge>
                ) : (
                  "—"
                ),
            },
          ]}
        />
      ) : (
        <div className="space-y-2">
          {payments.map((p) => (
            <MobileCard
              key={p.id}
              title={<MoneyText value={p.amount} className="font-medium" />}
              badge={
                p.method ? (
                  <Badge variant="outline">{METHOD_LABELS[p.method] || p.method}</Badge>
                ) : undefined
              }
              subtitle={p.supplier?.name || "未知供应商"}
              metrics={[
                { label: "日期", value: new Date(p.paidAt).toLocaleDateString("zh-CN") },
                { label: "核销", value: p.allocations.length > 0 ? `${p.allocations.length} 笔` : "—" },
                { label: "凭证号", value: p.voucherNo || "—" },
              ]}
            />
          ))}
        </div>
      )}
    </PageShell>
  );
}
