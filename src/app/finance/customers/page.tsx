"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Search, Loader2, Eye, ChevronLeft, ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable } from "@/components/ui/data-table";
import { MobileCard } from "@/components/ui/mobile-card";
import { MoneyText } from "@/components/ui/money-text";
import { FinanceEmptyState } from "@/components/finance/finance-empty-state";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { FinanceCustomerListResponse } from "@/lib/finance/types";
import { formatCollectionCycle } from "@/lib/finance/collection-display";
import { PageShell } from "@/components/ui/page-shell";

export default function FinanceCustomersPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }
  if (!session) { router.push("/login"); return null; }
  if (session.user.role === "REPRESENTATIVE") { router.push("/dashboard"); return null; }

  return <FinanceCustomersList />;
}

function FinanceCustomersList() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "ADMIN";
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [includeArchived, setIncludeArchived] = useState(false);
  const pageSize = 20;
  const isMobile = useMediaQuery("(max-width: 767px)");
  const router = useRouter();

  const { data, isLoading } = useQuery<FinanceCustomerListResponse>({
    queryKey: ["finance", "customers", search, page, includeArchived],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (includeArchived) params.set("includeArchived", "true");
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      const res = await fetch(`/api/finance/customers?${params}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });

  return (
    <PageShell>
      <PageHeader
        title="客户财务看板"
        description="按客户聚合的财务数据"
        backHref="/finance"
        backLabel="返回财务"
      />

      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        <div className="relative max-w-sm min-w-0 w-full">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="搜索客户名称/编号/单位..."
            className="pl-8 w-full"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
        </div>
        {isAdmin && (
          <label className="flex items-center gap-2 cursor-pointer select-none text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              checked={includeArchived}
              onChange={(e) => { setIncludeArchived(e.target.checked); setPage(1); }}
            />
            含归档客户
          </label>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin" /></div>
      ) : (
        <>
          {data?.customers?.length === 0 ? (
            <FinanceEmptyState title="暂无客户数据" />
          ) : isMobile ? (
            <div className="md:hidden space-y-3">
              {data?.customers.map((cust) => (
                <MobileCard
                  key={cust.id}
                  title={cust.name}
                  subtitle={`${cust.customerCode} · ${cust.organization || "无单位"}`}
                  metrics={[
                    { label: "订单", value: <MoneyText value={cust.onlineOrderTotalAmount} compact /> },
                    { label: "项目", value: <MoneyText value={cust.projectBudgetTotalAmount} compact /> },
                    { label: "应收", value: <MoneyText value={cust.receivableAmount} compact /> },
                    { label: "到款", value: <MoneyText value={cust.totalReceiptAmount} tone="income" compact /> },
                  ]}
                  badge={<MoneyText value={cust.outstandingAmount} tone={cust.outstandingAmount > 0 ? "warning" : "default"} />}
                  primaryAction={{
                    label: "查看详情",
                    onClick: () => router.push(`/finance/customers/${cust.id}`),
                    icon: <Eye className="h-3.5 w-3.5 mr-1" />,
                  }}
                />
              ))}
            </div>
          ) : (
            <DataTable
              columns={[
                { key: "name", header: "客户", sortable: true, sortValue: (c) => c.name, render: (c) => (
                  <div>
                    <div className="font-medium">{c.name}</div>
                    <div className="text-xs text-muted-foreground">{c.customerCode}</div>
                  </div>
                )},
                { key: "organization", header: "单位", sortable: true, sortValue: (c) => c.organization || "", render: (c) => c.organization || "-" },
                { key: "standaloneOnlineOrderAmount", header: "独立订单额", align: "right", money: true },
                { key: "projectBudgetTotalAmount", header: "项目总额", align: "right", money: true },
                { key: "receivableAmount", header: "应收额", align: "right", money: true },
                {
                  key: "avgCollectionCycleDays",
                  header: "平均回款周期",
                  align: "right",
                  render: (c) => formatCollectionCycle(c.avgCollectionCycleDays ?? null, c.collectionPairCount ?? 0),
                },
                { key: "totalReceiptAmount", header: "到款额", align: "right", sortable: true, sortValue: (c) => c.totalReceiptAmount, render: (c) => <MoneyText value={c.totalReceiptAmount} tone="income" /> },
                { key: "outstandingAmount", header: "应收余额", align: "right", sortable: true, sortValue: (c) => c.outstandingAmount, render: (c) => (
                  <MoneyText value={c.outstandingAmount} tone={c.outstandingAmount > 0 ? "warning" : "default"} />
                )},
              ]}
              data={data?.customers || []}
              keyExtractor={(c) => c.id}
              onRowClick={(c) => router.push(`/finance/customers/${c.id}`)}
            />
          )}

          {data && data.total > pageSize && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                共 {data.total} 条，第 {page}/{Math.ceil(data.total / pageSize)} 页
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" disabled={page >= Math.ceil(data.total / pageSize)} onClick={() => setPage((p) => p + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </PageShell>
  );
}