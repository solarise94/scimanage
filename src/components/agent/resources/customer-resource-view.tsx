"use client";

/**
 * CustomerResourceView — embedded customer detail for the Agent workspace.
 *
 * This is the first concrete Resource View (see
 * docs/agent-resource-panel-mobile-resource-view-upgrade-plan-2026-07-21.md §5.2).
 *
 * Design rules (from the plan):
 *   - Shares `crmKeys.profile(profileId)` with the standalone page so the
 *     TanStack Query cache is unified — opening the resource after viewing the
 *     page is instant, and mutations on either side refresh both.
 *   - Uses the existing `/api/crm/profiles/[id]` endpoint — no second API.
 *   - Compact layout (no PageShell, no full-bleed header) suitable for both
 *     the desktop right-hand Panel and the mobile full-screen Sheet.
 *   - Read-only fields render inline; write actions (interaction / checkin /
 *     follow-up) reuse the existing Dialog components the standalone page uses.
 *   - Relation-customer links navigate via `useResourceNavigation()` so they
 *     push onto the Agent resource history instead of leaving the workspace.
 *
 * Tab structure: the View adds three read Tabs beyond the core overview —
 * 关系 / 偏好 / 别称 — by reusing the same panel components the standalone
 * page uses (`RelationsTab`, `CustomerPreferencePanel`,
 * `CustomerNameAliasPanel`).  `initialTab` selects the default Tab so deep
 * links (e.g. from an agent intent) can land directly on a section.  Tabs
 * scroll horizontally inside the narrow Panel/Sheet viewport.
 *
 * This View does NOT attempt to reproduce every Tab of the 1023-line
 * standalone page.  It focuses on the core read + quick-action surface that
 * satisfies the plan's primary scenario (search → open → act → return).  The
 * "open full page" affordance in the Panel/Sheet header covers deeper tasks.
 */

import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import Link from "next/link";
import {
  AlertCircle,
  Building2,
  Mail,
  MapPin,
  MessageSquare,
  ClipboardCheck,
  Pencil,
  Phone,
  User as UserIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StageBadge, ImportanceBadge } from "@/components/crm/badges";
import { CheckinFlow } from "@/components/crm/checkin-flow";
import { CustomerEditDialog } from "@/components/crm/customer-edit-dialog";
import { FollowUpFormDialog } from "@/components/crm/follow-up-form-dialog";
import { InteractionFormDialog } from "@/components/crm/interaction-form-dialog";
import { ComplaintFormDialog } from "@/components/crm/complaint-form-dialog";
import { RelationsTab } from "@/components/crm/relations-tab";
import { CustomerPreferencePanel } from "@/components/crm/customer-preference-panel";
import { CustomerNameAliasPanel } from "@/components/crm/customer-name-alias-panel";
import { crmKeys } from "@/lib/crm/query-keys";
import {
  ResourceNavigationEmbeddedProvider,
  useResourceNavigation,
  type ResourceViewMode,
} from "../resource-navigation-context";
import type {
  AgentResourceLocation,
  AgentResourceRequest,
} from "@/lib/agent-resources/types";

interface CustomerViewData {
  profile: {
    id: string;
    stage: string;
    importance: string;
    archived: boolean;
    ownerUser?: { name?: string | null };
    customerView?: {
      name: string | null;
      customerCode: string | null;
      organization: string | null;
      principal: string | null;
      labOrGroup: string | null;
      email: string | null;
      phone: string | null;
      wechat: string | null;
      address: string | null;
    };
    _count?: {
      interactions?: number;
      visitCheckins?: number;
      followUpTasks?: number;
    };
  };
  preferenceSummary?: unknown;
  openComplaint?: unknown;
  lifecycle?: unknown;
}

function DetailRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null | undefined;
}) {
  const display = typeof value === "string" ? value.trim() : "";
  return (
    <div className="flex items-center gap-2 px-3.5 py-2 text-sm">
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-foreground">{display || "-"}</span>
    </div>
  );
}

/** Tabs offered in the embedded View, in display order. */
const CUSTOMER_VIEW_TABS = ["overview", "relations", "preferences", "name-aliases"] as const;
type CustomerViewTab = (typeof CUSTOMER_VIEW_TABS)[number];

/**
 * Validate the initialTab hint against the embeddable Tab set.  Unknown or
 * missing values fall back to "overview" so a stale/typo link can never land
 * the user on a blank Tab.
 */
function resolveInitialTab(initialTab?: string): CustomerViewTab {
  return (CUSTOMER_VIEW_TABS as readonly string[]).includes(initialTab ?? "")
    ? (initialTab as CustomerViewTab)
    : "overview";
}

