"use client";

import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";

interface CustomerItem {
  profileId: string;
  customerName: string;
  organization?: string;
  stage?: string;
  importance?: string;
  ownerName?: string;
  lastInteractionAt?: string | null;
  followUpCount?: number;
  interactionCount?: number;
}

function formatRelativeTime(value?: string | null) {
  if (!value) return "无互动";
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

/**
 * CRM customer list card.
 *
 * Displays up to 5 customer search results.  Tapping a customer could trigger
 * a follow-up action (get context, prepare checkin).  Bottom button navigates
 * to the full customer list via ViewIntent.
 */
export function CrmCustomerListCard({ descriptor, onApplyViewIntent, onOpenResource }: AgentCardProps) {
  const items = (descriptor.props.items as CustomerItem[]) ?? [];
  const query = descriptor.props.query as string | undefined;

  if (items.length === 0) {
    // Compact empty state — avoid a tall blank card shell.
    return (
      <CardShell title="客户搜索结果" state={descriptor.state}>
        <div className="text-sm text-muted-foreground">
          没有找到符合条件的客户{query ? `（${query}）` : ""}。试试用客户名、机构或负责人关键词搜索。
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell
      title={`客户搜索结果（${items.length}）`}
      state={descriptor.state}
      footer={
        <Button
          variant="ghost"
          size="sm"
          className="w-full text-xs"
          onClick={() => onApplyViewIntent({
            type: "navigate",
            route: "/crm/customers",
            label: "查看完整客户列表",
          })}
        >
          查看完整客户列表
          <ChevronRight className="h-3 w-3" />
        </Button>
      }
    >
      <div className="divide-y divide-border/50 overflow-hidden border-y border-border/40">
        {items.slice(0, 5).map((item) => {
          const openable = Boolean(item.profileId);
          const handleOpen = () => {
            if (!item.profileId) return;
            if (onOpenResource) {
              onOpenResource({
                type: "entity",
                entityType: "customer",
                entityId: item.profileId,
                label: item.customerName || "打开客户详情",
              });
              return;
            }
            onApplyViewIntent({
              type: "navigate",
              route: `/crm/customers/${item.profileId}`,
              label: "打开客户详情",
            });
          };
          return (
            <button
              key={item.profileId}
              type="button"
              disabled={!openable}
              onClick={handleOpen}
              className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-muted/30 disabled:cursor-default"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{item.customerName}</div>
                <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
                  {item.organization || "无机构"}
                  {" · "}
                  {formatRelativeTime(item.lastInteractionAt)}
                </div>
              </div>
              {item.followUpCount && item.followUpCount > 0 ? (
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                  {item.followUpCount} 待跟进
                </span>
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50" />
              )}
            </button>
          );
        })}
      </div>
    </CardShell>
  );
}
