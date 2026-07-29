"use client";

import Link from "next/link";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Banknote,
  CalendarClock,
  FolderKanban,
  MapPin,
  Phone,
  Receipt,
  ShoppingCart,
  UserX,
  Users,
} from "lucide-react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiCard } from "@/components/ui/kpi-card";
import { CHART_TOOLTIP_LABEL_STYLE, CHART_TOOLTIP_STYLE } from "@/components/dashboard/chart-style";
import { cn } from "@/lib/utils";
import type { DashboardBusinessOverview } from "@/lib/dashboard/types";
import type { LucideIcon } from "lucide-react";

export function InlineSectionError({ retry }: { retry: () => void }) {
  return <div role="alert" className="col-span-2 rounded-lg border border-danger-border bg-danger-bg/20 p-4 text-sm md:col-span-4"><p className="font-medium">经营数据暂时无法加载</p><Button variant="outline" size="sm" className="mt-3" onClick={retry}>重试</Button></div>;
}

export function BusinessKpiRow({ data, role, retry }: { data: DashboardBusinessOverview; role: string; retry: () => void }) {
  const isRepresentative = role === "REPRESENTATIVE";
  const personalCrm = data.crm.data?.mode === "personal" ? data.crm.data : null;
  const orders = data.orders.data;
  const finance = data.finance.data;
  const relevantError = data.orders.error || (isRepresentative ? data.crm.error : data.finance.error);
  const monthOverMonth = orders && orders.lastMonthNewCount > 0
    ? (() => {
        const pct = ((orders.monthNewCount - orders.lastMonthNewCount) / orders.lastMonthNewCount) * 100;
        return { value: `${Math.abs(pct).toFixed(1)}% 环比上月`, direction: pct > 0 ? "up" as const : pct < 0 ? "down" as const : "flat" as const };
      })()
    : { value: "上月无订单", direction: "flat" as const };
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {orders && <KpiCard title="本月新增订单" value={orders.monthNewCount} icon={ShoppingCart} trend={monthOverMonth} description={`全部 ${orders.totalCount} 单`} href="/orders" variant="primary" methodology="按 orderedAt 订单时间统计上海时区自然月，排除已删除订单和 ACCRUAL_REVERSAL 冲回影子订单，并遵循当前账号订单权限范围。" />}
      {isRepresentative && personalCrm ? (
        <>
          <KpiCard title="我的跟进客户" value={personalCrm.myCustomerCount} icon={Users} description="本人名下客户" href="/crm/customers" />
          <KpiCard title="今日到期任务" value={personalCrm.dueTodayTaskCount} icon={CalendarClock} description="今日需要处理" href="/crm/follow-ups?view=today&mine=true" />
          <KpiCard title="逾期任务" value={personalCrm.overdueTaskCount} icon={AlertTriangle} description="请优先处理" href="/crm/follow-ups?view=overdue&mine=true" variant={personalCrm.overdueTaskCount > 0 ? "danger" : "default"} />
        </>
      ) : finance ? (
        <>
          <KpiCard title="本月业务额" value={finance.monthBusinessAmount} unit="yuan" mobileCompactAmount icon={FolderKanban} description={finance.weekBusinessAmount ? `本周新增 ¥${finance.weekBusinessAmount.toLocaleString("zh-CN")}` : "本周暂无新增"} href="/finance" variant="primary" methodology="沿用财务总览的业务确认口径，并遵循当前账号财务客户与项目 scope。" />
          <KpiCard title="本月回款" value={finance.monthReceiptAmount} unit="yuan" mobileCompactAmount icon={Receipt} description={`${finance.monthReceiptCount} 笔到款`} href="/finance/order-receivables" />
          <KpiCard title="利润" value={finance.profitAmount} unit="yuan" mobileCompactAmount icon={Banknote} description={finance.profitRate == null ? "暂无业务额数据" : `利润率 ${(finance.profitRate * 100).toFixed(1)}%`} href="/finance" variant={finance.profitAmount < 0 ? "danger" : finance.profitAmount > 0 ? "success" : "default"} />
        </>
      ) : null}
      {relevantError && <InlineSectionError retry={retry} />}
    </div>
  );
}

function formatAxisAmount(value: number): string {
  if (Math.abs(value) >= 10000) return `${(value / 10000).toFixed(0)}万`;
  return String(value);
}

