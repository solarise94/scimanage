"use client";

import { useSession } from "next-auth/react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AnimatedTabPanel } from "@/components/ui/animated-tab-panel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { StageBadge, ImportanceBadge, FollowUpStatusBadge } from "@/components/crm/badges";
import { InteractionFormDialog } from "@/components/crm/interaction-form-dialog";
import { FollowUpFormDialog } from "@/components/crm/follow-up-form-dialog";
import { CheckinFlow } from "@/components/crm/checkin-flow";
import { RelationsTab } from "@/components/crm/relations-tab";
import { CustomerPreferencePanel } from "@/components/crm/customer-preference-panel";
import { CustomerNameAliasPanel } from "@/components/crm/customer-name-alias-panel";
import { PreferenceFormDialog } from "@/components/crm/preference-form-dialog";
import { ComplaintFormDialog } from "@/components/crm/complaint-form-dialog";
import { INTERACTION_TYPE_LABELS, ADDRESS_SOURCE_LABELS, PREFERENCE_CATEGORY_LABELS } from "@/lib/crm/constants";
import { crmKeys } from "@/lib/crm/query-keys";
import type { CrmInteractionItem, CrmVisitCheckinItem, CrmCustomerAddressItem } from "@/lib/crm/types";
import { toast } from "sonner";
import { ArrowLeft, Phone, Mail, Building2, Pencil, Loader2, MessageSquare, MapPin, ClipboardCheck, Network, Navigation, ChevronDown, ChevronUp, Archive, ArchiveRestore, AlertCircle, ShieldAlert, Star, Sparkles, Pin } from "lucide-react";
import Link from "next/link";
import { Suspense, useState, useCallback, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CustomerEditDialog } from "@/components/crm/customer-edit-dialog";
import { CrmEmptyState } from "@/components/crm/empty-state";
import { useConfirm } from "@/components/ui/confirm-dialog";

type RepTagItem = {
  id: string;
  tagType: "MANAGING" | "FOLLOWED";
  isActive: boolean;
  isPrimary: boolean;
  startedAt: string;
  endedAt: string | null;
  representative: { id: string; name: string };
};

export default function CrmCustomerDetailPage() {
  const { status } = useSession();
  const router = useRouter();
  const { profileId } = useParams<{ profileId: string }>();

  if (status === "unauthenticated") { router.push("/login"); return null; }
  if (status === "loading") return <DetailSkeleton />;

  return (
    <Suspense fallback={<DetailSkeleton />}>
      <CustomerDetail profileId={profileId} />
    </Suspense>
  );
}

function DetailSkeleton() {
  return (
    <PageShell className="py-6">
      <div className="flex items-start gap-3">
        <Skeleton className="h-8 w-8 rounded-md" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-6 w-16 rounded-full" />
        <Skeleton className="h-6 w-16 rounded-full" />
      </div>
      <div className="grid md:grid-cols-3 gap-4">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
      <Skeleton className="h-10 w-full" />
      <div className="space-y-3">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    </PageShell>
  );
}

