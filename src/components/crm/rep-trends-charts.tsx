"use client";

/** 代表运营趋势图表组件 — 三张月度趋势图 */

import {
  ComposedChart,
  LineChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CHART_TOOLTIP_LABEL_STYLE, CHART_TOOLTIP_STYLE } from "@/components/dashboard/chart-style";
import { SimpleTable } from "@/components/ui/simple-table";
import type {
  MonthlyGrowthPoint,
  MonthlyAovPoint,
  CategoryConversionPoint,
  CategoryConversionDetail,
} from "@/lib/crm/types";

// ─── helpers ────────────────────────────────────────────────

function formatYuan(cents: number): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function formatGrowth(rate: number | null): string {
  if (rate === null) return "—";
  const sign = rate >= 0 ? "+" : "";
  return `${sign}${Math.round(rate * 100)}%`;
}

// ─── 1. 月度客户增长 ────────────────────────────────────────

interface CustomerGrowthChartProps {
  data: MonthlyGrowthPoint[];
}

export function CustomerGrowthChart({ data }: CustomerGrowthChartProps) {
  if (data.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle>月度客户增长</CardTitle></CardHeader>
        <CardContent>
          <div className="h-[250px] flex items-center justify-center text-muted-foreground text-sm">
            暂无客户增长数据
          </div>
        </CardContent>
      </Card>
    );
  }
  const hasNew = data.some((d) => d.newCount > 0);

  return (
    <Card>
      <CardHeader><CardTitle>月度客户增长</CardTitle></CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={250}>
          <ComposedChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="month" tick={{ fontSize: 12 }} />
            <YAxis
              yAxisId="left"
              allowDecimals={false}
              tick={{ fontSize: 12 }}
              label={{ value: "新增客户", angle: -90, position: "insideLeft", style: { fontSize: 11 } }}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              allowDecimals={false}
              tick={{ fontSize: 12 }}
              label={{ value: "累计客户", angle: 90, position: "insideRight", style: { fontSize: 11 } }}
            />
            <Tooltip
              contentStyle={CHART_TOOLTIP_STYLE}
              labelStyle={CHART_TOOLTIP_LABEL_STYLE}
              formatter={(value, name) => [String(value ?? ""), name === "newCount" ? "本月新增" : "累计客户"]}
              labelFormatter={(label) => `${label}`}
            />
            <Legend formatter={(v) => (v === "newCount" ? "本月新增" : "累计客户")} />
            <Bar yAxisId="left" dataKey="newCount" fill="var(--chart-1)" radius={[3, 3, 0, 0]} maxBarSize={40} />
            <Line yAxisId="right" type="monotone" dataKey="cumulative" stroke="var(--chart-2)" strokeWidth={2} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
        {!hasNew && (
          <p className="text-xs text-muted-foreground mt-2">近 {data.length} 个月无新增客户</p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── 2. 月度客单价趋势 ──────────────────────────────────────

interface AovChartProps {
  data: MonthlyAovPoint[];
}

export function AverageOrderValueChart({ data }: AovChartProps) {
  if (data.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle>客单价趋势（确认额口径）</CardTitle></CardHeader>
        <CardContent>
          <div className="h-[250px] flex items-center justify-center text-muted-foreground text-sm">
            暂无客单价数据
          </div>
        </CardContent>
      </Card>
    );
  }

  const hasData = data.some((d) => d.orderCount > 0);
  const chartData = data.map((d) => ({
    month: d.month,
    avgOrderValue: d.avgOrderValue,
    growthLabel: d.growthRate !== null ? formatGrowth(d.growthRate) : "",
  }));

  return (
    <Card>
      <CardHeader><CardTitle>客单价趋势（确认额口径）</CardTitle></CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="month" tick={{ fontSize: 12 }} />
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 12 }}
              tickFormatter={(v: number) => formatYuan(v)}
            />
            <Tooltip
              contentStyle={CHART_TOOLTIP_STYLE}
              labelStyle={CHART_TOOLTIP_LABEL_STYLE}
              formatter={(value) => [formatYuan(Number(value ?? 0)), "客单价（确认额）"]}
              labelFormatter={(label) => `${label}`}
            />
            <Line
              type="monotone"
              dataKey="avgOrderValue"
              stroke="var(--chart-3)"
              strokeWidth={2}
              dot={{ r: 4 }}
              name="客单价（确认额）"
            />
          </LineChart>
        </ResponsiveContainer>
        {hasData && (
          <div className="flex flex-wrap gap-2 mt-3 text-xs text-muted-foreground">
            {data.filter((d) => d.growthRate !== null).map((d) => (
              <span key={d.month}>
                {d.month} 环比{" "}
                <span className={d.growthRate! >= 0 ? "text-success" : "text-danger"}>
                  {formatGrowth(d.growthRate)}
                </span>
              </span>
            ))}
          </div>
        )}
        {!hasData && (
          <p className="text-xs text-muted-foreground mt-2">近 {data.length} 个月无有效订单</p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── 3. 复购客户商品→服务转化 ──────────────────────────────

interface ConversionChartProps {
  points: CategoryConversionPoint[];
  details: CategoryConversionDetail[];
}

export function CategoryConversionChart({ points, details }: ConversionChartProps) {
  if (points.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle>商品→服务转化</CardTitle></CardHeader>
        <CardContent>
          <div className="h-[250px] flex items-center justify-center text-muted-foreground text-sm">
            暂无转化数据
          </div>
        </CardContent>
      </Card>
    );
  }

  const hasData = points.some((d) => d.repeatCustomerCount > 0);
  const chartData = points.map((d) => ({
    ...d,
    conversionRatePct: Math.round(d.conversionRate * 100),
  }));

  const categoryLabel: Record<string, string> = {
    SERVICE: "服务",
    PRODUCT: "商品",
    MIXED: "混合",
    UNKNOWN: "未分类",
  };

  return (
    <Card>
      <CardHeader><CardTitle>商品→服务转化</CardTitle></CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={250}>
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="month" tick={{ fontSize: 12 }} />
            <YAxis
              yAxisId="left"
              allowDecimals={false}
              tick={{ fontSize: 12 }}
              label={{ value: "客户数", angle: -90, position: "insideLeft", style: { fontSize: 11 } }}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              allowDecimals={false}
              tick={{ fontSize: 12 }}
              domain={[0, 100]}
              tickFormatter={(v: number) => `${v}%`}
            />
            <Tooltip
              contentStyle={CHART_TOOLTIP_STYLE}
              labelStyle={CHART_TOOLTIP_LABEL_STYLE}
              formatter={(value, name) => {
                const v = Number(value ?? 0);
                if (name === "conversionRatePct") return [`${v}%`, "转化率"];
                if (name === "repeatCustomerCount") return [v, "复购客户"];
                if (name === "convertedToServiceCount") return [v, "转化客户"];
                return [v, String(name ?? "")];
              }}
              labelFormatter={(label) => `${label}`}
            />
            <Legend
              formatter={(v: string) => {
                if (v === "repeatCustomerCount") return "复购客户";
                if (v === "convertedToServiceCount") return "商品→服务";
                if (v === "conversionRatePct") return "转化率";
                return v;
              }}
            />
            <Bar
              yAxisId="left"
              dataKey="repeatCustomerCount"
              fill="var(--chart-4)"
              radius={[3, 3, 0, 0]}
              maxBarSize={30}
            />
            <Bar
              yAxisId="left"
              dataKey="convertedToServiceCount"
              fill="var(--chart-5)"
              radius={[3, 3, 0, 0]}
              maxBarSize={30}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="conversionRatePct"
              stroke="var(--chart-1)"
              strokeWidth={2}
              dot={{ r: 3 }}
            />
          </ComposedChart>
        </ResponsiveContainer>

        {details.length > 0 && (
          <div className="mt-4 border rounded-md overflow-hidden">
            <SimpleTable
              columns={[
                { key: "customerName", header: "客户" },
                {
                  key: "firstOrderCategory",
                  header: "首单分类",
                  render: (d) => categoryLabel[d.firstOrderCategory] || d.firstOrderCategory,
                },
                {
                  key: "firstOrderAt",
                  header: "首单时间",
                  render: (d) =>
                    d.firstOrderAt
                      ? new Date(d.firstOrderAt).toLocaleDateString("zh-CN")
                      : "—",
                },
                {
                  key: "firstServiceOrderAt",
                  header: "首笔服务时间",
                  render: (d) =>
                    d.firstServiceOrderAt
                      ? new Date(d.firstServiceOrderAt).toLocaleDateString("zh-CN")
                      : "—",
                },
              ]}
              data={details}
              keyExtractor={(d) => d.profileId}
              emptyTitle="暂无转化数据"
            />
          </div>
        )}

        {!hasData && (
          <p className="text-xs text-muted-foreground mt-2">近 {points.length} 个月无复购订单</p>
        )}
      </CardContent>
    </Card>
  );
}
