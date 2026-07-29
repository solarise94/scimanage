"use client";

/**
 * AgentResourceRenderer — dispatches a canonical resource location to its
 * embedded View, or to the shared UnsupportedResourceView fallback.
 *
 * Per docs §5.4: unsupported resources must NOT get a summary card pretending
 * to be the page.  They show a clear "open full page" affordance instead.
 */

import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  AgentResourceLocation,
  AgentResourceRequest,
} from "@/lib/agent-resources/types";
import type { ResourceViewMode } from "../resource-navigation-context";
import { CustomerResourceView } from "./customer-resource-view";
import { OrderResourceView } from "./order-resource-view";
import { ProjectResourceView } from "./project-resource-view";
import { TicketResourceView } from "./ticket-resource-view";

const KIND_LABELS: Record<AgentResourceLocation["kind"], string> = {
  crm_customer: "客户档案",
  order: "订单详情",
  project: "项目详情",
  ticket: "工单详情",
  invoice: "发票详情",
};

/**
 * Fallback for resources that don't yet have an embedded View.
 * Shows the canonical title and an "open full page" button — never a fake
 * summary card (docs §5.4).
 */
export function UnsupportedResourceView({
  location,
  onOpenFullPage,
}: {
  location: AgentResourceLocation;
  onOpenFullPage: (href: string) => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted">
        <ExternalLink className="h-5 w-5 text-muted-foreground" />
      </div>
      <div>
        <div className="text-sm font-medium text-foreground">
          {KIND_LABELS[location.kind] ?? "资源"}暂不支持在工作区内查看
        </div>
        <div className="mt-1 text-xs leading-5 text-muted-foreground">
          你可以在新页面打开完整{KIND_LABELS[location.kind] ?? "内容"}。
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={() => onOpenFullPage(location.href)}>
        <ExternalLink className="h-3.5 w-3.5" />
        打开完整页面
      </Button>
    </div>
  );
}

/**
 * Renders the embedded View for the current resource location.
 *
 * @param reloadToken bumped by the Panel/Sheet header to force a refetch
 * @param onOpenResource used by embedded Views to navigate to related resources
 * @param onOpenFullPage used by the Unsupported fallback
 */
export function AgentResourceRenderer({
  location,
  mode,
  reloadToken,
  onOpenResource,
  onOpenFullPage,
}: {
  location: AgentResourceLocation;
  mode: ResourceViewMode;
  reloadToken: number;
  onOpenResource: (request: AgentResourceRequest) => void;
  onOpenFullPage: (href: string) => void;
}) {
  if (location.kind === "crm_customer") {
    return (
      <CustomerResourceView
        location={location}
        mode={mode}
        reloadToken={reloadToken}
        onOpenResource={onOpenResource}
        initialTab={location.initialTab}
      />
    );
  }
  if (location.kind === "order") {
    return (
      <OrderResourceView
        location={location}
        mode={mode}
        reloadToken={reloadToken}
        onOpenResource={onOpenResource}
      />
    );
  }
  if (location.kind === "ticket") {
    return (
      <TicketResourceView
        location={location}
        mode={mode}
        reloadToken={reloadToken}
        onOpenResource={onOpenResource}
      />
    );
  }
  if (location.kind === "project") {
    return (
      <ProjectResourceView
        location={location}
        mode={mode}
        reloadToken={reloadToken}
        onOpenResource={onOpenResource}
      />
    );
  }
  return <UnsupportedResourceView location={location} onOpenFullPage={onOpenFullPage} />;
}
