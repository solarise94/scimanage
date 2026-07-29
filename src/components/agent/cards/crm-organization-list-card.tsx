"use client";

import { Building2 } from "lucide-react";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";

interface OrganizationBindingItem {
  id: string;
  organizationName: string;
  siteName?: string;
  status: string;
  isPrimary?: string;
}

function statusLabel(status: string) {
  switch (status) {
    case "ACTIVE":
      return "已绑定";
    case "PENDING":
      return "审核中";
    case "REJECTED":
      return "已拒绝";
    case "INACTIVE":
      return "已停用";
    default:
      return status || "未知";
  }
}

/**
 * Read-only list of the current representative's organization bindings.
 * Consumes `crm.list_my_organizations` output `{ items: [...] }`.
 */
export function CrmOrganizationListCard({ descriptor }: AgentCardProps) {
  const items = (descriptor.props.items as OrganizationBindingItem[]) ?? [];

  if (items.length === 0) {
    return (
      <CardShell title="我的单位绑定" state={descriptor.state}>
        <div className="text-sm text-muted-foreground">
          暂无单位绑定。可以说「申请绑定某某单位」发起新申请。
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell title={`我的单位绑定（${items.length}）`} state={descriptor.state}>
      <div className="divide-y divide-border/50 overflow-hidden border-y border-border/40">
        {items.map((item) => (
          <div key={item.id} className="flex items-start gap-3 px-3.5 py-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/60">
              <Building2 className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {item.organizationName || "未命名单位"}
                {item.isPrimary === "true" ? (
                  <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">主单位</span>
                ) : null}
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {item.siteName ? `${item.siteName} · ` : ""}
                {statusLabel(item.status)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </CardShell>
  );
}
