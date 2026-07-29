"use client";

import { KpiCard } from "@/components/ui/kpi-card";
import { Banknote, Clock, TrendingUp } from "lucide-react";
import type { CollectionSummaryMetrics } from "@/lib/finance/collection-analysis";
import { formatCollectionCycle, formatCollectionRate } from "@/lib/finance/collection-display";
import { DEFAULT_COLLECTION_WINDOW_MONTHS } from "@/lib/finance/collection-analysis";

type CollectionMetricsPanelProps = {
  summary: CollectionSummaryMetrics;
  showRolling?: boolean;
  mergedNote?: boolean;
};

export function CollectionMetricsPanel({
  summary,
  showRolling = false,
  mergedNote = false,
}: CollectionMetricsPanelProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">回款分析</h3>
        <span className="text-xs text-muted-foreground">
          近 {DEFAULT_COLLECTION_WINDOW_MONTHS} 个月已配对
        </span>
      </div>
      {mergedNote && (
        <p className="text-xs text-muted-foreground">含合并前历史客户数据</p>
      )}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <KpiCard
          icon={Clock}
          title="平均回款周期"
          value={formatCollectionCycle(summary.avgCollectionCycleDays, summary.collectionPairCount)}
          description={
            summary.excludedNegativeCycleCount > 0
              ? `${summary.collectionPairCount + summary.excludedNegativeCycleCount} 笔中 ${summary.excludedNegativeCycleCount} 笔因日期异常被排除`
              : summary.usedFallbackCount > 0
                ? `${summary.usedFallbackCount} 笔按创建时间估算`
                : undefined
          }
        />
        <KpiCard
          icon={TrendingUp}
          title="本季回款率"
          value={formatCollectionRate(
            summary.quarterlyReceiptRate,
            summary.quarterlyReceiptAmount,
            summary.quarterlyReceivableAmount,
            summary.quarterlyBelowThreshold,
          )}
          description="同窗口闭环"
        />
        <KpiCard
          icon={Banknote}
          title="本年回款率"
          value={formatCollectionRate(
            summary.yearlyReceiptRate,
            summary.yearlyReceiptAmount,
            summary.yearlyReceivableAmount,
            summary.yearlyBelowThreshold,
          )}
          description="同窗口闭环"
        />
        {showRolling && (
          <KpiCard
            icon={TrendingUp}
            title="滚动窗口回款率"
            value={formatCollectionRate(
              summary.rollingReceiptRate ?? null,
              summary.rollingReceiptAmount ?? 0,
              summary.rollingReceivableAmount ?? 0,
              summary.rollingBelowThreshold ?? true,
            )}
            description="近90天回款 / 近180天下单（滚动窗口）"
          />
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        回款率分子仅统计 direct-order 发票的已配对回款，分母为全部应收；覆盖多订单发票的回款暂无法精确分摊，故比率可能系统性偏低。
      </p>
    </div>
  );
}