function CustomerDetail({ profileId }: { profileId: string }) {
  const { data: session } = useSession();
  const searchParams = useSearchParams();
  const requestedInteractionId = searchParams.get("interactionId");
  const [editOpen, setEditOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(searchParams.get("tab") === "interactions" ? "interactions" : "overview");
  const [quickDialog, setQuickDialog] = useState<"interaction" | "checkin" | "followup" | "preference" | "complaint" | null>(null);
  const clearQuickDialog = useCallback(() => setQuickDialog(null), []);
  const { data, isLoading, error } = useQuery({
    queryKey: crmKeys.profile(profileId),
    queryFn: async () => {
      const res = await fetch(`/api/crm/profiles/${profileId}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("加载 CRM 档案失败");
      return res.json();
    },
    refetchOnMount: "always",
  });

  useEffect(() => {
    if (activeTab !== "interactions" || !requestedInteractionId || !data?.profile) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`interaction-${requestedInteractionId}`)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, requestedInteractionId, data?.profile]);

  if (isLoading) return <DetailSkeleton />;
  if (error) {
    return (
      <PageShell className="py-6">
        <Link href="/crm/customers">
          <Button variant="ghost" size="sm" aria-label="返回客户档案库">
            <ArrowLeft className="h-4 w-4 mr-1" />返回
          </Button>
        </Link>
        <div className="mt-4 rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
          <div className="flex items-center gap-2 font-medium">
            <AlertCircle className="h-4 w-4" />
            加载失败
          </div>
          <p className="mt-1 text-destructive/80">{error instanceof Error ? error.message : "请稍后重试"}</p>
        </div>
      </PageShell>
    );
  }
  if (!data?.profile) {
    return (
      <PageShell className="py-6">
        <Link href="/crm/customers">
          <Button variant="ghost" size="sm" aria-label="返回客户档案库">
            <ArrowLeft className="h-4 w-4 mr-1" />返回
          </Button>
        </Link>
        <div className="mt-4 rounded-lg border p-6 text-center">
          <h2 className="text-base font-medium">未找到 CRM 档案</h2>
          <p className="mt-1 text-sm text-muted-foreground">该客户可能尚未纳入 CRM 或已被删除</p>
        </div>
      </PageShell>
    );
  }

  const profile = data.profile;
  const lifecycle = data.lifecycle;
  const repTags = (data.repTags ?? []) as RepTagItem[];
  const cv = profile.customerView;
  const profileName = cv?.name || "未命名客户";
  const isAdmin = session?.user?.role === "ADMIN";
  const canEditCustomer =
    session?.user?.role === "ADMIN" ||
    session?.user?.role === "USER" ||
    (session?.user?.role === "REPRESENTATIVE" && profile.ownerUser?.id === session.user.id);

  return (
    <PageShell className="py-6 pb-20 max-w-full overflow-x-hidden">
      <div className="flex items-start gap-3">
        <Link href="/crm/customers">
          <Button variant="ghost" size="sm" aria-label="返回客户档案库">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="min-w-0 flex-1">
          <h1
            title={profileName}
            className="max-w-full truncate font-bold leading-tight text-[clamp(1.125rem,5vw,1.5rem)] sm:text-2xl"
          >
            {profileName}
          </h1>
          <div className="mt-1 text-xs text-muted-foreground truncate">
            {cv?.customerCode || "未设置编号"}
            {cv?.organization ? ` · ${cv.organization}` : ""}
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 overflow-x-auto sm:mt-0 sm:overflow-visible">
        <StageBadge stage={profile.stage} />
        <ImportanceBadge importance={profile.importance} />
        {profile.archived && <Badge variant="secondary">已归档</Badge>}
        {canEditCustomer && (
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <Pencil className="h-4 w-4 mr-1" />编辑客户
          </Button>
        )}
        {isAdmin && (
          <div className="flex items-center gap-2 pl-2 border-l border-amber-200 dark:border-amber-900/50" title="管理员操作">
            <ShieldAlert className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <ArchiveButton
              profileId={profile.id}
              name={profileName}
              archived={profile.archived}
            />
          </div>
        )}
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <InfoItem icon={<Building2 className="h-4 w-4" />} label="单位" value={cv?.organization} />
        <InfoItem icon={<Phone className="h-4 w-4" />} label="负责人" value={cv?.principal} />
        <InfoItem icon={<Mail className="h-4 w-4" />} label="邮箱" value={cv?.email} />
      </div>

      <div className="sticky top-0 z-20 backdrop-blur-md bg-background/90 shadow-sm border-b py-2 mb-2 md:hidden">
        <div className="flex gap-2 overflow-x-auto no-scrollbar">
          <Button size="sm" variant="outline" className="shrink-0 h-8 px-2.5 py-1.5 text-xs" onClick={() => setQuickDialog("interaction")}>
            <MessageSquare className="h-3.5 w-3.5 mr-1" />沟通
          </Button>
          <Button size="sm" variant="outline" className="shrink-0 h-8 px-2.5 py-1.5 text-xs" onClick={() => setQuickDialog("checkin")}>
            <MapPin className="h-3.5 w-3.5 mr-1" />签到
          </Button>
          <Button size="sm" variant="outline" className="shrink-0 h-8 px-2.5 py-1.5 text-xs" onClick={() => setQuickDialog("followup")}>
            <ClipboardCheck className="h-3.5 w-3.5 mr-1" />跟进
          </Button>
          <Button size="sm" variant="outline" className="shrink-0 h-8 px-2.5 py-1.5 text-xs" onClick={() => setActiveTab("relations")}>
            <Network className="h-3.5 w-3.5 mr-1" />关系
          </Button>
          <Button size="sm" variant="outline" className="shrink-0 h-8 px-2.5 py-1.5 text-xs" onClick={() => setQuickDialog("preference")}>
            <Star className="h-3.5 w-3.5 mr-1" />偏好
          </Button>
          <Button size="sm" variant="outline" className="shrink-0 h-8 px-2.5 py-1.5 text-xs" onClick={() => setQuickDialog("complaint")}>
            <AlertCircle className="h-3.5 w-3.5 mr-1" />客诉
          </Button>
        </div>
      </div>

      {quickDialog === "interaction" && (
        <InteractionFormDialog
          profileId={profile.id}
          startOpen
          onClose={clearQuickDialog}
        />
      )}
      {quickDialog === "checkin" && (
        <CheckinFlow
          profileId={profile.id}
          autoStart
          onDone={clearQuickDialog}
        />
      )}
      {quickDialog === "followup" && (
        <FollowUpFormDialog
          profileId={profile.id}
          startOpen
          onClose={clearQuickDialog}
        />
      )}
      {quickDialog === "preference" && (
        <PreferenceFormDialog
          profileId={profile.id}
          startOpen
          onClose={clearQuickDialog}
        />
      )}
      {quickDialog === "complaint" && (
        <ComplaintFormDialog
          profileId={profile.id}
          startOpen
          onClose={clearQuickDialog}
        />
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        {(() => {
          const crmDetailTabs = [
            { value: "overview", label: "概览" },
            { value: "interactions", label: `沟通记录 (${profile._count?.interactions || 0})` },
            { value: "checkins", label: `拜访签到 (${profile._count?.visitCheckins || 0})` },
            { value: "follow-ups", label: `跟进任务 (${profile._count?.followUpTasks || 0})` },
            { value: "addresses", label: `地址 (${profile._count?.addresses || 0})` },
            { value: "relations", label: "关系网络" },
            { value: "preferences", label: "客户偏好" },
            { value: "name-aliases", label: "常用称呼" },
          ];
          return (
            <>
              <div className="md:hidden overflow-x-auto no-scrollbar -mx-6 px-6">
                <TabsList className="inline-flex h-10 w-auto">
                  {crmDetailTabs.map((t) => (
                    <TabsTrigger key={t.value} value={t.value} className="text-xs px-3 whitespace-nowrap">
                      {t.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              <div className="hidden md:block">
                <TabsList className="grid w-full grid-cols-8">
                  <TabsTrigger value="overview">概览</TabsTrigger>
                  <TabsTrigger value="interactions">沟通记录 ({profile._count?.interactions || 0})</TabsTrigger>
                  <TabsTrigger value="checkins">拜访签到 ({profile._count?.visitCheckins || 0})</TabsTrigger>
                  <TabsTrigger value="follow-ups">跟进任务 ({profile._count?.followUpTasks || 0})</TabsTrigger>
                  <TabsTrigger value="addresses">地址 ({profile._count?.addresses || 0})</TabsTrigger>
                  <TabsTrigger value="relations">关系网络</TabsTrigger>
                  <TabsTrigger value="preferences">客户偏好</TabsTrigger>
                  <TabsTrigger value="name-aliases">常用称呼</TabsTrigger>
                </TabsList>
              </div>
            </>
          );
        })()}

        <AnimatedTabPanel activeValue={activeTab} value="overview" className="space-y-4 mt-4">
          <OverviewTab profile={profile} lifecycle={lifecycle} repTags={repTags} preferenceSummary={data.preferenceSummary} openComplaint={data.openComplaint} />
        </AnimatedTabPanel>

        <AnimatedTabPanel activeValue={activeTab} value="interactions" className="space-y-4 mt-4">
          <InteractionsTab
            profileId={profile.id}
            interactions={profile.interactions}
            highlightInteractionId={requestedInteractionId}
          />
        </AnimatedTabPanel>

        <AnimatedTabPanel activeValue={activeTab} value="checkins" className="space-y-4 mt-4">
          <CheckinsTab profileId={profile.id} checkins={profile.visitCheckins} />
        </AnimatedTabPanel>

        <AnimatedTabPanel activeValue={activeTab} value="follow-ups" className="space-y-4 mt-4">
          <FollowUpsTab profileId={profile.id} tasks={profile.followUpTasks} profileName={profileName} />
        </AnimatedTabPanel>

        <AnimatedTabPanel activeValue={activeTab} value="addresses" className="space-y-4 mt-4">
          <AddressesTab addresses={profile.addresses} />
        </AnimatedTabPanel>

        <AnimatedTabPanel activeValue={activeTab} value="relations" className="space-y-4 mt-4">
          <RelationsTab profileId={profile.id} customerName={profileName} />
        </AnimatedTabPanel>

        <AnimatedTabPanel activeValue={activeTab} value="preferences" className="space-y-4 mt-4">
          <CustomerPreferencePanel profileId={profile.id} />
        </AnimatedTabPanel>

        <AnimatedTabPanel activeValue={activeTab} value="name-aliases" className="space-y-4 mt-4">
          <CustomerNameAliasPanel profileId={profile.id} />
        </AnimatedTabPanel>
      </Tabs>

      {canEditCustomer && (
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
            organizationId: cv?.organizationId ?? null,
            organizationSiteId: cv?.organizationSiteId ?? null,
            organizationRawInput: cv?.organizationRawInput ?? null,
            address: cv?.address ?? null,
            miniProgramId: cv?.miniProgramId ?? null,
            labOrGroup: cv?.labOrGroup ?? null,
            phone: cv?.phone ?? null,
          }}
          open={editOpen}
          onOpenChange={setEditOpen}
          canEdit={canEditCustomer}
        />
      )}
    </PageShell>
  );
}

function InfoItem({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | null }) {
  return (
    <div className="flex items-center gap-2 text-sm min-w-0">
      {icon}
      <span className="text-muted-foreground shrink-0">{label}:</span>
      <span className="truncate">{value || "-"}</span>
    </div>
  );
}

function OverviewTab({
  profile,
  lifecycle,
  repTags,
  preferenceSummary,
  openComplaint,
}: {
  profile: { id: string; ownerUser: { name: string }; lastFollowUpAt: string | null; nextFollowUpAt: string | null; summary: string | null };
  lifecycle?: {
    historicalOrderCount?: number;
    validOrderAmount?: number;
    lastHistoricalOrderAt?: string | null;
    isRepeatCustomer?: boolean;
    lastEffectiveInteractionAt?: string | null;
    nextCommunicationTaskAt?: string | null;
    dormantRisk?: boolean;
  } | null;
  repTags?: RepTagItem[];
  preferenceSummary?: { pinned: Array<{ id: string; category: string; label: string; valueText: string | null }>; recent: Array<{ id: string; category: string; label: string; valueText: string | null }>; topInsights: Array<{ id: string; category: string; label: string; valueText: string | null; confidence: number | null }> } | null;
  openComplaint?: { id: string; title: string; category: string; severity: string; status: string; updatedAt: string } | null;
}) {
  const managing = (repTags ?? []).filter((t) => t.tagType === "MANAGING" && t.isActive);
  const followed = (repTags ?? []).filter((t) => t.tagType === "FOLLOWED");
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Card>
        <CardHeader><CardTitle className="text-base">基本信息</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">负责人</span><span>{profile.ownerUser.name}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">最近跟进</span><span>{profile.lastFollowUpAt ? new Date(profile.lastFollowUpAt).toLocaleDateString("zh-CN") : "-"}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">下次跟进</span><span>{profile.nextFollowUpAt ? new Date(profile.nextFollowUpAt).toLocaleDateString("zh-CN") : "-"}</span></div>
          {profile.summary && (
            <div className="pt-2 border-t prose prose-sm dark:prose-invert max-w-none text-muted-foreground break-words">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{profile.summary}</ReactMarkdown>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">运营摘要</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">有效订单数</span><span>{lifecycle?.historicalOrderCount || 0}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">最近下单</span><span>{lifecycle?.lastHistoricalOrderAt ? new Date(lifecycle.lastHistoricalOrderAt).toLocaleDateString("zh-CN") : "-"}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">复购状态</span><span>{lifecycle?.isRepeatCustomer ? "复购客户" : "未复购"}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">最近有效沟通</span><span>{lifecycle?.lastEffectiveInteractionAt ? new Date(lifecycle.lastEffectiveInteractionAt).toLocaleDateString("zh-CN") : "-"}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">下次沟通任务</span><span>{lifecycle?.nextCommunicationTaskAt ? new Date(lifecycle.nextCommunicationTaskAt).toLocaleDateString("zh-CN") : "-"}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">休眠风险</span><span className={lifecycle?.dormantRisk ? "text-warning" : ""}>{lifecycle?.dormantRisk ? "需尽快联系" : "正常"}</span></div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">快捷操作</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <CheckinFlow profileId={profile.id} />
          <InteractionFormDialog profileId={profile.id} />
          <FollowUpFormDialog profileId={profile.id} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-1.5">
            <Star className="h-4 w-4 text-primary" />
            关键偏好
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {preferenceSummary && (preferenceSummary.pinned.length > 0 || preferenceSummary.recent.length > 0) ? (
            <>
              {preferenceSummary.pinned.map((p) => (
                <div key={p.id} className="flex items-start gap-1.5">
                  <Pin className="h-3 w-3 text-primary mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-medium truncate">{p.label}</p>
                    {p.valueText && <p className="text-xs text-muted-foreground truncate">{p.valueText}</p>}
                  </div>
                </div>
              ))}
              {preferenceSummary.recent.map((p) => (
                <div key={p.id} className="flex items-start gap-1.5">
                  <span className="text-xs bg-muted px-1.5 py-0.5 rounded shrink-0">{PREFERENCE_CATEGORY_LABELS[p.category] || p.category}</span>
                  <div className="min-w-0">
                    <p className="font-medium truncate">{p.label}</p>
                    {p.valueText && <p className="text-xs text-muted-foreground truncate">{p.valueText}</p>}
                  </div>
                </div>
              ))}
              {preferenceSummary.topInsights.length > 0 && (
                <div className="pt-2 border-t">
                  <p className="text-xs font-medium text-muted-foreground mb-1">自动洞察</p>
                  {preferenceSummary.topInsights.slice(0, 2).map((p) => (
                    <div key={p.id} className="flex items-start gap-1.5">
                      <Sparkles className="h-3 w-3 text-info mt-0.5 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm truncate">{p.label}</p>
                        {p.confidence != null && <span className="text-xs text-muted-foreground">{Math.round(p.confidence * 100)}%</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="text-muted-foreground text-xs">暂无关键偏好</p>
          )}
          <div className="pt-1 flex gap-2">
            <PreferenceFormDialog profileId={profile.id} />
          </div>
          {openComplaint && (
            <div className="pt-2 border-t">
              <div className="flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5 text-warning" />
                <span className="text-xs font-medium text-warning">有未关闭客诉</span>
              </div>
              <p className="text-sm mt-0.5 truncate">{openComplaint.title}</p>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">代表关系</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-1.5">正在管理</div>
            {managing.length === 0 ? (
              <div className="text-muted-foreground">暂无管理代表</div>
            ) : (
              <div className="space-y-1.5">
                {managing.map((t) => (
                  <div key={t.id} className="flex items-center gap-2">
                    <span className="font-medium">{t.representative.name}</span>
                    {t.isPrimary && (
                      <span className="text-[10px] leading-none px-1.5 py-0.5 rounded bg-primary/10 text-primary">主代表</span>
                    )}
                    <span className="text-xs text-muted-foreground ml-auto">
                      {new Date(t.startedAt).toLocaleDateString("zh-CN")} 起
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {followed.length > 0 && (
            <div className="pt-2 border-t">
              <div className="text-xs font-medium text-muted-foreground mb-1.5">曾经跟进</div>
              <div className="space-y-1.5">
                {followed.map((t) => (
                  <div key={t.id} className="flex items-center gap-2">
                    <span>{t.representative.name}</span>
                    <span className="text-xs text-muted-foreground ml-auto">
                      {new Date(t.startedAt).toLocaleDateString("zh-CN")}
                      {" ~ "}
                      {t.endedAt ? new Date(t.endedAt).toLocaleDateString("zh-CN") : "至今"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function InteractionsTab({
  profileId,
  interactions,
  highlightInteractionId,
}: {
  profileId: string;
  interactions: CrmInteractionItem[];
  highlightInteractionId?: string | null;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleTranscript = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-3">
        <h3 className="font-medium">沟通记录</h3>
        <InteractionFormDialog profileId={profileId} />
      </div>
      {interactions.length === 0 ? (
        <CrmEmptyState icon={MessageSquare} title="暂无沟通记录" description="点击上方按钮添加第一条沟通记录" />
      ) : (
        <div className="space-y-3">
          {interactions.map((i) => {
            const isExpanded = expandedIds.has(i.id);
            return (
              <Card
                key={i.id}
                id={`interaction-${i.id}`}
                className={highlightInteractionId === i.id ? "ring-2 ring-primary/60" : undefined}
              >
                <CardContent className="pt-4">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs bg-muted px-2 py-0.5 rounded">{INTERACTION_TYPE_LABELS[i.type] || i.type}</span>
                    <span className="text-xs text-muted-foreground ml-auto">{i.createdByUser.name}</span>
                  </div>
                  <div className="mb-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    <span>发生于 {new Date(i.happenedAt).toLocaleString("zh-CN")}</span>
                    <span>录入于 {new Date(i.createdAt).toLocaleString("zh-CN")}</span>
                  </div>
                  <p className="text-sm font-medium">{i.summary}</p>
                  {i.detail && <p className="text-sm text-muted-foreground mt-1 break-words">{i.detail}</p>}
                  {i.summaryTitle && <p className="text-sm font-medium mt-1">AI: {i.summaryTitle}</p>}
                  {i.summaryNote && <p className="text-xs text-muted-foreground mt-0.5">{i.summaryNote}</p>}
                  {i.transcript && (
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={() => toggleTranscript(i.id)}
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {isExpanded ? (
                          <>
                            <ChevronUp className="h-3 w-3" /> 收起转写文本
                          </>
                        ) : (
                          <>
                            <ChevronDown className="h-3 w-3" /> 查看转写文本
                          </>
                        )}
                      </button>
                      <div
                        className={`text-xs text-muted-foreground bg-muted/30 rounded-lg p-3 mt-2 overflow-y-auto transition-all duration-200 ${
                          isExpanded ? "max-h-48 opacity-100" : "max-h-0 opacity-0 p-0"
                        }`}
                      >
                        {i.transcript}
                      </div>
                    </div>
                  )}
                  {i.asrStatus === "TRANSCRIBING" && <p className="text-xs text-muted-foreground mt-1"><Loader2 className="h-3 w-3 inline animate-spin mr-1" />识别中...</p>}
                  {i.asrStatus === "FAILED" && <p className="text-xs text-danger mt-1">语音识别失败</p>}
                  {i.voiceUrl && <span className="text-xs text-muted-foreground mt-1">· 有录音</span>}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NearbyPois({ lat, lng }: { lat: number; lng: number }) {
  const [enabled, setEnabled] = useState(false);
  const { data, isFetching, error } = useQuery({
    queryKey: ["reverse-geocode", lat, lng],
    queryFn: async () => {
      const res = await fetch("/api/crm/maps/reverse-geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lng }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "请求失败");
      return json;
    },
    enabled,
    staleTime: Infinity,
    retry: false,
  });

  if (!enabled) {
    return (
      <button className="text-xs text-muted-foreground hover:text-foreground mt-1" onClick={() => setEnabled(true)}>
        查看附近地点
      </button>
    );
  }

  if (isFetching) {
    return <p className="text-xs text-muted-foreground mt-1">加载中...</p>;
  }

  if (error) {
    return <p className="text-xs text-danger mt-1">{error instanceof Error ? error.message : "请求失败"}</p>;
  }

  const result = data?.result;
  const pois = (result?.pois ?? []) as Array<{ name: string; distance: number }>;
  if (!result || (!result.formattedAddress && pois.length === 0)) {
    return <p className="text-xs text-muted-foreground mt-1">未找到附近地点</p>;
  }

  return (
    <div className="mt-1.5 space-y-1">
      {result.formattedAddress && (
        <p className="text-xs text-muted-foreground">推荐地址：{result.formattedAddress}</p>
      )}
      {pois.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <span>附近地点：</span>
          {pois.slice(0, 5).map((p, i) => (
            <span key={i}>
              {i > 0 && "、"}
              {p.name}
              {p.distance > 0 && <span className="text-muted-foreground/60">{Math.round(p.distance)}m</span>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CheckinsTab({ profileId, checkins }: { profileId: string; checkins: CrmVisitCheckinItem[] }) {
  return (
    <div>
      <div className="flex justify-between items-center mb-3">
        <h3 className="font-medium">拜访签到</h3>
        <CheckinFlow profileId={profileId} />
      </div>
      {checkins.length === 0 ? (
        <CrmEmptyState icon={MapPin} title="暂无签到记录" description="点击上方按钮添加第一条签到记录" />
      ) : (
        <div className="space-y-3">
          {checkins.map((c) => (
            <Card key={c.id}>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-xs px-2 py-0.5 rounded ${c.status === "COMPLETED" ? "bg-success-bg text-success" : "bg-warning-bg text-warning"}`}>
                    {c.status === "COMPLETED" ? "已完成" : "草稿"}
                  </span>
                  <span className="text-xs text-muted-foreground">{new Date(c.createdAt).toLocaleString("zh-CN")}</span>
                  <span className="text-xs text-muted-foreground ml-auto">{c.user.name}</span>
                </div>
                {c.addressSnapshot && <p className="text-sm">{c.addressSnapshot}</p>}
                {c.lat != null && c.lng != null && <NearbyPois lat={c.lat} lng={c.lng} />}
                {c.voiceUrl && <p className="text-xs text-muted-foreground mt-1">历史录音（已迁移至沟通记录）</p>}
                <div className="text-xs text-muted-foreground mt-1">
                  {c.lat != null ? `${c.lat.toFixed(6)}, ${c.lng!.toFixed(6)}` : "无定位"}
                  {` · ${c.photoCount || 0} 张照片`}
                </div>
                {c.media?.length > 0 && (
                  <div className="flex gap-2 mt-2 flex-wrap">
                    {c.media.map((m) => (
                      <img key={m.id} src={m.url} alt="" className="h-16 w-16 object-cover rounded" />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function FollowUpsTab({ profileId, tasks, profileName }: { profileId: string; tasks: Array<{ id: string; title: string; dueAt: string; status: string; ownerUser: { name: string } }>; profileName: string }) {
  const queryClient = useQueryClient();

  const completeMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const res = await fetch(`/api/crm/follow-ups/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "DONE" }),
      });
      if (!res.ok) throw new Error("操作失败");
      return res.json();
    },
    onSuccess: async () => {
      toast.success("任务已完成");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: crmKeys.profile(profileId) }),
        queryClient.invalidateQueries({ queryKey: crmKeys.followUps() }),
        queryClient.invalidateQueries({ queryKey: crmKeys.profiles() }),
        queryClient.invalidateQueries({ queryKey: crmKeys.myToday() }),
        queryClient.invalidateQueries({ queryKey: crmKeys.adminOverview() }),
      ]);
    },
  });

  return (
    <div>
      <div className="flex justify-between items-center mb-3">
        <h3 className="font-medium">跟进任务</h3>
        <FollowUpFormDialog profileId={profileId} profileName={profileName} />
      </div>
      {tasks.length === 0 ? (
        <CrmEmptyState icon={ClipboardCheck} title="暂无待处理跟进任务" description="点击上方按钮添加第一个跟进任务" />
      ) : (
        <div className="space-y-3">
          {tasks.map((t) => (
            <Card key={t.id}>
              <CardContent className="p-3 sm:pt-4 sm:flex sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <p className="truncate text-sm font-medium">{t.title}</p>
                  <p className="text-xs text-muted-foreground break-words sm:truncate">
                    截止: {new Date(t.dueAt).toLocaleString("zh-CN")}
                    {" · "}负责人: {t.ownerUser.name}
                  </p>
                </div>
                <div className="mt-3 flex items-center justify-between gap-2 sm:mt-0 sm:justify-end">
                  <FollowUpStatusBadge status={t.status} />
                  {t.status === "OPEN" && (
                    <Button size="sm" variant="outline" onClick={() => completeMutation.mutate(t.id)} disabled={completeMutation.isPending}>
                      完成
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function AddressesTab({ addresses }: { addresses: CrmCustomerAddressItem[] }) {
  return (
    <div>
      <h3 className="font-medium mb-3">地址列表</h3>
      {addresses.length === 0 ? (
        <CrmEmptyState icon={Navigation} title="暂无地址记录" />
      ) : (
        <div className="space-y-3">
          {addresses.map((a) => (
            <Card key={a.id}>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 mb-1">
                  {a.isPrimary && <span className="text-xs bg-info-bg text-info px-2 py-0.5 rounded">主要</span>}
                  <span className="text-xs bg-muted px-2 py-0.5 rounded">{ADDRESS_SOURCE_LABELS[a.sourceType] || a.sourceType}</span>
                  <span className="text-sm font-medium">{a.label}</span>
                </div>
                {a.addressText ? (
                  <div className="text-sm break-words prose prose-sm dark:prose-invert max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{a.addressText}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-sm break-words">-</p>
                )}
                {a.province && (
                  <p className="text-xs text-muted-foreground">{[a.province, a.city, a.district].filter(Boolean).join(" ")}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ArchiveButton({
  profileId,
  name,
  archived,
}: {
  profileId: string;
  name: string;
  archived: boolean;
}) {
  const { confirm } = useConfirm();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/crm/profiles/${profileId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: !archived }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "操作失败");
      }
      return res.json();
    },
    onSuccess: async () => {
      toast.success(archived ? "客户已恢复" : "客户已归档");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: crmKeys.profiles() }),
        queryClient.invalidateQueries({ queryKey: crmKeys.profile(profileId) }),
        queryClient.invalidateQueries({ queryKey: crmKeys.myToday() }),
        queryClient.invalidateQueries({ queryKey: crmKeys.adminOverview() }),
        queryClient.invalidateQueries({ queryKey: ["crm-customer-pool"] }),
      ]);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={archived ? `恢复客户 ${name}` : `归档客户 ${name}`}
      className={archived
        ? "text-green-600 hover:text-green-700 hover:bg-green-50"
        : "text-amber-600 hover:text-amber-700 hover:bg-amber-50"}
      onClick={async () => {
        const action = archived ? "恢复" : "归档";
        const ok = await confirm({
          title: `${action}客户`,
          description: `确定要${action}客户 "${name}" 吗？`,
        });
        if (ok) mutation.mutate();
      }}
      disabled={mutation.isPending}
    >
      {archived ? <><ArchiveRestore className="h-4 w-4 mr-1" />恢复</> : <><Archive className="h-4 w-4 mr-1" />归档</>}
    </Button>
  );
}
