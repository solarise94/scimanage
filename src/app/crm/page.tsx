"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ActionCard, type ActionCardItem } from "@/components/ui/action-card";
import { KpiCard } from "@/components/ui/kpi-card";
import { FOLLOW_UP_TASK_TYPE_LABELS } from "@/lib/crm/constants";
import { CustomerProfilePicker } from "@/components/crm/customer-profile-picker";
import { InteractionFormDialog } from "@/components/crm/interaction-form-dialog";
import { CheckinFlow } from "@/components/crm/checkin-flow";
import { CustomerApplicationFormDialog } from "@/components/crm/customer-application-form-dialog";
import type { CrmDashboardCustomerRow } from "@/lib/crm/types";
import { crmKeys } from "@/lib/crm/query-keys";
import { isSalesRole } from "@/lib/role-guards";
import {
  StatBoardCard,
  SwitchableTrendCard,
  StageDistributionCard,
  RepAlertBarCard,
} from "@/components/crm/dashboard/admin-trend-cards";
import {
  CustomerMiniListCard,
  MiniInteractionsCard,
} from "@/components/crm/dashboard/customer-mini-list-cards";
import type { AdminTrendsResult } from "@/lib/crm/admin-trends";
import {
  Users, ClipboardList, AlertTriangle, MapPin,
  CalendarClock, Network, BarChart3, UserCog,
  MessageSquare, ClipboardCheck, Building2,
  Inbox, UserPlus, Building,
  ListTodo, Phone,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { CrmEmptyState } from "@/components/crm/empty-state";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useMediaQuery } from "@/hooks/use-media-query";
import { Badge } from "@/components/ui/badge";

// ── Types for new API responses ──────────────────────────────

interface MyTodayItem {
  id: string;
  profileId: string;
  customerName: string;
  organization: string | null;
  sourceLabel: "逾期跟进" | "今日跟进" | "沟通计划到期" | "需要拜访" | "近期下单" | "风险提醒";
  reason: string;
  dueAt: string | null;
  taskType: string | null;
  nextAction: "add_interaction" | "checkin" | "view_customer";
}

interface MyTodayResponse {
  overdueTaskCount: number;
  dueTodayTaskCount: number;
  suggestedContactCount: number;
  suggestedVisitCount: number;
  items: MyTodayItem[];
  recentOrderedCustomers: CrmDashboardCustomerRow[];
}

interface AdminOverviewResponse {
  totalProfiles: number;
  pendingFollowUps: number;
  overdueFollowUps: number;
  communicationCoverageRate30d: number;
  dormantWarningCustomerCount: number;
  openComplaintCount: number;
  highSeverityComplaintCount: number;
  pendingApplications: number;
  pendingOrgBindingTasks: number;
  pendingMergeTasks: number;
  pendingOrgReviewTasks: number;
  representativeAlerts: Array<{
    representativeId: string;
    name: string;
    overdueFollowUps: number;
    longUnvisitedCount: number;
  }>;
  recentOrderedCustomers: CrmDashboardCustomerRow[];
  repeatCustomers: CrmDashboardCustomerRow[];
  warningCustomers: CrmDashboardCustomerRow[];
  recentInteractions: Array<{
    id: string;
    profileId: string;
    type: string;
    summary: string;
    happenedAt: string;
    createdAt: string;
    createdByUser: { id: string; name: string };
    profile?: {
      id?: string;
      name?: string | null;
    } | null;
  }>;
}

// ── Page entry ───────────────────────────────────────────────

export default function CrmDashboardPage() {
  const { status } = useSession();
  const router = useRouter();

  if (status === "unauthenticated") {
    router.push("/login");
    return null;
  }
  if (status === "loading") return <PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>;

  return <CrmDashboard />;
}