export function BusinessTrendCard({ data, className }: { data: DashboardBusinessOverview; className?: string }) {
  const trend = data.orders.data?.monthlyTrend ?? [];
  const hasData = trend.some((point) => point.count > 0 || point.amount > 0);
  return (
    <Card className={cn(className)}>
      <CardHeader className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>近 6 个月经营趋势</CardTitle>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-chart-1" />订单金额</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-chart-4" />订单数</span>
          <Link href="/orders" className="inline-flex items-center gap-0.5 hover:text-primary">查看全部<ArrowRight className="h-3 w-3" /></Link>
        </div>
      </CardHeader>
      <CardContent>
        {hasData ? (
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={trend} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
              <defs>
                <linearGradient id="dashboard-amount-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
              <YAxis yAxisId="amount" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} tickFormatter={formatAxisAmount} width={44} />
              <YAxis yAxisId="count" orientation="right" allowDecimals={false} tick={{ fontSize: 12 }} tickLine={false} axisLine={false} width={28} />
              <Tooltip
                contentStyle={CHART_TOOLTIP_STYLE}
                labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                formatter={(value, name) => (name === "订单金额" ? [`¥${Number(value).toLocaleString("zh-CN")}`, name] : [value, name])}
              />
              <Area yAxisId="amount" type="monotone" dataKey="amount" name="订单金额" stroke="var(--chart-1)" strokeWidth={2} fill="url(#dashboard-amount-fill)" />
              <Line yAxisId="count" type="monotone" dataKey="count" name="订单数" stroke="var(--chart-4)" strokeWidth={2} dot={{ r: 3 }} />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">近 6 个月暂无订单数据</div>
        )}
      </CardContent>
    </Card>
  );
}

interface TodoItem {
  key: string;
  label: string;
  count: number;
  href: string;
  icon: LucideIcon;
  danger?: boolean;
}

export function TodoReminderCard({ data, role, pendingTickets, className }: { data: DashboardBusinessOverview; role: string; pendingTickets?: number; className?: string }) {
  const items: TodoItem[] = [];
  const crm = data.crm.data;
  const repOps = data.representativeOps.data;

  if (crm?.mode === "admin") {
    items.push(
      { key: "pending", label: "待跟进客户", count: crm.pendingFollowUps, href: "/crm/follow-ups", icon: CalendarClock },
      { key: "overdue", label: "逾期跟进", count: crm.overdueFollowUps, href: "/crm/follow-ups?view=overdue", icon: AlertTriangle, danger: true },
    );
  } else if (crm?.mode === "personal") {
    const mine = role === "REPRESENTATIVE" ? "&mine=true" : "";
    items.push(
      { key: "overdue", label: "逾期任务", count: crm.overdueTaskCount, href: `/crm/follow-ups?view=overdue${mine}`, icon: AlertTriangle, danger: true },
      { key: "today", label: "今日到期任务", count: crm.dueTodayTaskCount, href: `/crm/follow-ups?view=today${mine}`, icon: CalendarClock },
      { key: "contact", label: "建议联系", count: crm.suggestedContactCount, href: "/crm", icon: Phone },
      { key: "visit", label: "建议拜访", count: crm.suggestedVisitCount, href: "/crm", icon: MapPin },
    );
  }
  if (repOps) {
    items.push(
      { key: "rep-overdue", label: "代表逾期跟进", count: repOps.overdueFollowUps, href: "/crm/representatives?hasOverdue=true", icon: AlertTriangle, danger: true },
      { key: "rep-unvisited", label: "长期未访客户", count: repOps.longUnvisitedCount, href: "/crm/representatives?hasLongUnvisited=true", icon: UserX },
    );
  }
  if (typeof pendingTickets === "number" && pendingTickets > 0) {
    items.push({ key: "tickets", label: "待处理工单", count: pendingTickets, href: "/tickets", icon: AlertCircle, danger: true });
  }

  const visible = items.filter((item) => item.count > 0);
  return (
    <Card className={cn(className)}>
      <CardHeader><CardTitle>待办提醒</CardTitle></CardHeader>
      <CardContent>
        {visible.length ? (
          <ul className="divide-y divide-border">
            {visible.map((item) => (
              <li key={item.key}>
                <Link href={item.href} className="flex items-center gap-3 rounded-md px-1 py-2.5 text-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${item.danger ? "bg-danger/10 text-danger" : "bg-muted text-muted-foreground"}`}>
                    <item.icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${item.danger ? "bg-danger/10 text-danger" : "bg-muted text-muted-foreground"}`}>{item.count}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">暂无待办事项</div>
        )}
      </CardContent>
    </Card>
  );
}
