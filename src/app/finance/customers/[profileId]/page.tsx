"use client";

import { useState, Suspense } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, ShoppingBag, FileText, Banknote } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { KpiCard } from "@/components/ui/kpi-card";
import { DataTable } from "@/components/ui/data-table";
import { AnimatedTabPanel } from "@/components/ui/animated-tab-panel";
import { AnimatedMoney } from "@/components/ui/animated-money";
import { FinanceEmptyState } from "@/components/finance/finance-empty-state";
import { LegacyFinanceBanner } from "@/components/finance/legacy-finance-banner";
import { CollectionMetricsPanel } from "@/components/finance/collection-metrics-panel";
import { MatchStatusBadge } from "@/components/finance/finance-status-badge";
import type { CustomerFinanceDetail } from "@/lib/finance/types";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  Select, SelectContent, SelectDisplay, SelectItem, SelectTrigger,
} from "@/components/ui/select";
import Link from "next/link";
import { PageShell } from "@/components/ui/page-shell";

function isSafeReturnTo(url: string | null): url is string {
  return !!url && url.startsWith("/") && !url.startsWith("//");
}

export default function CustomerFinanceDetailPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    }>
      <CustomerFinanceDetailPageInner />
    </Suspense>
  );
}

function CustomerFinanceDetailPageInner() {
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

  return <CustomerFinanceDetail />;
}

