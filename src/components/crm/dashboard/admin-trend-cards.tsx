"use client";

/**
 * ADMIN 运营仪表盘趋势卡片组件（飞书仪表盘风格）。
 *
 * - StatBoardCard：飞书式大数字卡（小标题 + text-3xl 大数字 + 差异率行/子说明；可选迷你趋势线）
 * - SwitchableTrendCard：可切换视图图表卡（新增客户/沟通互动/跟进任务，共用一个图表区）
 * - StageDistributionCard：客户阶段分布环形图（飞书饼图风）
 * - RepAlertBarCard：代表运营异常横向堆叠条形图（逾期 danger + 长期未拜访 warning）
 *
 * recharts 用法模仿 src/components/crm/rep-trends-charts.tsx。
 */

import * as React from "react";
import Link from "next/link";
import {
  BarChart,
  Bar,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { CHART_TOOLTIP_LABEL_STYLE, CHART_TOOLTIP_STYLE } from "@/components/dashboard/chart-style";
import { cn } from "@/lib/utils";
import { STAGE_LABELS, STAGE_HEX_COLORS } from "@/lib/crm/constants";
import type { AdminTrendsPoint, AdminTrendsResult } from "@/lib/crm/admin-trends";

// ─── helpers ────────────────────────────────────────────────

const RANGE_OPTIONS: Array<{ days: 7 | 30 | 90; label: string }> = [
  { days: 7, label: "近7天" },
  { days: 30, label: "近30天" },
  { days: 90, label: "近90天" },
];

/** 从 YYYY-MM-DD 切出 MM-DD（tickFormatter 用）。 */
function formatTickDate(date: string): string {
  // date 形如 "2026-07-18"，直接切片避免时区漂移。
  return date.length >= 10 ? date.slice(5) : date;
}

/** 环比徽标：prev=0 返回 null；上升 success，下降 danger。 */
function TrendBadge({ current, previous }: { current: number; previous: number }) {
  if (previous === 0) return null;
  const rate = (current - previous) / previous;
  const pct = (rate * 100).toFixed(1);
  const isUp = rate >= 0;
  return (
    <span
      className={cn(
        "inline-flex items-center text-xs font-medium",
        isUp ? "text-success" : "text-danger",
      )}
    >
      {isUp ? "▲" : "▼"} {Math.abs(parseFloat(pct))}%
    </span>
  );
}

/** 时间范围切换 Tab 组（简洁自绘）。 */
function RangeTabs({
  days,
  onDaysChange,
}: {
  days: number;
  onDaysChange: (days: 7 | 30 | 90) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-md bg-muted p-0.5">
      {RANGE_OPTIONS.map((opt) => (
        <button
          key={opt.days}
          type="button"
          onClick={() => onDaysChange(opt.days)}
          className={cn(
            "rounded px-2 py-0.5 text-xs font-medium transition-colors",
            days === opt.days
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ─── 1. StatBoardCard：飞书大数字卡 ─────────────────────────

interface StatBoardCardProps {
  title: string;
  value: number | string; // number 时用 AnimatedNumber 滚动
  /** 有则显示差异率行（复用 TrendBadge 逻辑：prev=0 显示「差异率 -」）。 */
  delta?: { current: number; previous: number } | null;
  /** 无 delta 时的子说明（muted text-xs）。 */
  description?: string;
  /** 有则底部画迷你面积趋势线。 */
  spark?: AdminTrendsPoint[];
  /** 默认 var(--chart-1)。 */
  sparkColor?: string;
  /** 有则整卡 Link。 */
  href?: string;
}

export function StatBoardCard({
  title,
  value,
  delta,
  description,
  spark,
  sparkColor = "var(--chart-1)",
  href,
}: StatBoardCardProps) {
  // 渐变 id 按 useId 唯一化，避免多卡渐变 id 冲突。
  const rawId = React.useId();
  const gradientId = `stat-spark-${rawId}`;
  const isNumber = typeof value === "number";

  const card = (
    <Card className="min-w-0 h-full">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <div className="text-3xl font-bold tabular-nums leading-tight">
          {isNumber ? <AnimatedNumber value={value} /> : value}
        </div>
        {/* 差异率行 / description 行：高度固定避免卡高抖动 */}
        {delta ? (
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">差异率</span>
            {/* prev=0 时 TrendBadge 返回 null，这里降级显示「-」 */}
            <TrendBadge current={delta.current} previous={delta.previous} />
            {delta.previous === 0 && (
              <span className="text-muted-foreground">-</span>
            )}
          </div>
        ) : description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : (
          // 占位行：保证无 delta 无 description 时仍有固定高度
          <p className="text-xs text-transparent select-none">-</p>
        )}
        {spark && spark.length > 0 && (
          <div className="pt-1">
            <ResponsiveContainer width="100%" height={40}>
              <AreaChart data={spark} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="30%" stopColor={sparkColor} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={sparkColor} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area
                  type="monotone"
                  dataKey="count"
                  stroke={sparkColor}
                  strokeWidth={1.5}
                  fill={`url(#${gradientId})`}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );

  if (href) {
    return (
      <Link href={href} className="block h-full">
        {card}
      </Link>
    );
  }
  return card;
}

// ─── 2. SwitchableTrendCard：可切换视图图表卡 ───────────────

type SwitchableView = "growth" | "interaction" | "followup";

const VIEW_TABS: Array<{ key: SwitchableView; label: string }> = [
  { key: "growth", label: "新增客户" },
  { key: "interaction", label: "沟通互动" },
  { key: "followup", label: "跟进任务" },
];

interface SwitchableTrendCardProps {
  customerGrowth: AdminTrendsPoint[];
  interactionTrend: AdminTrendsPoint[];
  followUpTaskLoad: AdminTrendsPoint[];
  totals: AdminTrendsResult["totals"];
  days: number;
  onDaysChange: (d: 7 | 30 | 90) => void;
  isLoading?: boolean;
}

export function SwitchableTrendCard({
  customerGrowth,
  interactionTrend,
  followUpTaskLoad,
  totals,
  days,
  onDaysChange,
  isLoading,
}: SwitchableTrendCardProps) {
  const [view, setView] = React.useState<SwitchableView>("growth");
  // 7 天全部显示，30/90 天用 interval 控制密度（大约 8 个刻度）。
  const data = view === "growth" ? customerGrowth : view === "interaction" ? interactionTrend : followUpTaskLoad;
  const interval = data.length <= 7 ? 0 : Math.max(0, Math.ceil(data.length / 8) - 1);

  // 当前视图大数字 + 差异率徽标
  const bigNumber = view === "growth"
    ? totals.newCustomers
    : view === "interaction"
      ? totals.interactions
      : totals.openFollowUpTasksInWindow;
  const tooltipLabel = view === "growth" ? "新增" : view === "interaction" ? "互动" : "到期任务";

  return (
    <Card className="min-w-0 h-full">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          {/* 左侧视图 Tab 组 */}
          <div className="inline-flex items-center rounded-md bg-muted p-0.5">
            {VIEW_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setView(tab.key)}
                className={cn(
                  "rounded px-2 py-0.5 text-xs font-medium transition-colors",
                  view === tab.key
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {/* 右侧时间范围切换 */}
          <RangeTabs days={days} onDaysChange={onDaysChange} />
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold tabular-nums">
            {bigNumber.toLocaleString("zh-CN")}
          </span>
          {/* growth/interaction 有环比徽标；followup 无 prev 显示「差异率 -」 */}
          {view === "growth" ? (
            <TrendBadge current={totals.newCustomers} previous={totals.prevNewCustomers} />
          ) : view === "interaction" ? (
            <TrendBadge current={totals.interactions} previous={totals.prevInteractions} />
          ) : (
            <span className="text-xs text-muted-foreground">差异率 -</span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-[240px] w-full rounded-md" />
        ) : view === "interaction" ? (
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <defs>
                <linearGradient id="switchableInteractionGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="30%" stopColor="var(--chart-2)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={formatTickDate}
                tick={{ fontSize: 12 }}
                interval={interval}
              />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} width={40} />
              <Tooltip
                contentStyle={CHART_TOOLTIP_STYLE}
                labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                labelFormatter={(label) => String(label ?? "")}
                formatter={(value) => [String(value ?? 0), tooltipLabel]}
              />
              <Area
                type="monotone"
                dataKey="count"
                stroke="var(--chart-2)"
                strokeWidth={2}
                fill="url(#switchableInteractionGradient)"
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={formatTickDate}
                tick={{ fontSize: 12 }}
                interval={interval}
              />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} width={40} />
              <Tooltip
                contentStyle={CHART_TOOLTIP_STYLE}
                labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                labelFormatter={(label) => String(label ?? "")}
                formatter={(value) => [String(value ?? 0), tooltipLabel]}
              />
              <Bar
                dataKey="count"
                fill={view === "growth" ? "var(--chart-1)" : "var(--chart-3)"}
                radius={[4, 4, 0, 0]}
                maxBarSize={40}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

// ─── 3. StageDistributionCard：客户阶段分布环形图 ───────────

interface StageDistributionCardProps {
  data: Array<{ stage: string; count: number }>;
  isLoading?: boolean;
}

export function StageDistributionCard({ data, isLoading }: StageDistributionCardProps) {
  // 把 data 映射成含中文 name 的副本，nameKey 指向中文名
  const pieData = data.map((d) => ({
    name: STAGE_LABELS[d.stage] ?? d.stage,
    count: d.count,
    stage: d.stage,
  }));
  const total = pieData.reduce((s, d) => s + d.count, 0);

  return (
    <Card className="min-w-0 h-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">客户阶段分布</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-[240px] w-full rounded-md" />
        ) : pieData.length === 0 ? (
          <div className="h-[240px] flex items-center justify-center text-sm text-muted-foreground">
            暂无客户
          </div>
        ) : (
          <div className="space-y-3">
            {/* 顶部彩色圆点图例（自绘） */}
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {pieData.map((d) => (
                <div key={d.stage} className="flex items-center gap-1 text-xs">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: STAGE_HEX_COLORS[d.stage] ?? "var(--muted-foreground)" }}
                  />
                  <span className="text-muted-foreground">{d.name}</span>
                  <span className="font-medium tabular-nums">{d.count}</span>
                </div>
              ))}
            </div>
            {/* donut：relative 容器 + 绝对定位中心文字 */}
            <div className="relative">
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="count"
                    nameKey="name"
                    innerRadius="55%"
                    outerRadius="80%"
                    paddingAngle={2}
                    stroke="none"
                  >
                    {pieData.map((d) => (
                      <Cell key={d.stage} fill={STAGE_HEX_COLORS[d.stage] ?? "var(--muted-foreground)"} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                    formatter={(value, name) => {
                      const v = Number(value ?? 0);
                      const pct = total > 0 ? ((v / total) * 100).toFixed(1) : "0";
                      return [`${v.toLocaleString("zh-CN")}（${pct}%）`, name];
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              {/* 中心总计 */}
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-xs text-muted-foreground">总计</span>
                <span className="text-lg font-bold tabular-nums">
                  {total.toLocaleString("zh-CN")}
                </span>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── 4. RepAlertBarCard：代表运营异常横向堆叠条形图 ──────────

export interface RepAlertItem {
  representativeId: string;
  name: string;
  overdueFollowUps: number;
  longUnvisitedCount: number;
}

export function RepAlertBarCard({ alerts }: { alerts: RepAlertItem[] }) {
  // 取前 6 名（调用方数据已按 overdue+longUnvisited 降序排序，直接 slice）
  const top = alerts.slice(0, 6);
  const data = top.map((rep) => ({
    name: rep.name,
    逾期: rep.overdueFollowUps,
    未拜访: rep.longUnvisitedCount,
  }));

  return (
    <Card className="min-w-0 h-full">
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm">代表运营异常</CardTitle>
        <Link href="/crm/representatives" className="text-xs text-primary hover:underline">
          查看全部
        </Link>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="h-[240px] flex items-center justify-center text-sm text-muted-foreground">
            暂无异常
          </div>
        ) : (
          <div className="space-y-2">
            <ResponsiveContainer width="100%" height={216}>
              <BarChart
                layout="vertical"
                data={data}
                margin={{ top: 0, right: 8, bottom: 0, left: 8 }}
                barCategoryGap={6}
              >
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={56}
                  tick={{ fontSize: 12 }}
                />
                <Tooltip
                  contentStyle={CHART_TOOLTIP_STYLE}
                  labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                  formatter={(value, name) => [String(value ?? 0), name]}
                />
                <Bar dataKey="逾期" stackId="a" fill="var(--destructive)" barSize={14} />
                <Bar dataKey="未拜访" stackId="a" fill="var(--warning)" radius={[0, 4, 4, 0]} barSize={14} />
              </BarChart>
            </ResponsiveContainer>
            {/* 自绘图例行 */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <div className="flex items-center gap-1 text-xs">
                <span className="inline-block h-2 w-2 rounded-full bg-[var(--destructive)]" />
                <span className="text-muted-foreground">逾期跟进</span>
              </div>
              <div className="flex items-center gap-1 text-xs">
                <span className="inline-block h-2 w-2 rounded-full bg-[var(--warning)]" />
                <span className="text-muted-foreground">长期未拜访</span>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