function CrmDashboard() {
  const { data: session } = useSession();
  const role = session?.user?.role;
  const isSales = isSalesRole(role);
  const isAdmin = role === "ADMIN";

  if (isSales) return <MyTodayDashboard />;
  if (isAdmin) return <AdminDashboard />;
  // USER role: not a sales role, but also not ADMIN.
  // admin-overview API returns 403 for non-ADMIN, so show a permission notice
  // instead of rendering an empty shell that would silently fail to load data.
  return <CrmNoAccessNotice />;
}

function CrmNoAccessNotice() {
  return (
    <PageShell className="space-y-5">
      <PageHeader title="CRM 工作台" />
      <Card>
        <CardContent className="p-8 text-center space-y-3">
          <p className="text-muted-foreground">
            CRM 工作台面向销售代表和管理员。当前账号角色无访问权限。
          </p>
          <div className="flex justify-center gap-2">
            <Link href="/dashboard">
              <Button variant="outline" size="sm">返回首页</Button>
            </Link>
            <Link href="/crm/customers">
              <Button variant="outline" size="sm">浏览客户档案</Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </PageShell>
  );
}

// ── Quick action state (shared) ──────────────────────────────

function useQuickActions() {
  const [quickAction, setQuickAction] = useState<"interaction" | "checkin" | null>(null);
  const [quickProfileId, setQuickProfileId] = useState("");

  function clearQuickAction() {
    setQuickAction(null);
    setQuickProfileId("");
  }

  return { quickAction, setQuickAction, quickProfileId, setQuickProfileId, clearQuickAction };
}

function QuickActionDialogs({ quickAction, quickProfileId, clearQuickAction }: {
  quickAction: "interaction" | "checkin" | null;
  quickProfileId: string;
  clearQuickAction: () => void;
}) {
  return (
    <>
      {quickAction === "interaction" && quickProfileId && (
        <InteractionFormDialog
          profileId={quickProfileId}
          startOpen
          onClose={clearQuickAction}
        />
      )}
      {quickAction === "checkin" && quickProfileId && (
        <CheckinFlow
          profileId={quickProfileId}
          autoStart
          onDone={clearQuickAction}
        />
      )}
    </>
  );
}

// ── Shared today-item content (used by Link and button variants) ──

const TODAY_LABEL_COLORS: Record<MyTodayItem["sourceLabel"], string> = {
  "逾期跟进": "text-destructive",
  "今日跟进": "text-primary",
  "需要拜访": "text-blue-600",
  "沟通计划到期": "text-muted-foreground",
  "近期下单": "text-green-600",
  "风险提醒": "text-warning",
};