function CustomerResourceViewInner({
  location,
  mode,
  reloadToken,
  initialTab,
}: {
  location: AgentResourceLocation;
  mode: ResourceViewMode;
  reloadToken: number;
  initialTab?: string;
}) {
  const profileId = location.entityId;
  const { data: session } = useSession();
  const { onNavigateResource } = useResourceNavigation();
  const [editOpen, setEditOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<CustomerViewTab>(resolveInitialTab(initialTab));
  const [quickDialog, setQuickDialog] = useState<
    "interaction" | "checkin" | "followup" | "complaint" | null
  >(null);
  const clearQuickDialog = () => setQuickDialog(null);

  const { data, isLoading, error, refetch } = useQuery<CustomerViewData>({
    queryKey: crmKeys.profile(profileId),
    queryFn: async () => {
      const res = await fetch(`/api/crm/profiles/${profileId}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("加载 CRM 档案失败");
      return res.json();
    },
    refetchOnMount: "always",
  });

  // reloadToken bumps when the user hits "refresh" in the panel header.
  // We don't put it in the queryKey (that would break cache sharing with the
  // standalone page); instead we imperatively refetch when it changes.
  // Track the consumed token so a history back/forward remount (which already
  // refetches via refetchOnMount:"always") doesn't fire a duplicate request.
  const consumedReloadTokenRef = useRef(reloadToken);
  useEffect(() => {
    if (reloadToken === consumedReloadTokenRef.current) return;
    consumedReloadTokenRef.current = reloadToken;
    void refetch();
  }, [reloadToken, refetch]);

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
          <div className="flex items-center gap-2 font-medium">
            <AlertCircle className="h-4 w-4" />
            加载失败
          </div>
          <p className="mt-1 text-destructive/80">
            {error instanceof Error ? error.message : "请稍后重试"}
          </p>
        </div>
      </div>
    );
  }

  if (!data?.profile) {
    return (
      <div className="p-4">
        <div className="rounded-lg border p-6 text-center">
          <h2 className="text-base font-medium">未找到 CRM 档案</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            该客户可能尚未纳入 CRM 或已被删除
          </p>
        </div>
      </div>
    );
  }

  const profile = data.profile;
  const cv = profile.customerView;
  const profileName = cv?.name || "未命名客户";
  const canEdit =
    session?.user?.role === "ADMIN" ||
    session?.user?.role === "USER" ||
    (session?.user?.role === "REPRESENTATIVE" &&
      profile.ownerUser != null);

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="rounded-xl border border-border/50 bg-muted/20 p-3">
        <div className="text-sm font-semibold text-foreground">{profileName}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {cv?.customerCode || "未设置编号"}
          {cv?.organization ? ` · ${cv.organization}` : ""}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <StageBadge stage={profile.stage} />
          <ImportanceBadge importance={profile.importance} />
          {profile.archived ? <Badge variant="secondary">已归档</Badge> : null}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border/40">
        <DetailRow icon={<UserIcon className="h-3.5 w-3.5" />} label="负责人" value={cv?.principal} />
        <DetailRow icon={<Building2 className="h-3.5 w-3.5" />} label="单位" value={cv?.organization} />
        <DetailRow icon={<Phone className="h-3.5 w-3.5" />} label="电话" value={cv?.phone} />
        <DetailRow icon={<Mail className="h-3.5 w-3.5" />} label="邮箱" value={cv?.email} />
        <DetailRow icon={<MessageSquare className="h-3.5 w-3.5" />} label="微信" value={cv?.wechat} />
        {cv?.labOrGroup ? (
          <DetailRow icon={<UserIcon className="h-3.5 w-3.5" />} label="课题组" value={cv?.labOrGroup} />
        ) : null}
        {cv?.address ? (
          <DetailRow icon={<MapPin className="h-3.5 w-3.5" />} label="地址" value={cv?.address} />
        ) : null}
      </div>

      {mode !== "page" ? (
        <div className="grid grid-cols-2 gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-auto flex-col items-center gap-1 rounded-lg border-border/50 bg-card py-2.5"
            onClick={() => setQuickDialog("interaction")}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            <span className="text-[11px]">记沟通</span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-auto flex-col items-center gap-1 rounded-lg border-border/50 bg-card py-2.5"
            onClick={() => setQuickDialog("checkin")}
          >
            <MapPin className="h-3.5 w-3.5" />
            <span className="text-[11px]">签到</span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-auto flex-col items-center gap-1 rounded-lg border-border/50 bg-card py-2.5"
            onClick={() => setQuickDialog("followup")}
          >
            <ClipboardCheck className="h-3.5 w-3.5" />
            <span className="text-[11px]">跟进</span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-auto flex-col items-center gap-1 rounded-lg border-border/50 bg-card py-2.5"
            onClick={() => setQuickDialog("complaint")}
          >
            <AlertCircle className="h-3.5 w-3.5" />
            <span className="text-[11px]">客诉</span>
          </Button>
        </div>
      ) : null}

      {canEdit ? (
        <Button variant="ghost" size="sm" className="w-full text-xs" onClick={() => setEditOpen(true)}>
          <Pencil className="h-3 w-3" /> 编辑客户
        </Button>
      ) : null}

      <div className="rounded-xl border border-border/40 bg-muted/15 p-3 text-xs text-muted-foreground">
        沟通 {profile._count?.interactions ?? 0} · 签到 {profile._count?.visitCheckins ?? 0} · 跟进 {profile._count?.followUpTasks ?? 0}
        <div className="mt-1">
          <Link
            href={`/crm/customers/${profileId}`}
            className="text-sky-700 underline underline-offset-2 hover:text-sky-800"
          >
            打开完整客户档案
          </Link>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(resolveInitialTab(typeof v === "string" ? v : undefined))}>
        <div className="overflow-x-auto [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden">
          <TabsList className="inline-flex h-9 w-auto gap-1 bg-muted/40 p-1">
            <TabsTrigger value="overview" className="px-3 text-xs whitespace-nowrap">概览</TabsTrigger>
            <TabsTrigger value="relations" className="px-3 text-xs whitespace-nowrap">关系</TabsTrigger>
            <TabsTrigger value="preferences" className="px-3 text-xs whitespace-nowrap">偏好</TabsTrigger>
            <TabsTrigger value="name-aliases" className="px-3 text-xs whitespace-nowrap">别称</TabsTrigger>
          </TabsList>
        </div>

        {activeTab === "relations" ? (
          <div className="mt-2">
            <RelationsTab
              profileId={profile.id}
              customerName={profileName}
              onNavigateCustomer={
                onNavigateResource
                  ? (customerId) => onNavigateResource("customer", customerId, undefined)
                  : undefined
              }
            />
          </div>
        ) : null}
        {activeTab === "preferences" ? (
          <div className="mt-2">
            <CustomerPreferencePanel profileId={profile.id} />
          </div>
        ) : null}
        {activeTab === "name-aliases" ? (
          <div className="mt-2">
            <CustomerNameAliasPanel profileId={profile.id} />
          </div>
        ) : null}
      </Tabs>

      {quickDialog === "interaction" ? (
        <InteractionFormDialog profileId={profile.id} startOpen onClose={clearQuickDialog} />
      ) : null}
      {quickDialog === "checkin" ? (
        <CheckinFlow profileId={profile.id} autoStart onDone={clearQuickDialog} />
      ) : null}
      {quickDialog === "followup" ? (
        <FollowUpFormDialog profileId={profile.id} startOpen onClose={clearQuickDialog} />
      ) : null}
      {quickDialog === "complaint" ? (
        <ComplaintFormDialog profileId={profile.id} startOpen onClose={clearQuickDialog} />
      ) : null}

      {canEdit ? (
        <CustomerEditDialog
          profileId={profile.id}
          initialCustomer={{
            id: profile.id,
            name: cv?.name ?? null,
            customerCode: cv?.customerCode ?? null,
            principal: cv?.principal ?? null,
            email: cv?.email ?? null,
            wechat: cv?.wechat ?? null,
            organization: cv?.organization ?? null,
            organizationId: null,
            organizationSiteId: null,
            organizationRawInput: null,
            address: cv?.address ?? null,
            miniProgramId: null,
            labOrGroup: cv?.labOrGroup ?? null,
            phone: cv?.phone ?? null,
          }}
          open={editOpen}
          onOpenChange={setEditOpen}
          canEdit={canEdit}
        />
      ) : null}
    </div>
  );
}

/**
 * Public entry: wraps the inner view with the embedded resource navigation
 * provider so relation-customer links inside the View push onto the Agent
 * resource history.
 */
export function CustomerResourceView({
  location,
  mode,
  reloadToken,
  onOpenResource,
  initialTab,
}: {
  location: AgentResourceLocation;
  mode: ResourceViewMode;
  reloadToken: number;
  onOpenResource: (request: AgentResourceRequest) => void;
  initialTab?: string;
}) {
  // This View is always rendered inside a Panel or Sheet (embedded). The
  // provider lets nested relation-customer links push onto resource history
  // instead of leaving the workspace.
  const embeddedMode: "panel" | "sheet" = mode === "panel" ? "panel" : "sheet";
  return (
    <ResourceNavigationEmbeddedProvider mode={embeddedMode} onOpenResource={onOpenResource}>
      <CustomerResourceViewInner
        location={location}
        mode={mode}
        reloadToken={reloadToken}
        initialTab={initialTab ?? location.initialTab}
      />
    </ResourceNavigationEmbeddedProvider>
  );
}
