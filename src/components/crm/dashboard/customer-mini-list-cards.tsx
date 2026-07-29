"use client";

/**
 * ADMIN 运营管理台底部客户数据列表的迷你卡片组件。
 *
 * 这些卡片放进响应式 grid 中自适应宽度、等高排列（桌面 xl 4 列、md 2 列、移动 1 列）：
 * - CustomerMiniListCard：通用客户行迷你卡（支持 renderRight / renderBadge）
 * - MiniInteractionsCard：最近沟通迷你卡（类型 Badge + summary + 客户名/日期）
 *
 * 字段来源：CrmDashboardCustomerRow；INTERACTION_TYPE_LABELS 复用自 @/lib/crm/constants。
 */

import * as React from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CrmEmptyState } from "@/components/crm/empty-state";
import { INTERACTION_TYPE_LABELS } from "@/lib/crm/constants";
import { Users, MessageSquare } from "lucide-react";
import type { CrmDashboardCustomerRow } from "@/lib/crm/types";

// ─── 1. 通用客户行迷你卡 ─────────────────────────────────────

interface CustomerMiniListCardProps {
  title: string;
  rows: CrmDashboardCustomerRow[];
  emptyTitle: string;
  /** 有则在标题右侧显示「查看全部」。 */
  viewAllHref?: string;
  /** 默认 5。 */
  limit?: number;
  /** 行右元信息（如最近下单日期、有效订单数）。 */
  renderRight?: (row: CrmDashboardCustomerRow) => React.ReactNode;
  /** 客户名下方一行的徽标（如「复购」/ 告警原因）。 */
  renderBadge?: (row: CrmDashboardCustomerRow) => React.ReactNode;
}

export function CustomerMiniListCard({
  title,
  rows,
  emptyTitle,
  viewAllHref,
  limit = 5,
  renderRight,
  renderBadge,
}: CustomerMiniListCardProps) {
  const visibleRows = rows.slice(0, limit);

  return (
    <Card className="min-w-0 flex flex-col h-full">
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm">{title}</CardTitle>
        {viewAllHref && (
          <Link href={viewAllHref} className="text-xs text-primary hover:underline">
            查看全部
          </Link>
        )}
      </CardHeader>
      <CardContent className="flex-1 p-0">
        {visibleRows.length === 0 ? (
          <CrmEmptyState icon={Users} title={emptyTitle} className="py-6" />
        ) : (
          <div className="divide-y">
            {visibleRows.map((row) => {
              const badge = renderBadge?.(row);
              return (
                <Link
                  key={row.profileId}
                  href={`/crm/customers/${row.profileId}`}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-2 hover:bg-muted/60 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{row.customerName}</div>
                    {badge && <div className="mt-1">{badge}</div>}
                    <div className="text-[11px] text-muted-foreground truncate">
                      {row.organization || "-"}
                    </div>
                  </div>
                  {renderRight && (
                    <div className="shrink-0 text-xs text-muted-foreground">
                      {renderRight(row)}
                    </div>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── 3. 最近沟通迷你卡 ───────────────────────────────────────

/**
 * 最近沟通迷你卡的行数据。
 * 兼容 admin-overview 返回的 recentInteractions 行结构（含 id/name）以及
 * CrmInteractionItem 的可选 name 字段，因此 name 都设为可选并允许 null。
 */
export interface MiniInteractionItem {
  id: string;
  profileId: string;
  type: string;
  summary: string;
  happenedAt: string;
  profile?: { name?: string | null } | null;
  createdByUser: { name: string };
}

export function MiniInteractionsCard({ interactions }: { interactions: MiniInteractionItem[] }) {
  const visible = interactions.slice(0, 6);

  return (
    <Card className="min-w-0 flex flex-col h-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">最近沟通</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 p-0">
        {visible.length === 0 ? (
          <CrmEmptyState icon={MessageSquare} title="暂无记录" className="py-6" />
        ) : (
          <div className="divide-y">
            {visible.map((i) => (
              <Link
                key={i.id}
                href={`/crm/customers/${i.profileId}?tab=interactions&interactionId=${i.id}`}
                className="block rounded-md px-2 py-2 hover:bg-muted/60 transition-colors"
              >
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline" className="text-[10px] shrink-0">
                    {INTERACTION_TYPE_LABELS[i.type] || i.type}
                  </Badge>
                  <span className="text-sm truncate">{i.summary}</span>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground truncate">
                  {i.profile?.name ? `${i.profile.name} · ` : ""}
                  {new Date(i.happenedAt).toLocaleDateString("zh-CN")}
                </div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
