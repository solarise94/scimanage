"use client";

import { Check, MapPin, ChevronRight } from "lucide-react";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";
import { openEntityResource } from "./open-resource";

/**
 * CRM checkin result card (saved state).
 * Shown after `crm.create_visit_checkin` is CONFIRMED (adapter maps to
 * `crm.checkin-result`).  `profileId` comes from proposal input via extractProps.
 */
export function CrmCheckinResultCard({
  descriptor,
  onApplyViewIntent,
  onOpenResource,
}: AgentCardProps) {
  const checkin = descriptor.props.checkin as
    | { id: string; status: string; addressSnapshot: string; completedAt: string }
    | undefined;
  const interaction = descriptor.props.interaction as
    | { id: string; type: string }
    | undefined;
  const profileId =
    typeof descriptor.props.profileId === "string" ? descriptor.props.profileId : undefined;
  const customerName =
    typeof descriptor.props.customerName === "string" && descriptor.props.customerName.trim()
      ? descriptor.props.customerName.trim()
      : "客户档案";
  const handlers = { onOpenResource, onApplyViewIntent };

  const body = (
    <>
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100">
          <Check className="h-5 w-5 text-emerald-600" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {profileId ? `${customerName} · 签到成功` : "现场签到已保存"}
          </div>
          {checkin?.addressSnapshot ? (
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <MapPin className="h-3 w-3 shrink-0" />
              <span className="truncate">{checkin.addressSnapshot}</span>
            </div>
          ) : null}
          {checkin?.completedAt ? (
            <div className="text-[11px] text-muted-foreground">
              {new Date(checkin.completedAt).toLocaleString("zh-CN")}
            </div>
          ) : null}
        </div>
        {profileId ? (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />
        ) : null}
      </div>
      {interaction?.id ? (
        <div className="mt-2 text-[10px] text-muted-foreground">
          已生成拜访互动记录
        </div>
      ) : null}
    </>
  );

  return (
    <CardShell title="签到完成" state="saved">
      {profileId ? (
        <button
          type="button"
          className="w-full rounded-xl text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          onClick={() => openEntityResource("customer", profileId, "打开客户详情", handlers)}
        >
          {body}
        </button>
      ) : (
        body
      )}
    </CardShell>
  );
}