function CustomerFinanceDetail() {
  const params = useParams();
  const profileId = params.profileId as string;
  const router = useRouter();
  const searchParams = useSearchParams();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [activeTab, setActiveTab] = useState("orders");
  const rawReturnTo = searchParams.get("returnTo");
  const returnTo = isSafeReturnTo(rawReturnTo) ? rawReturnTo : undefined;

  const { data, isLoading } = useQuery<CustomerFinanceDetail>({
    queryKey: ["finance", "customer", profileId],
    queryFn: async () => {
      const res = await fetch(`/api/finance/customers/${profileId}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <PageShell className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      </PageShell>
    );
  }

  if (!data) {
    return (
      <PageShell>
        <FinanceEmptyState title="客户不存在" />
      </PageShell>
    );
  }

  const tabs = [
    { value: "orders", label: "订单" },
    { value: "invoices", label: "开票" },
    { value: "receipts", label: "到款" },
    { value: "projects", label: "项目" },
  ];

  const outstanding = data.summary.receivableAmount - data.summary.totalReceiptAmount;

  return (
    <PageShell>
      <PageHeader
        title={data.customer.name}
        description={`${data.customer.customerCode}${data.customer.organization ? ` · ${data.customer.organization}` : ""}`}
        backHref={returnTo || "/finance/customers"}
      />

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          title="平台订单额"
          value={data.summary.onlineOrderTotal}
          icon={ShoppingBag}
        />
        <KpiCard
          title="已开票"
          value={data.summary.projectInvoicedAmount + data.summary.orderInvoicedAmount}
          icon={FileText}
        />
        <KpiCard
          title="已回款"
          value={data.summary.totalReceiptAmount}
          icon={Banknote}
          variant="success"
        />
        <KpiCard
          title="应收余额"
          value={outstanding}
          icon={ShoppingBag}
          variant={outstanding > 0 ? "warning" : "default"}
        />
      </div>

      {data.collectionSummary && (
        <CollectionMetricsPanel
          summary={data.collectionSummary}
          showRolling
          mergedNote={data.hasMergedHistory}
        />
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        {isMobile ? (
          <Select value={activeTab} onValueChange={(v) => v && setActiveTab(v)}>
            <SelectTrigger className="w-full"><SelectDisplay label="标签页" valueLabel={tabs.find(t => t.value === activeTab)?.label} /></SelectTrigger>
            <SelectContent>
              {tabs.map((t) => (<SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <TabsList className="w-full sm:w-auto">
            {tabs.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>
            ))}
          </TabsList>
        )}

        {/* Orders tab */}
        <AnimatedTabPanel activeValue={activeTab} value="orders" className="mt-4">
          {data.onlineOrders.length === 0 ? (
            <FinanceEmptyState title="暂无订单" />
          ) : (
            <DataTable
              columns={[
                { key: "orderNo", header: "订单号" },
                { key: "totalAmount", header: "金额", align: "right", render: (o) => <AnimatedMoney value={o.totalAmount} className="justify-end" /> },
                { key: "orderedAt", header: "日期", render: (o) => o.orderedAt ? new Date(o.orderedAt).toLocaleDateString("zh-CN") : "-" },
                { key: "customerMatchStatus", header: "匹配", align: "center", render: (o) => <MatchStatusBadge status={o.customerMatchStatus} /> },
                { key: "financeTreatment", header: "计入方式", align: "center", render: (o) => (
                  <Badge variant={o.financeTreatment === "STANDALONE" ? "default" : o.financeTreatment === "PROJECT_INCLUDED" ? "secondary" : o.financeTreatment === "EXCLUDED" ? "destructive" : "outline"}>
                    {o.financeTreatment === "AUTO" ? "自动" : o.financeTreatment === "STANDALONE" ? "独立计入" : o.financeTreatment === "PROJECT_INCLUDED" ? "并入项目" : o.financeTreatment === "EXCLUDED" ? "排除" : o.financeTreatment}
                  </Badge>
                )},
                {
                  key: "actions",
                  header: "操作",
                  align: "center",
                  render: (o) => (
                    <Link href={`/orders?focus=${o.id}`} className="text-primary hover:underline text-xs">
                      查看
                    </Link>
                  ),
                },
              ]}
              data={data.onlineOrders}
              keyExtractor={(o) => o.id}
              onRowClick={(o) => router.push(`/orders?focus=${o.id}`)}
            />
          )}
        </AnimatedTabPanel>

        {/* Invoices tab */}
        <AnimatedTabPanel activeValue={activeTab} value="invoices" className="mt-4">
          <div className="space-y-4">
            <LegacyFinanceBanner message="历史项目发票已停用新建。新开票请从订单详情页操作。" />
            {[...data.projectInvoices, ...data.orderInvoices].length === 0 ? (
              <FinanceEmptyState title="暂无开票记录" />
            ) : (
              <DataTable
                columns={[
                  { key: "type", header: "类型", render: (_i, idx) => idx < data.projectInvoices.length ? "项目发票" : "订单发票" },
                  { key: "totalAmount", header: "金额", align: "right", render: (inv) => <AnimatedMoney value={inv.totalAmount} className="justify-end" /> },
                  {
                    key: "status",
                    header: "状态",
                    align: "center",
                    render: (inv) => (
                      <Badge variant={inv.status === "ISSUED" ? "default" : inv.status === "CANCELLED" ? "destructive" : "outline"}>
                        {inv.status === "ISSUED" ? "已开票" : inv.status === "DRAFT" ? "草稿" : inv.status === "REQUESTED" ? "已申请" : inv.status}
                      </Badge>
                    ),
                  },
                  { key: "createdAt", header: "日期", render: (inv) => new Date(inv.createdAt).toLocaleDateString("zh-CN") },
                ]}
                data={[...data.projectInvoices, ...data.orderInvoices]}
                keyExtractor={(inv) => inv.id}
              />
            )}
          </div>
        </AnimatedTabPanel>

        {/* Receipts tab */}
        <AnimatedTabPanel activeValue={activeTab} value="receipts" className="mt-4">
          {data.receipts.length === 0 ? (
            <FinanceEmptyState title="暂无到款记录" />
          ) : (
            <DataTable
              columns={[
                { key: "amount", header: "金额", align: "right", render: (r) => <AnimatedMoney value={r.amount} tone="income" className="justify-end" /> },
                { key: "receivedAt", header: "到款日期", render: (r) => new Date(r.receivedAt).toLocaleDateString("zh-CN") },
                { key: "source", header: "来源", align: "center", render: (r) => <Badge variant="outline">{r.source}</Badge> },
                { key: "remark", header: "备注", render: (r) => r.remark || "-" },
              ]}
              data={data.receipts}
              keyExtractor={(r) => r.id}
            />
          )}
        </AnimatedTabPanel>

        {/* Projects tab */}
        <AnimatedTabPanel activeValue={activeTab} value="projects" className="mt-4">
          <div className="space-y-4">
            <LegacyFinanceBanner message="项目相关财务已迁移到订单维度。项目信息仅做参考。" />
            {data.projects.length === 0 ? (
              <FinanceEmptyState title="暂无项目" />
            ) : (
              <DataTable
                columns={[
                  { key: "name", header: "项目名称" },
                  { key: "budgetAmount", header: "预算金额", align: "right", render: (p) => <AnimatedMoney value={p.budgetAmount || 0} className="justify-end" /> },
                  { key: "status", header: "状态", align: "center", render: (p) => <Badge variant="outline">{p.status}</Badge> },
                  { key: "progress", header: "进度", align: "center", render: (p) => `${p.progress}%` },
                ]}
                data={data.projects}
                keyExtractor={(p) => p.id}
                onRowClick={(p) => router.push(`/projects/${p.id}`)}
              />
            )}
          </div>
        </AnimatedTabPanel>
      </Tabs>
    </PageShell>
  );
}