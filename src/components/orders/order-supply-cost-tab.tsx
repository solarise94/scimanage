"use client";

/**
 * 订单抽屉「供应/成本」Tab。
 *
 * 展示：
 * - 成本口径选择器（REAL_ONLY / REAL_PLUS_CIRCULATION / FULL）
 * - 真实成本、流通成本、税费成本
 * - 供应链毛利、经营毛利、净贡献
 * - 当前供应方案状态
 * - 应付/已付/待付（来自财务模块付款摘要）
 *
 * 金额单位：API 返回元（已由 centsToYuan 转换）。
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, AlertCircle, Lock, Unlock, Link2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MoneyText } from "@/components/ui/money-text";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectDisplay,
} from "@/components/ui/select";
import { OrderLineMappingPanel } from "@/components/supply-chain/order-line-mapping-panel";

interface OrderSupplyCostTabProps {
  orderId: string;
  role?: string | null;
  onChanged?: () => void;
}

const BASIS_LABELS: Record<string, string> = {
  REAL_ONLY: "真实成本",
  REAL_PLUS_CIRCULATION: "真实+流通",
  FULL: "全成本",
};

const PLAN_STATUS_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  DRAFT: { label: "草稿", variant: "secondary" },
  QUOTED: { label: "已报价", variant: "secondary" },
  NEGOTIATING: { label: "议价中", variant: "secondary" },
  SELECTED: { label: "已选择", variant: "default" },
  LOCKED: { label: "已锁定", variant: "default" },
  SUPERSEDED: { label: "已替代", variant: "outline" },
  CANCELLED: { label: "已取消", variant: "destructive" },
};

export function OrderSupplyCostTab({ orderId, role }: OrderSupplyCostTabProps) {
  const [basis, setBasis] = useState("FULL");

  const canAccess = role === "ADMIN" || role === "USER" || role === "REGIONAL_MANAGER";

  const { data: marginData, isLoading: marginLoading } = useQuery({
    queryKey: ["costing", "order-margin", orderId, basis],
    queryFn: async () => {
      const res = await fetch(`/api/costing/order-margin?orderId=${orderId}&basis=${basis}`);
      if (!res.ok) throw new Error("加载成本失败");
      return res.json();
    },
    enabled: canAccess && !!orderId,
  });

  const { data: plansData } = useQuery({
    queryKey: ["supply", "plans", "order", orderId],
    queryFn: async () => {
      const res = await fetch(`/api/supply/plans?orderId=${orderId}&pageSize=10`);
      if (!res.ok) throw new Error("加载供应方案失败");
      return res.json();
    },
    enabled: canAccess && !!orderId,
  });

  if (!canAccess) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">当前角色无权查看成本与供应信息。</p>
      </Card>
    );
  }

  if (marginLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const plans: Array<Record<string, unknown>> = plansData?.plans ?? [];
  const activePlan = plans.find((p) => ["SELECTED", "LOCKED"].includes(p.status as string));

  return (
    <div className="space-y-4">
      {/* 口径选择器 */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">成本口径：</span>
        <Select value={basis} onValueChange={(v) => { if (v) setBasis(v); }}>
          <SelectTrigger className="h-8 w-[140px]">
            <SelectDisplay label="口径" valueLabel={BASIS_LABELS[basis]} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="REAL_ONLY">真实成本</SelectItem>
            <SelectItem value="REAL_PLUS_CIRCULATION">真实+流通</SelectItem>
            <SelectItem value="FULL">全成本</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* 订单行服务项映射 */}
      <Card className="p-3">
        <div className="flex items-center gap-1.5 mb-2 text-sm font-medium">
          <Link2 className="h-4 w-4 text-muted-foreground" />
          订单行服务项映射
        </div>
        <OrderLineMappingPanel orderId={orderId} />
      </Card>

      {/* 成本摘要 */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">真实成本</div>
          <MoneyText value={marginData?.costSummary?.realCost ?? 0} className="text-lg font-medium" />
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">流通成本</div>
          <MoneyText value={marginData?.costSummary?.circulationCost ?? 0} className="text-lg font-medium" />
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">税费成本</div>
          <MoneyText value={marginData?.costSummary?.taxCost ?? 0} className="text-lg font-medium" />
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">总成本</div>
          <MoneyText value={marginData?.costSummary?.totalCost ?? 0} className="text-lg font-medium" />
        </Card>
      </div>

      {/* 利润 */}
      <Card className="p-4">
        <h4 className="mb-3 text-sm font-medium">利润口径</h4>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">订单收入</span>
            <MoneyText value={marginData?.revenue ?? 0} className="font-medium" />
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">供应链毛利（收入-真实）</span>
            <MoneyText value={marginData?.supplyChainGrossMargin ?? 0} className="font-medium" />
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">经营毛利（收入-真实-流通）</span>
            <MoneyText value={marginData?.operatingGrossMargin ?? 0} className="font-medium" />
          </div>
          <div className="flex justify-between border-t pt-2">
            <span className="font-medium">净贡献（收入-真实-流通-税费）</span>
            <MoneyText value={marginData?.netContribution ?? 0} className="font-medium text-primary" />
          </div>
          {marginData?.netContributionRate != null && (
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>净贡献率</span>
              <span>{(marginData.netContributionRate * 100).toFixed(1)}%</span>
            </div>
          )}
        </div>
      </Card>

      {/* 供应方案 */}
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h4 className="text-sm font-medium">供应方案</h4>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open(`/supply-chain/compare`, "_blank")}
          >
            比价工具
          </Button>
        </div>
        {activePlan ? (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              {activePlan.status === "LOCKED" ? (
                <Lock className="h-4 w-4 text-green-600" />
              ) : (
                <Unlock className="h-4 w-4 text-muted-foreground" />
              )}
              <span className="font-medium">{String(activePlan.name ?? activePlan.id)}</span>
              <Badge variant={PLAN_STATUS_LABELS[activePlan.status as string]?.variant ?? "secondary"}>
                {PLAN_STATUS_LABELS[activePlan.status as string]?.label ?? activePlan.status}
              </Badge>
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>方案类型：{String(activePlan.planType ?? "—")}</span>
              <span>锁定成本：<MoneyText value={Number(activePlan.totalLockedCost ?? activePlan.totalQuotedCost ?? 0)} /></span>
            </div>
          </div>
        ) : plans.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            当前有 {plans.length} 个方案，无活跃方案。
          </p>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertCircle className="h-4 w-4" />
            <span>暂无供应方案。可前往比价工具生成候选方案。</span>
          </div>
        )}
      </Card>
    </div>
  );
}