function TodayItemContent({ item }: { item: MyTodayItem }) {
  return (
    <>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm truncate">{item.customerName}</span>
          <span className={cn("text-xs font-medium", TODAY_LABEL_COLORS[item.sourceLabel])}>
            {item.sourceLabel}
          </span>
          {item.taskType && item.taskType !== "CONTACT" && (
            <Badge variant="outline" className="text-[10px]">
              {FOLLOW_UP_TASK_TYPE_LABELS[item.taskType] || item.taskType}
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5 truncate">
          {item.reason}
        </div>
        {item.dueAt && (
          <div className="text-xs text-muted-foreground mt-0.5">
            截止 {new Date(item.dueAt).toLocaleString("zh-CN")}
          </div>
        )}
      </div>
      {item.organization && (
        <div className="text-xs text-muted-foreground hidden sm:block shrink-0">
          {item.organization}
        </div>
      )}
    </>
  );
}

// ── Representative "Today Workbench" ─────────────────────────

function MyTodayDashboard() {
  const { data: session } = useSession();
  const role = session?.user?.role;
  const isRep = role === "REPRESENTATIVE";
  const isRegionalManager = role === "REGIONAL_MANAGER";
  const isMobile = useMediaQuery("(max-width: 767px)");
  const qa = useQuickActions();

  const { data, isLoading } = useQuery<MyTodayResponse>({
    queryKey: crmKeys.myToday(),
    queryFn: () => fetch("/api/crm/dashboard/my-today").then((r) => r.json()),
  });

  if (isLoading) return <PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>;
  if (!data) return <CrmEmptyState icon={Inbox} title="暂无数据" className="py-20" />;

  return (
    <PageShell className="space-y-5">
      <PageHeader
        title="今日工作台"
        actions={
          <div className={cn("gap-2", isMobile ? "grid grid-cols-3" : "flex items-center flex-wrap gap-1.5")}>
            <CustomerProfilePicker
              title="现场签到"
              actionLabel="开始签到"
              trigger={
                <Button variant="outline" size="sm" className={cn(isMobile && "h-11 w-full")}>
                  <MapPin className={cn("h-3.5 w-3.5", isMobile ? "mr-0 mb-0.5" : "mr-1")} />签到
                </Button>
              }
              onPick={(profileId) => {
                qa.setQuickProfileId(profileId);
                qa.setQuickAction("checkin");
              }}
            />
            <CustomerProfilePicker
              title="添加沟通"
              actionLabel="开始记录沟通"
              trigger={
                <Button variant="outline" size="sm" className={cn(isMobile && "h-11 w-full")}>
                  <MessageSquare className={cn("h-3.5 w-3.5", isMobile ? "mr-0 mb-0.5" : "mr-1")} />沟通
                </Button>
              }
              onPick={(profileId) => {
                qa.setQuickProfileId(profileId);
                qa.setQuickAction("interaction");
              }}
            />
            {(isRep || isRegionalManager) && (
              <CustomerApplicationFormDialog
                trigger={
                  <Button variant="outline" size="sm" className={cn(isMobile && "h-11 w-full")}>
                    <UserPlus className={cn("h-3.5 w-3.5", isMobile ? "mr-0 mb-0.5" : "mr-1")} />新增客户
                  </Button>
                }
              />
            )}
          </div>
        }
      />

      {/* Today summary */}
      <div className={cn("grid gap-3", isMobile ? "grid-cols-2" : "grid-cols-4")}>
        <KpiCard icon={AlertTriangle} title="逾期任务" value={data.overdueTaskCount} variant="danger" />
        <KpiCard icon={CalendarClock} title="今日到期" value={data.dueTodayTaskCount} />
        <KpiCard icon={Phone} title="建议联系" value={data.suggestedContactCount} />
        <KpiCard icon={MapPin} title="建议拜访" value={data.suggestedVisitCount} />
      </div>

      {/* "Today to-do" task flow */}
      {data.items.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <ListTodo className="h-4 w-4" />今天要做
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y">
              {data.items.map((item) => {
                const handleItemClick = () => {
                  if (item.nextAction === "checkin") {
                    qa.setQuickProfileId(item.profileId);
                    qa.setQuickAction("checkin");
                  } else if (item.nextAction === "add_interaction") {
                    qa.setQuickProfileId(item.profileId);
                    qa.setQuickAction("interaction");
                  }
                  // view_customer falls through to the Link
                };
                const isViewOnly = item.nextAction === "view_customer";

                return isViewOnly ? (
                  <Link
                    key={item.id}
                    href={`/crm/customers/${item.profileId}`}
                    className="flex items-start gap-3 px-4 py-3 hover:bg-muted/60 transition-colors"
                  >
                    <TodayItemContent item={item} />
                  </Link>
                ) : (
                  <button
                    key={item.id}
                    type="button"
                    onClick={handleItemClick}
                    className="flex w-full items-start gap-3 px-4 py-3 hover:bg-muted/60 transition-colors text-left"
                  >
                    <TodayItemContent item={item} />
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent ordered customers */}
      {data.recentOrderedCustomers.length > 0 && (
        <CustomerListCard
          title="近期下单客户"
          emptyTitle="暂无近期下单客户"
          rows={data.recentOrderedCustomers}
          extraColumn={{ key: "order", header: "最近下单", render: (r) => r.lastHistoricalOrderAt ? new Date(r.lastHistoricalOrderAt).toLocaleDateString("zh-CN") : "-" }}
        />
      )}

      {/* Secondary navigation */}
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">快捷入口</h2>
        <nav className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(
            [
              { href: "/crm/customers", icon: Users, label: "我的客户", description: "浏览与管理客户档案" },
              { href: "/crm/follow-ups", icon: CalendarClock, label: "全部待办", description: "所有跟进任务" },
              { href: "/crm/customer-applications", icon: ClipboardCheck, label: "客户申请", description: "提交新客户申请" },
              isRep && { href: "/crm/my-organizations", icon: Building2, label: "我的单位", description: "查看和申请绑定单位" },
              (isRep || isRegionalManager) && { href: "/crm/my-report", icon: ClipboardList, label: "我的汇报", description: "填写本周工作汇报" },
              { href: "/crm/relations", icon: Network, label: "关系管理", description: "客户关系边与类型管理" },
            ].filter(Boolean) as ActionCardItem[]
          ).map((action) => (
            <ActionCard key={action.href} action={action} />
          ))}
        </nav>
      </div>

      <QuickActionDialogs {...qa} />
    </PageShell>
  );
}

// ── Admin operations dashboard ───────────────────────────────

/**
 * trends 加载中时传给 SwitchableTrendCard 的空 totals 占位，
 * 保证大数字/环比徽标渲染 0 而不报错。
 */
const emptyTotals: AdminTrendsResult["totals"] = {
  newCustomers: 0,
  interactions: 0,
  prevNewCustomers: 0,
  prevInteractions: 0,
  openFollowUpTasksInWindow: 0,
};

function AdminDashboard() {
  const isMobile = useMediaQuery("(max-width: 767px)");
  const qa = useQuickActions();
  const { data: session } = useSession();
  const role = session?.user?.role;
  const isAdmin = role === "ADMIN";

  const { data, isLoading } = useQuery<AdminOverviewResponse>({
    queryKey: crmKeys.adminOverview(),
    queryFn: () => fetch("/api/crm/dashboard/admin-overview").then((r) => r.json()),
  });

  const [days, setDays] = useState<7 | 30 | 90>(30);
  const { data: trends, isLoading: trendsLoading } = useQuery<AdminTrendsResult>({
    queryKey: crmKeys.adminTrends(days),
    queryFn: () => fetch(`/api/crm/dashboard/admin-trends?days=${days}`).then((r) => r.json()),
  });

  if (isLoading) return <PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>;
  if (!data) return <CrmEmptyState icon={Inbox} title="暂无数据" className="py-20" />;

  return (
    <PageShell className="space-y-6">
      <PageHeader
        title="CRM 运营管理台"
        actions={
          <div className={cn("gap-2", isMobile ? "grid grid-cols-3" : "flex items-center flex-wrap gap-1.5")}>
            <CustomerProfilePicker
              title="添加沟通"
              actionLabel="开始记录沟通"
              trigger={
                <Button variant="outline" size="sm" className={cn(isMobile && "h-11 w-full")}>
                  <MessageSquare className={cn("h-3.5 w-3.5", isMobile ? "mr-0 mb-0.5" : "mr-1")} />沟通
                </Button>
              }
              onPick={(profileId) => {
                qa.setQuickProfileId(profileId);
                qa.setQuickAction("interaction");
              }}
            />
            <CustomerProfilePicker
              title="现场签到"
              actionLabel="开始签到"
              trigger={
                <Button variant="outline" size="sm" className={cn(isMobile && "h-11 w-full")}>
                  <MapPin className={cn("h-3.5 w-3.5", isMobile ? "mr-0 mb-0.5" : "mr-1")} />签到
                </Button>
              }
              onPick={(profileId) => {
                qa.setQuickProfileId(profileId);
                qa.setQuickAction("checkin");
              }}
            />
            <CustomerApplicationFormDialog
              trigger={
                <Button variant="outline" size="sm" className={cn(isMobile && "h-11 w-full")}>
                  <UserPlus className={cn("h-3.5 w-3.5", isMobile ? "mr-0 mb-0.5" : "mr-1")} />新增客户
                </Button>
              }
            />
          </div>
        }
      />

      {/* Row1：飞书式大数字看板卡 */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
        {/* 客户总数：delta = 窗口新增 vs 前窗新增（环比） */}
        <StatBoardCard
          title="客户总数"
          value={data.totalProfiles}
          href="/crm/customers"
          delta={{
            current: trends?.totals.newCustomers ?? 0,
            previous: trends?.totals.prevNewCustomers ?? 0,
          }}
          spark={trends?.customerGrowth}
          sparkColor="var(--chart-1)"
        />
        <StatBoardCard
          title="待跟进"
          value={data.pendingFollowUps}
          href="/crm/follow-ups"
          description="未完成的跟进任务"
        />
        <StatBoardCard
          title="逾期跟进"
          value={data.overdueFollowUps}
          href="/crm/follow-ups"
          description="已超过下次跟进时间"
        />
        <StatBoardCard
          title="30天沟通覆盖"
          value={`${Math.round(data.communicationCoverageRate30d * 100)}%`}
          delta={{
            current: trends?.totals.interactions ?? 0,
            previous: trends?.totals.prevInteractions ?? 0,
          }}
          spark={trends?.interactionTrend}
          sparkColor="var(--chart-2)"
        />
        <StatBoardCard
          title="未关闭客诉"
          value={data.openComplaintCount}
          description={
            data.highSeverityComplaintCount > 0
              ? `高严重 ${data.highSeverityComplaintCount}`
              : "暂无高严重"
          }
        />
        <StatBoardCard
          title="休眠预警"
          value={data.dormantWarningCustomerCount}
          description="需唤醒的客户"
        />
      </div>

      {/* Row2：可切换视图图表卡 + 客户阶段分布环形图 */}
      <div className="grid lg:grid-cols-5 gap-4">
        <div className="lg:col-span-3 min-w-0">
          <SwitchableTrendCard
            customerGrowth={trends?.customerGrowth ?? []}
            interactionTrend={trends?.interactionTrend ?? []}
            followUpTaskLoad={trends?.followUpTaskLoad ?? []}
            totals={trends?.totals ?? emptyTotals}
            days={days}
            onDaysChange={setDays}
            isLoading={trendsLoading}
          />
        </div>
        <div className="lg:col-span-2 min-w-0">
          <StageDistributionCard
            data={trends?.stageDistribution ?? []}
            isLoading={trendsLoading}
          />
        </div>
      </div>

      {/* Row3：代表运营异常条形图 + 待处理治理 */}
      <div className="grid lg:grid-cols-5 gap-4">
        <div className="lg:col-span-3 min-w-0">
          <RepAlertBarCard alerts={data.representativeAlerts} />
        </div>
        <div className="lg:col-span-2 min-w-0">
          <Card className="min-w-0 h-full">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">待处理治理</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                <GovernanceLink href="/crm/customer-applications" icon={ClipboardCheck} label="客户申请" count={data.pendingApplications} />
                <GovernanceLink href="/admin/organizations" icon={Network} label="去重审核" count={data.pendingMergeTasks} />
                <GovernanceLink href="/admin/organizations" icon={Building2} label="机构审核" count={data.pendingOrgReviewTasks} />
                <GovernanceLink href="/admin/organizations" icon={Network} label="绑定任务" count={data.pendingOrgBindingTasks} />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* 客户情况：一行 4 列迷你卡 */}
      <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
        <CustomerMiniListCard
          title="近期下单客户"
          viewAllHref="/crm/customers"
          rows={data.recentOrderedCustomers}
          emptyTitle="暂无近期下单客户"
          renderRight={(r) => (r.lastHistoricalOrderAt ? new Date(r.lastHistoricalOrderAt).toLocaleDateString("zh-CN") : "-")}
        />
        <CustomerMiniListCard
          title="复购客户"
          rows={data.repeatCustomers}
          emptyTitle="暂无复购客户"
          renderRight={(r) => `${r.historicalOrderCount} 单`}
          renderBadge={(r) => (r.isRepeatCustomer ? <Badge variant="secondary" className="text-[10px]">复购</Badge> : null)}
        />
        <CustomerMiniListCard
          title="即将告警客户"
          rows={data.warningCustomers}
          emptyTitle="暂无告警客户"
          renderBadge={(r) => (
            <div className="flex flex-wrap gap-1">
              {r.warningReasons.slice(0, 2).map((reason) => (
                <Badge key={reason} variant="outline" className="text-[10px] text-warning border-warning/30">{reason}</Badge>
              ))}
            </div>
          )}
        />
        <MiniInteractionsCard interactions={data.recentInteractions} />
      </div>

      {/* 功能入口 */}
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">功能入口</h2>
        <nav className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(
            [
              { href: "/crm/customers", icon: Users, label: "客户档案库", description: "浏览与管理全部客户档案" },
              { href: "/crm/organization-flow", icon: Building, label: "机构流转", description: "机构代表绑定与流转治理" },
              { href: "/crm/follow-ups", icon: CalendarClock, label: "跟进任务", description: "待处理、已逾期、已完成的跟进任务" },
              { href: "/crm/customer-applications", icon: ClipboardCheck, label: "客户申请", description: "客户申请与主管复核" },
              { href: "/crm/relations", icon: Network, label: "关系管理", description: "客户关系边与类型管理" },
              { href: "/crm/graph", icon: Network, label: "关系图谱", description: "力导向图可视化" },
              { href: "/crm/representatives", icon: BarChart3, label: "代表运营", description: "代表客户、沟通、订单与复购表现" },
              isAdmin && { href: "/admin/organizations", icon: Building2, label: "机构管理", description: "机构主数据管理与去重审核" },
              isAdmin && { href: "/admin/representative-organizations", icon: Inbox, label: "绑定审核", description: "审核代表的单位绑定申请" },
              isAdmin && { href: "/crm/region-managers", icon: UserCog, label: "地区经理", description: "区域经理与代表绑定" },
            ].filter(Boolean) as ActionCardItem[]
          ).map((action) => (
            <ActionCard key={action.href} action={action} />
          ))}
        </nav>
      </div>

      <QuickActionDialogs {...qa} />
    </PageShell>
  );
}

// ── Shared sub-components ────────────────────────────────────

function GovernanceLink({ href, label, count, icon: Icon }: {
  href: string;
  label: string;
  count: number;
  icon?: LucideIcon;
}) {
  return (
    <Link href={href} className="flex items-center justify-between rounded-md px-2 py-2 hover:bg-muted/60 transition-colors">
      <span className="flex items-center gap-2 text-sm">
        {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
        <span className={count === 0 ? "text-muted-foreground" : ""}>{label}</span>
      </span>
      {count > 0 ? (
        <Badge variant="destructive" className="text-[10px]">{count}</Badge>
      ) : (
        <span className="text-xs text-muted-foreground">0</span>
      )}
    </Link>
  );
}

function CustomerListCard({
  title,
  emptyTitle,
  rows,
  extraColumn,
  badge,
}: {
  title: string;
  emptyTitle: string;
  rows: CrmDashboardCustomerRow[];
  extraColumn: { key: string; header: string; render: (r: CrmDashboardCustomerRow) => React.ReactNode };
  badge?: (r: CrmDashboardCustomerRow) => React.ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm">{title}</CardTitle>
        <Link href="/crm/customers" className="text-xs text-primary hover:underline">查看全部</Link>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <CrmEmptyState icon={Users} title={emptyTitle} className="py-8" />
        ) : (
          <div className="divide-y">
            {rows.map((r) => (
              <Link
                key={r.profileId}
                href={`/crm/customers/${r.profileId}`}
                className="flex items-center justify-between px-4 py-2.5 hover:bg-muted/60 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-sm truncate block">{r.customerName}</span>
                  <div className="text-[11px] text-muted-foreground truncate">{r.organization || "-"}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {extraColumn.render(r)}
                  {badge?.(r)}
                </div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
