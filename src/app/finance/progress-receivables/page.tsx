"use client";

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Loader2, TrendingUp, FolderKanban, ShoppingBag, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/ui/page-header";
import { KpiCard } from "@/components/ui/kpi-card";
import { DataTable } from "@/components/ui/data-table";
import { MobileCard } from "@/components/ui/mobile-card";
import { MoneyText } from "@/components/ui/money-text";
import { FinanceEmptyState } from "@/components/finance/finance-empty-state";
import { useMediaQuery } from "@/hooks/use-media-query";
import { getOrderCategoryLabel } from "@/lib/order-labels";
import { PageShell } from "@/components/ui/page-shell";

export default function ProgressReceivablesPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  if (status === "loading") return <div className="flex items-center justify-center h-64"><Loader2 className="h-8 w-8 animate-spin" /></div>;
  if (!session) { router.push("/login"); return null; }
  if (session.user.role === "REPRESENTATIVE") { router.push("/dashboard"); return null; }
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><Loader2 className="h-8 w-8 animate-spin" /></div>}>
      <ProgressContent />
    </Suspense>
  );
}

function ProgressContent() {
  const searchParams = useSearchParams();
  const period = searchParams.get("period") || "week";
  const [filter, setFilter] = useState("ALL");
  const isMobile = useMediaQuery("(max-width: 767px)");
  const router = useRouter();

  const { data, isLoading } = useQuery({
    queryKey: ["finance", "progress-receivables", period],
    queryFn: async () => {
      const res = await fetch(`/api/finance/progress-receivables?period=${period}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<{
        period: string; total: number;
        adjustmentAmount: number;
        adjustmentItems: Array<Record<string, unknown>>;
        serviceDeposit: number; serviceFinal: number; productReceivable: number;
        projectItems: Array<Record<string, unknown>>;
        orderItems: Array<Record<string, unknown>>;
      }>;
    },
  });

  if (isLoading) return <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin" /></div>;

  const projectItems = (data?.projectItems || []).filter((i) =>
    filter === "ALL" || i.eventType === filter
  );
  const orderItems = (data?.orderItems || []).filter((i) =>
    filter === "ALL" || i.eventType === filter || (filter === "SERVICE" && String(i.eventType).startsWith("SERVICE")) || (filter === "PRODUCT" && String(i.eventType).startsWith("PRODUCT"))
  );
  const adjustmentItems = data?.adjustmentItems || [];
  const adjustmentAmount = (data?.adjustmentAmount as number) || 0;

  const PERIOD_TITLE: Record<string, string> = {
    week: "本周",
    month: "本月",
    quarter: "本季度",
  };

  const filterOptions = [
    { value: "ALL", label: "全部" },
    { value: "SERVICE_START", label: "服务立项(30%)" },
    { value: "SERVICE_COMPLETED", label: "服务结项(70%)" },
    { value: "PRODUCT_START", label: "商品立项(100%)" },
    { value: "PRODUCT_ORDER", label: "商品订单(100%)" },
    { value: "SERVICE_ORDER_DEPOSIT", label: "服务订单(30%)" },
  ];

  return (
    <PageShell>
      <PageHeader
        title={`${PERIOD_TITLE[period] || "本周"}进度款明细`}
        backHref="/finance"
        backLabel="返回财务"
        actions={
          <div className="flex gap-2">
            <Badge variant={period === "week" ? "default" : "outline"} className="cursor-pointer" onClick={() => router.push("?period=week")}>本周</Badge>
            <Badge variant={period === "month" ? "default" : "outline"} className="cursor-pointer" onClick={() => router.push("?period=month")}>本月</Badge>
            <Badge variant={period === "quarter" ? "default" : "outline"} className="cursor-pointer" onClick={() => router.push("?period=quarter")}>本季度</Badge>
          </div>
        }
      />

      <div className="grid gap-4 md:grid-cols-5">
        <KpiCard title="进度款总额" value={data?.total ?? 0} icon={TrendingUp} />
        <KpiCard title="服务立项(30%)" value={data?.serviceDeposit ?? 0} icon={FolderKanban} />
        <KpiCard title="服务结项(70%)" value={data?.serviceFinal ?? 0} icon={FolderKanban} />
        <KpiCard title="商品项目(100%)" value={data?.productReceivable ?? 0} icon={ShoppingBag} />
        <KpiCard
          title="修订调整"
          value={adjustmentAmount}
          icon={RefreshCw}
          variant={adjustmentAmount < 0 ? "danger" : adjustmentAmount > 0 ? "success" : "muted"}
        />
      </div>

      <div>
        <Select value={filter} onValueChange={(v) => { if (v) setFilter(v); }}>
          <SelectTrigger className="h-8 w-56 text-xs">
            <SelectValue placeholder="筛选类型" />
          </SelectTrigger>
          <SelectContent>
            {filterOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <h2 className="text-sm font-medium text-muted-foreground">项目进度款</h2>
      {projectItems.length === 0 ? (
        <FinanceEmptyState title="暂无项目进度款" />
      ) : isMobile ? (
        <div className="md:hidden space-y-3">
          {projectItems.map((item, i) => (
            <MobileCard
              key={i}
              title={String(item.projectName)}
              badge={
                <Badge variant="outline">
                  {item.eventType === "SERVICE_START" ? "服务立项" :
                   item.eventType === "SERVICE_COMPLETED" ? "服务结项" :
                   item.eventType === "PRODUCT_START" ? "商品立项" : String(item.eventType)}
                </Badge>
              }
              subtitle={String(item.customerName || "-")}
              metrics={[
                { label: "预算", value: <MoneyText value={Number(item.budgetAmount)} compact /> },
                { label: "进度款", value: <MoneyText value={Number(item.receivableAmount)} compact /> },
                { label: "比例", value: `${Math.round(Number(item.rate) * 100)}%` },
                { label: "日期", value: new Date(String(item.eventDate)).toLocaleDateString("zh-CN") },
              ]}
            />
          ))}
        </div>
      ) : (
        <DataTable
          columns={[
            { key: "projectName", header: "项目", render: (item) => String(item.projectName) },
            { key: "customerName", header: "客户", render: (item) => String(item.customerName || "-") },
            { key: "eventType", header: "类型", align: "center", render: (item) => (
              <Badge variant="outline">
                {item.eventType === "SERVICE_START" ? "服务立项" :
                 item.eventType === "SERVICE_COMPLETED" ? "服务结项" :
                 item.eventType === "PRODUCT_START" ? "商品立项" : String(item.eventType)}
              </Badge>
            )},
            { key: "eventDate", header: "日期", render: (item) => new Date(String(item.eventDate)).toLocaleDateString("zh-CN") },
            { key: "budgetAmount", header: "预算", align: "right", render: (item) => <MoneyText value={Number(item.budgetAmount)} /> },
            { key: "receivableAmount", header: "进度款", align: "right", render: (item) => <MoneyText value={Number(item.receivableAmount)} /> },
            { key: "rate", header: "比例", align: "center", render: (item) => `${Math.round(Number(item.rate) * 100)}%` },
          ]}
          data={projectItems}
          keyExtractor={(_, i) => `p-${i}`}
        />
      )}

      <h2 className="text-sm font-medium text-muted-foreground mt-6">独立订单进度款</h2>
      {orderItems.length === 0 ? (
        <FinanceEmptyState title="暂无独立订单进度款" />
      ) : isMobile ? (
        <div className="md:hidden space-y-3">
          {orderItems.map((item, i) => (
            <MobileCard
              key={i}
              title={String(item.orderNo || item.externalOrderNo)}
              badge={
                <Badge variant="outline">
                  {item.eventType === "PRODUCT_ORDER" ? "商品订单" : "服务订单(30%)"}
                </Badge>
              }
              subtitle={String(item.customerName || "-")}
              metrics={[
                { label: "金额", value: <MoneyText value={Number(item.amount)} compact /> },
                { label: "进度款", value: <MoneyText value={Number(item.receivableAmount)} compact /> },
                { label: "比例", value: `${Math.round(Number(item.rate) * 100)}%` },
                { label: "日期", value: new Date(String(item.eventDate)).toLocaleDateString("zh-CN") },
              ]}
            />
          ))}
        </div>
      ) : (
        <DataTable
          columns={[
            { key: "orderNo", header: "订单号", render: (item) => String(item.orderNo || item.externalOrderNo) },
            { key: "customerName", header: "客户", render: (item) => String(item.customerName || "-") },
            { key: "financeCategory", header: "分类", align: "center", render: (item) => <Badge variant="outline">{getOrderCategoryLabel(String(item.financeCategory))}</Badge> },
            { key: "eventType", header: "类型", align: "center", render: (item) => (
              <Badge variant="outline">{item.eventType === "PRODUCT_ORDER" ? "商品订单" : "服务订单(30%)"}</Badge>
            )},
            { key: "eventDate", header: "日期", render: (item) => new Date(String(item.eventDate)).toLocaleDateString("zh-CN") },
            { key: "amount", header: "金额", align: "right", render: (item) => <MoneyText value={Number(item.amount)} /> },
            { key: "receivableAmount", header: "进度款", align: "right", render: (item) => <MoneyText value={Number(item.receivableAmount)} /> },
            { key: "rate", header: "比例", align: "center", render: (item) => `${Math.round(Number(item.rate) * 100)}%` },
          ]}
          data={orderItems}
          keyExtractor={(_, i) => `o-${i}`}
        />
      )}

      {adjustmentItems.length > 0 && (
        <>
          <h2 className="text-sm font-medium text-muted-foreground mt-6">订单修订调整项</h2>
          {isMobile ? (
            <div className="md:hidden space-y-3">
              {adjustmentItems.map((item, i) => {
                const amount = Number(item.amount);
                return (
                  <MobileCard
                    key={i}
                    title={amount >= 0 ? "订单修订新增进度款" : "订单修订扣减进度款"}
                    badge={
                      <Badge variant={amount >= 0 ? "default" : "destructive"}>
                        {amount >= 0 ? "新增" : "扣减"}
                      </Badge>
                    }
                    subtitle={String(item.orderNo || item.projectName || "-")}
                    metrics={[
                      { label: "调整金额", value: <MoneyText value={amount} tone={amount < 0 ? "expense" : "income"} compact /> },
                      { label: "月份", value: String(item.periodKey) },
                      { label: "原因", value: String(item.reason || "-") },
                    ]}
                    primaryAction={item.orderId ? {
                      label: "查看订单",
                      onClick: () => router.push(`/orders?focus=${item.orderId}`),
                    } : undefined}
                  />
                );
              })}
            </div>
          ) : (
            <DataTable
              columns={[
                {
                  key: "type",
                  header: "类型",
                  render: (item) => {
                    const amount = Number(item.amount);
                    return (
                      <Badge variant={amount >= 0 ? "default" : "destructive"}>
                        {amount >= 0 ? "订单修订新增进度款" : "订单修订扣减进度款"}
                      </Badge>
                    );
                  },
                },
                { key: "orderNo", header: "订单", render: (item) => String(item.orderNo || "-") },
                { key: "projectName", header: "项目", render: (item) => String(item.projectName || "-") },
                {
                  key: "amount",
                  header: "调整金额",
                  align: "right",
                  render: (item) => {
                    const amount = Number(item.amount);
                    return <MoneyText value={amount} tone={amount < 0 ? "expense" : "income"} />;
                  },
                },
                { key: "periodKey", header: "影响月份", align: "center", render: (item) => String(item.periodKey) },
                { key: "reason", header: "原因", render: (item) => String(item.reason || "-") },
                {
                  key: "actions",
                  header: "操作",
                  align: "center",
                  render: (item) =>
                    item.orderId ? (
                      <a href={`/orders?focus=${item.orderId}&view=history`} className="text-primary hover:underline text-xs">
                        查看订单
                      </a>
                    ) : null,
                },
              ]}
              data={adjustmentItems}
              keyExtractor={(_, i) => `adj-${i}`}
            />
          )}
        </>
      )}
    </PageShell>
  );
}