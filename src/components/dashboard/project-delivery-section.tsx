"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CHART_TOOLTIP_LABEL_STYLE, CHART_TOOLTIP_STYLE } from "@/components/dashboard/chart-style";
import { cn } from "@/lib/utils";
import type { DashboardStats } from "@/lib/types";

const STATUS_COLORS: Record<string, string> = { NOT_STARTED: "var(--muted-foreground)", IN_PROGRESS: "var(--chart-1)", COMPLETED: "var(--success)", ON_HOLD: "var(--warning)", TERMINATED: "var(--danger)" };
const STATUS_LABELS: Record<string, string> = { NOT_STARTED: "未开始", IN_PROGRESS: "进行中", COMPLETED: "已完成", ON_HOLD: "暂停", TERMINATED: "终止" };

export function ProjectStatusDonutCard({ stats, className }: { stats: DashboardStats; className?: string }) {
  const pieData = stats.statusDistribution.map((item) => ({ name: STATUS_LABELS[item.status] || item.status, value: item._count.status, color: STATUS_COLORS[item.status] || "var(--muted-foreground)" }));
  return (
    <Card className={cn(className)}>
      <CardHeader>
        <CardTitle>项目状态分布</CardTitle>
        <CardAction>
          <Link href="/projects" className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-primary">查看全部<ArrowRight className="h-3 w-3" /></Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        {pieData.length ? (
          <>
            <div className="relative">
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" innerRadius="58%" outerRadius="82%" paddingAngle={3} dataKey="value" strokeWidth={0} isAnimationActive={false}>
                    {pieData.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                  </Pie>
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} labelStyle={CHART_TOOLTIP_LABEL_STYLE} />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl font-bold tabular-nums">{stats.totalProjects}</span>
                <span className="text-xs text-muted-foreground">总项目</span>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap justify-center gap-3">
              {pieData.map((entry) => (
                <div key={entry.name} className="flex items-center gap-1.5 text-xs">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: entry.color }} />
                  {entry.name}
                  <span className="text-muted-foreground tabular-nums">{entry.value}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">暂无项目数据</div>
        )}
      </CardContent>
    </Card>
  );
}

export function TicketTrendBarCard({ stats, className }: { stats: DashboardStats; className?: string }) {
  const barData = stats.ticketTrend.map((item) => ({ date: item.date.slice(5), count: Number(item.count) }));
  const hasData = barData.some((item) => item.count > 0);
  return (
    <Card className={cn(className)}>
      <CardHeader>
        <CardTitle>近 7 天工单趋势</CardTitle>
        <CardAction>
          <Link href="/tickets" className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-primary">查看全部<ArrowRight className="h-3 w-3" /></Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        {hasData ? (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={barData} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} tickLine={false} axisLine={false} width={32} />
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} labelStyle={CHART_TOOLTIP_LABEL_STYLE} cursor={{ fill: "var(--muted)" }} />
              <Bar dataKey="count" name="工单数" fill="var(--chart-1)" radius={[6, 6, 0, 0]} maxBarSize={40} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">近 7 天无工单数据</div>
        )}
      </CardContent>
    </Card>
  );
}
