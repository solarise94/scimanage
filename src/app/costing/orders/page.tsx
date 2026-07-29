"use client";

import { useState, Suspense } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { MoneyText } from "@/components/ui/money-text";
import { canAccessCosting } from "@/lib/role-guards";

interface OrderMarginResponse {
  orderId: string;
  basis: string;
  revenue: number;
  supplyChainGrossMargin: number;
  operatingGrossMargin: number;
  netContribution: number;
  netContributionRate: number | null;
  costSummary: {
    realCost: number;
    circulationCost: number;
    taxCost: number;
    totalCost: number;
  };
}

export default function CostOrdersPage() {
  return (
    <Suspense
      fallback={
        <PageShell>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64" />
        </PageShell>
      }
    >
      <CostOrdersContent />
    </Suspense>
  );
}

function CostOrdersContent() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [orderId, setOrderId] = useState("");
  const [submittedId, setSubmittedId] = useState("");

  const { data, isLoading, isError, error } = useQuery<OrderMarginResponse>({
    queryKey: ["costing", "order-margin", submittedId],
    queryFn: async () => {
      const res = await fetch(
        `/api/costing/order-margin?orderId=${encodeURIComponent(submittedId)}&basis=FULL`,
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "加载失败");
      return json;
    },
    enabled: status === "authenticated" && submittedId.trim().length > 0,
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

  const handleSearch = () => {
    const id = orderId.trim();
    if (!id) return;
    setSubmittedId(id);
  };

  const rate =
    data?.netContributionRate != null
      ? `${(data.netContributionRate * 100).toFixed(2)}%`
      : "—";

  return (
    <PageShell>
      <PageHeader
        title="订单成本视图"
        description="按订单查看收入、成本与毛利口径"
        backHref="/costing"
        backLabel="返回成本核算"
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="输入订单 ID"
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSearch();
            }}
            className="pl-8"
          />
        </div>
        <Button onClick={handleSearch} disabled={!orderId.trim()}>
          查询
        </Button>
      </div>

      {!submittedId ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          输入订单 ID 后点击「查询」查看成本与毛利口径。
        </Card>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : isError ? (
        <Card className="p-8 text-center text-sm text-destructive">
          {error instanceof Error ? error.message : "加载失败"}
        </Card>
      ) : data ? (
        <div className="space-y-4">
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium">收入与毛利</h3>
              </div>
              <div className="grid gap-3 text-sm md:grid-cols-3">
                <div>
                  <p className="text-xs text-muted-foreground">订单收入</p>
                  <p className="font-medium">
                    <MoneyText value={data.revenue} />
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">供应链毛利</p>
                  <p className="font-medium">
                    <MoneyText value={data.supplyChainGrossMargin} />
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">经营毛利</p>
                  <p className="font-medium">
                    <MoneyText value={data.operatingGrossMargin} />
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">净贡献</p>
                  <p className="font-medium">
                    <MoneyText value={data.netContribution} />
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">净贡献率</p>
                  <p className="font-medium">{rate}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium">成本汇总</h3>
              </div>
              <div className="grid gap-3 text-sm md:grid-cols-4">
                <div>
                  <p className="text-xs text-muted-foreground">真实成本</p>
                  <p className="font-medium">
                    <MoneyText value={data.costSummary.realCost} tone="expense" />
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">流通成本</p>
                  <p className="font-medium">
                    <MoneyText value={data.costSummary.circulationCost} tone="expense" />
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">税费成本</p>
                  <p className="font-medium">
                    <MoneyText value={data.costSummary.taxCost} tone="expense" />
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">总成本</p>
                  <p className="font-medium">
                    <MoneyText value={data.costSummary.totalCost} tone="expense" />
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </PageShell>
  );
}
