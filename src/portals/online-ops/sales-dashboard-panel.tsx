"use client";

/**
 * 销量看板（ONLINE_OPS 门户 P2，设计 §10）。
 *
 * 基于共享 Order facts 的本部门聚合（金额/单量/按状态/周趋势），只读。
 * 数据走 /api/online-ops/sales-dashboard（内部复用 getOrderScopeWhere 部门隔离）。
 * 金额单位与 Order.totalAmount 一致（分），展示时转元。
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ORDER_STATUS } from "@/lib/orders/constants";

type DashboardData = {
  totals: { amount: number; count: number };
  byStatus: Array<{ status: string; amount: number; count: number }>;
  trend: Array<{ weekStart: string; amount: number; count: number }>;
  filters: { dateFrom: string | null; dateTo: string | null };
};

const STATUS_LABELS: Record<string, string> = {
  [ORDER_STATUS.DRAFT]: "草稿",
  [ORDER_STATUS.CONFIRMED]: "已确认",
  [ORDER_STATUS.DELIVERED]: "已交付",
  [ORDER_STATUS.CLOSED]: "已关闭",
};

function fenToYuan(fen: number): string {
  return (fen / 100).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const QUERY_KEY = ["online-ops", "sales-dashboard"] as const;

export function OnlineOpsSalesDashboardPanel() {
  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/online-ops/sales-dashboard");
      if (!res.ok) throw new Error("加载失败");
      return res.json();
    },
  });

  const maxTrendAmount = useMemo(() => {
    const amounts = (data?.trend ?? []).map((t) => t.amount);
    return amounts.length > 0 ? Math.max(...amounts, 1) : 1;
  }, [data]);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              订单总金额（本部门）
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              ¥ {data ? fenToYuan(data.totals.amount) : "—"}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              订单总数
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {data ? data.totals.count : "—"}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              数据口径
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              统一订单事实，按当前部门 scope 聚合；金额单位元。
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">按订单状态分布</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : (data?.byStatus ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无数据</p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {(data?.byStatus ?? []).map((s) => (
                <div
                  key={s.status}
                  className="flex flex-col gap-1 rounded-lg border p-3 min-w-[140px]"
                >
                  <Badge variant="secondary">
                    {STATUS_LABELS[s.status] ?? s.status}
                  </Badge>
                  <span className="text-lg font-semibold">
                    ¥ {fenToYuan(s.amount)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {s.count} 单
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">近 12 周趋势</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : (data?.trend ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无趋势数据</p>
          ) : (
            <div className="flex items-end gap-1 h-40">
              {(data?.trend ?? []).map((t) => (
                <div
                  key={t.weekStart}
                  className="flex-1 flex flex-col items-center gap-1"
                  title={`${t.weekStart}：¥${fenToYuan(t.amount)} / ${t.count} 单`}
                >
                  <div
                    className="w-full bg-primary/80 rounded-t"
                    style={{
                      height: `${Math.max(2, (t.amount / maxTrendAmount) * 100)}%`,
                    }}
                  />
                  <span className="text-[10px] text-muted-foreground">
                    {t.weekStart.slice(5)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
