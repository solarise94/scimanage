"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CHART_TOOLTIP_LABEL_STYLE, CHART_TOOLTIP_STYLE } from "@/components/dashboard/chart-style";
import { cn } from "@/lib/utils";
import type { DashboardCrmSummary } from "@/lib/dashboard/types";

export function CrmActivityCard({ crm, className }: { crm: DashboardCrmSummary; className?: string }) {
  const trend = crm.monthlyTrend;
  const hasData = trend.some((point) => point.newCustomers > 0 || point.interactions > 0);
  const totalCustomers = crm.mode === "admin" ? crm.totalProfiles : crm.myCustomerCount;
  const monthInteractions = trend[trend.length - 1]?.interactions ?? 0;
  const crmHref = crm.mode === "admin" ? "/crm/customers" : "/crm";
  return (
    <Card className={cn(className)}>
      <CardHeader className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>近 6 个月客户与互动</CardTitle>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="tabular-nums">{crm.mode === "admin" ? "客户总数" : "我的客户"} {totalCustomers}</span>
          <span className="tabular-nums">本月互动 {monthInteractions}</span>
          <Link href={crmHref} className="inline-flex items-center gap-0.5 hover:text-primary">查看全部<ArrowRight className="h-3 w-3" /></Link>
        </div>
      </CardHeader>
      <CardContent>
        {hasData ? (
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={trend} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
              <YAxis yAxisId="left" allowDecimals={false} tick={{ fontSize: 12 }} tickLine={false} axisLine={false} width={32} />
              <YAxis yAxisId="right" orientation="right" allowDecimals={false} tick={{ fontSize: 12 }} tickLine={false} axisLine={false} width={32} />
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} labelStyle={CHART_TOOLTIP_LABEL_STYLE} cursor={{ fill: "var(--muted)" }} />
              <Bar yAxisId="left" dataKey="newCustomers" name="新增客户" fill="var(--chart-1)" radius={[6, 6, 0, 0]} maxBarSize={40} />
              <Line yAxisId="right" type="monotone" dataKey="interactions" name="互动次数" stroke="var(--chart-4)" strokeWidth={2} dot={{ r: 3 }} />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">近 6 个月暂无客户与互动数据</div>
        )}
      </CardContent>
    </Card>
  );
}
