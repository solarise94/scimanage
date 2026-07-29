"use client";

import { useSession } from "next-auth/react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, Suspense } from "react";
import Link from "next/link";
import { crmKeys } from "@/lib/crm/query-keys";
import type { CrmRepresentativeDetail } from "@/lib/crm/types";
import { RepresentativeReportPanel } from "@/components/crm/representative-report-panel";
import { CollectionMetricsPanel } from "@/components/finance/collection-metrics-panel";
import { RepresentativeOrganizationsTab } from "@/components/crm/representative-organizations-tab";
import { RepresentativeRegionEditor } from "@/components/crm/representative-region-editor";
import { StageBadge, ImportanceBadge, FollowUpStatusBadge } from "@/components/crm/badges";
import { KpiCard } from "@/components/ui/kpi-card";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { INTERACTION_TYPE_LABELS } from "@/lib/crm/constants";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AnimatedTabPanel } from "@/components/ui/animated-tab-panel";
import { Users, MapPin, AlertTriangle, Clock, Network, MessageSquare, TrendingUp, RefreshCw } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { CustomerGrowthChart, AverageOrderValueChart, CategoryConversionChart } from "@/components/crm/rep-trends-charts";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";

export default function RepDetailPage() {
  const { status } = useSession();
  const router = useRouter();

  if (status === "unauthenticated") { router.push("/login"); return null; }
  if (status === "loading") return <PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>;

  return (
    <Suspense fallback={<PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>}>
      <RepDetail />
    </Suspense>
  );
}

function RepDetail() {
  const params = useParams<{ representativeId: string }>();
  const repId = params.representativeId;
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const [regionEditorOpen, setRegionEditorOpen] = useState(false);
  const canManageBindings = session?.user?.role === "ADMIN" || session?.user?.role === "REGIONAL_MANAGER";

  const [customersPage, setCustomersPage] = useState(1);
  const [followUpsPage, setFollowUpsPage] = useState(1);
  const customersPageSize = 50;
  const followUpsPageSize = 20;
  const tabFromUrlEarly = searchParams.get("tab") || "overview";

  const { data, isLoading, error: detailError } = useQuery<CrmRepresentativeDetail>({
    queryKey: crmKeys.representativeOpsDetail(repId),
    queryFn: async () => {
      const res = await fetch(`/api/crm/representatives/${repId}`);
      const json = await res.json().catch(() => ({}));
      if (res.status === 403) throw new Error("无权限查看该代表");
      if (res.status === 404) throw new Error(typeof json?.error === "string" ? json.error : "未找到代表");
      if (!res.ok) throw new Error(typeof json?.error === "string" ? json.error : `加载失败 (${res.status})`);
      return json as CrmRepresentativeDetail;
    },
  });

  const { data: customersPageData, isFetching: customersLoading } = useQuery<{
    customers: CrmRepresentativeDetail["customers"];
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    truncated: boolean;
  }>({
    queryKey: [...crmKeys.representativeOpsDetail(repId), "customers", customersPage, customersPageSize],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: String(customersPage),
        pageSize: String(customersPageSize),
      });
      const res = await fetch(`/api/crm/representatives/${repId}/customers?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof json?.error === "string" ? json.error : "加载客户失败");
      return json;
    },
    enabled: !!data && tabFromUrlEarly === "customers",
  });

  const { data: followUpsPageData, isFetching: followUpsLoading } = useQuery<{
    openFollowUps: CrmRepresentativeDetail["openFollowUps"];
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    truncated: boolean;
  }>({
    queryKey: [...crmKeys.representativeOpsDetail(repId), "follow-ups", followUpsPage, followUpsPageSize],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: String(followUpsPage),
        pageSize: String(followUpsPageSize),
      });
      const res = await fetch(`/api/crm/representatives/${repId}/follow-ups?${params}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof json?.error === "string" ? json.error : "加载跟进失败");
      return json;
    },
    enabled: !!data && tabFromUrlEarly === "followUps",
  });

  const tabFromUrl = searchParams.get("tab") || "overview";
  const validTabs = ["overview", "customers", "checkins", "followUps", "communication", "organizations", "trends", "report"];
  const tab = validTabs.includes(tabFromUrl) && (tabFromUrl !== "organizations" || canManageBindings) ? tabFromUrl : "overview";

  const handleTabChange = (newTab: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (newTab === "overview") {
      params.delete("tab");
    } else {
      params.set("tab", newTab);
    }
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  if (isLoading) return <PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>;
  if (detailError) {
    return (
      <PageShell>
        <div className="p-6 text-sm text-danger">
          {detailError instanceof Error ? detailError.message : "加载代表详情失败"}
        </div>
      </PageShell>
    );
  }
  if (!data) return <div className="p-6">未找到代表</div>;

  const {
    representative,
    linkedUser,
    customerCount,
    openFollowUpCount,
    activeCustomerCount,
    visitCheckinCount,
    lastCheckinAt,
    overdueFollowUps,
    longUnvisitedCount,
    dueCommunicationTaskCount,
    doneCommunicationTaskCount,
    communicatedCustomerCount30d,
    communicationCoverageRate30d,
    conversionRate30d,
    conversionRate90d,
    orderedCustomerCount30d,
    repeatCustomerCount30d,
    repeatCustomerRate30d,
    orderedCustomerCount90d,
    repeatCustomerCount90d,
    repeatCustomerRate90d,
    dormantCustomerCount,
    dormantWarningCustomerCount,
    recentCheckins,
    relationCount,
    recentCommunicationEvents,
    regions,
    trends,
    collectionSummary,
  } = data;

  const customers = customersPageData?.customers ?? [];
  const openFollowUps = followUpsPageData?.openFollowUps ?? [];
  const customersTotal = customersPageData?.total ?? customerCount;
  const followUpsTotal = followUpsPageData?.total ?? openFollowUpCount ?? 0;
  const customersTotalPages = customersPageData?.totalPages ?? Math.max(1, Math.ceil(customersTotal / customersPageSize));
  const followUpsTotalPages = followUpsPageData?.totalPages ?? Math.max(1, Math.ceil(followUpsTotal / followUpsPageSize));
  const customersTruncated = customersPageData?.truncated ?? customersTotal > customers.length;
  const openFollowUpsTruncated = followUpsPageData?.truncated ?? followUpsTotal > openFollowUps.length;

  return (
    <PageShell>
      <PageHeader
        title={representative.name}
        description={representative.email}
        backHref="/crm/representatives"
        backLabel="返回代表运营"
      />
      {linkedUser && <p className="text-xs text-muted-foreground">系统用户: {linkedUser.name}</p>}
      {representative.archived && <span className="text-xs bg-gray-100 text-gray-600 rounded px-2 py-0.5 mt-1 inline-block">已归档</span>}
      {data.accountUnlinked && (
        <p className="text-xs text-warning">代表未绑定系统账号：签到/沟通/跟进行为指标为 0，客户归属指标仍可展示。</p>
      )}

      <div className="grid gap-4 grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <KpiCard icon={Users} title="客户数" value={customerCount} />
        <KpiCard icon={Users} title="活跃客户" value={activeCustomerCount || 0} />
        <KpiCard icon={MapPin} title="30天拜访" value={visitCheckinCount} />
        <KpiCard icon={MessageSquare} title="30天沟通客户" value={communicatedCustomerCount30d || 0} />
        <KpiCard icon={AlertTriangle} title="逾期跟进" value={overdueFollowUps} variant="danger" />
        <KpiCard icon={Clock} title="长期未拜访" value={longUnvisitedCount} />
        <KpiCard icon={TrendingUp} title="30天转化率" value={`${Math.round((conversionRate30d || 0) * 100)}%`} />
        <KpiCard icon={TrendingUp} title="90天转化率" value={`${Math.round((conversionRate90d || 0) * 100)}%`} />
        <KpiCard icon={RefreshCw} title="30天复购率" value={`${Math.round((repeatCustomerRate30d || 0) * 100)}%`} />
        <KpiCard icon={RefreshCw} title="90天复购率" value={`${Math.round((repeatCustomerRate90d || 0) * 100)}%`} />
        <KpiCard icon={AlertTriangle} title="休眠客户" value={dormantCustomerCount || 0} />
        <KpiCard icon={AlertTriangle} title="休眠预警" value={dormantWarningCustomerCount || 0} />
        <KpiCard icon={Network} title="关系网络" value={relationCount} />
      </div>

      {lastCheckinAt && (
        <p className="text-xs text-muted-foreground">最近签到: {new Date(lastCheckinAt).toLocaleString("zh-CN")}</p>
      )}

      <Tabs value={tab} onValueChange={handleTabChange} className="w-full">
        <TabsList variant="line" className="w-full justify-start">
          <TabsTrigger value="overview">概览</TabsTrigger>
          <TabsTrigger value="customers">名下客户</TabsTrigger>
          <TabsTrigger value="checkins">拜访记录</TabsTrigger>
          <TabsTrigger value="followUps">跟进任务</TabsTrigger>
          <TabsTrigger value="communication">沟通检查</TabsTrigger>
          <TabsTrigger value="trends">运营趋势</TabsTrigger>
          {canManageBindings && <TabsTrigger value="organizations">绑定单位</TabsTrigger>}
          <TabsTrigger value="report">周报</TabsTrigger>
        </TabsList>

        <AnimatedTabPanel activeValue={tab} value="overview" className="mt-4 space-y-4">
          {collectionSummary && (
            <CollectionMetricsPanel summary={collectionSummary} />
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <Card>
              <CardContent className="p-4">
                <h3 className="font-medium mb-2">代表信息</h3>
                <dl className="text-sm space-y-1">
                  <div className="flex gap-2"><dt className="text-muted-foreground">姓名:</dt><dd>{representative.name}</dd></div>
                  <div className="flex gap-2"><dt className="text-muted-foreground">邮箱:</dt><dd>{representative.email}</dd></div>
                  <div className="flex gap-2"><dt className="text-muted-foreground">系统用户:</dt><dd>{linkedUser?.name || "未关联"}</dd></div>
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-medium">所属地区</h3>
                  {session?.user?.role === "ADMIN" && (
                    <Button variant="outline" size="sm" onClick={() => setRegionEditorOpen(true)}>
                      编辑地区
                    </Button>
                  )}
                </div>
                {regions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">未设置地区</p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {regions.map((r) => (
                      <Badge key={r.id} variant="secondary" className="text-xs">
                        {r.name}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4">
                <h3 className="font-medium mb-2">近期动态</h3>
                {recentCheckins.length === 0 ? (
                  <p className="text-sm text-muted-foreground">暂无签到记录</p>
                ) : (
                  <ul className="text-sm space-y-1">
                    {recentCheckins.slice(0, 5).map((c) => (
                      <li key={c.id} className="text-muted-foreground">
                        {new Date(c.happenedAt || c.createdAt).toLocaleString("zh-CN")}
                        {c.profileName ? ` — ${c.profileName}` : ""}
                        {c.addressSnapshot ? ` · ${c.addressSnapshot}` : ""}
                        {c.photoCount > 0 && <span className="ml-1">({c.photoCount}张照片)</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 space-y-3">
                <div>
                  <h3 className="font-medium mb-2">当前状态</h3>
                  <dl className="text-sm space-y-1">
                    <div className="flex gap-2"><dt className="text-muted-foreground">活跃客户:</dt><dd>{activeCustomerCount || 0}</dd></div>
                    <div className="flex gap-2"><dt className="text-muted-foreground">休眠客户:</dt><dd>{dormantCustomerCount || 0}</dd></div>
                    <div className="flex gap-2"><dt className="text-muted-foreground">休眠预警:</dt><dd>{dormantWarningCustomerCount || 0}</dd></div>
                  </dl>
                </div>
                <div className="border-t pt-2">
                  <h3 className="font-medium mb-2">运营效率</h3>
                  <dl className="text-sm space-y-1">
                    <div className="flex gap-2"><dt className="text-muted-foreground">30天转化率:</dt><dd>{Math.round((conversionRate30d || 0) * 100)}%</dd></div>
                    <div className="flex gap-2"><dt className="text-muted-foreground">90天转化率:</dt><dd>{Math.round((conversionRate90d || 0) * 100)}%</dd></div>
                    <div className="flex gap-2"><dt className="text-muted-foreground">30天复购率:</dt><dd>{Math.round((repeatCustomerRate30d || 0) * 100)}%</dd></div>
                    <div className="flex gap-2"><dt className="text-muted-foreground">90天复购率:</dt><dd>{Math.round((repeatCustomerRate90d || 0) * 100)}%</dd></div>
                  </dl>
                </div>
              </CardContent>
            </Card>
          </div>

          {session?.user?.role === "ADMIN" && (
            <RepresentativeRegionEditor
              open={regionEditorOpen}
              onOpenChange={setRegionEditorOpen}
              representativeId={repId}
              onSaved={() => {
                queryClient.invalidateQueries({ queryKey: crmKeys.representativeOpsDetail(repId) });
                queryClient.invalidateQueries({ queryKey: crmKeys.representativeOps() });
              }}
            />
          )}
        </AnimatedTabPanel>

        <AnimatedTabPanel activeValue={tab} value="customers" className="mt-4 space-y-3">
          {(customersTruncated || customerCount > customers.length) && (
            <p className="text-xs text-muted-foreground">
              共 {customersTotal} 位客户，当前第 {customersPage}/{customersTotalPages} 页
              （每页 {customersPageSize} 条）{customersLoading ? " · 加载中" : ""}
            </p>
          )}
          {customers.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">暂无客户</p>
          ) : (
            <DataTable
              columns={customerColumns}
              data={customers}
              keyExtractor={(p) => p.id}
              renderMobileCard={(p) => (
                <Card>
                  <CardContent className="p-4 space-y-2">
                    <div>
                      <Link href={`/crm/customers/${p.id}`} className="text-primary hover:underline font-medium">
                        {p.customerView?.name || "未命名客户"}
                      </Link>
                    </div>
                    <div className="text-xs text-muted-foreground">{p.customerView?.organization || "-"}</div>
                    <div className="flex items-center gap-2"><StageBadge stage={p.stage} /></div>
                    <div className="flex items-center gap-2"><ImportanceBadge importance={p.importance} /></div>
                  </CardContent>
                </Card>
              )}
              emptyTitle="暂无客户"
            />
          )}
          {customersTotalPages > 1 && (
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={customersPage <= 1}
                onClick={() => setCustomersPage((p) => Math.max(1, p - 1))}
              >
                上一页
              </Button>
              <span className="text-xs text-muted-foreground">{customersPage}/{customersTotalPages}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={customersPage >= customersTotalPages}
                onClick={() => setCustomersPage((p) => Math.min(customersTotalPages, p + 1))}
              >
                下一页
              </Button>
            </div>
          )}
        </AnimatedTabPanel>

        <AnimatedTabPanel activeValue={tab} value="checkins" className="mt-4">
          {recentCheckins.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">暂无签到记录</p>
          ) : (
            <DataTable
              columns={checkinColumns}
              data={recentCheckins}
              keyExtractor={(c) => c.id}
              renderMobileCard={(c) => (
                <Card>
                  <CardContent className="p-4 space-y-1">
                    <div className="text-sm">{new Date(c.happenedAt || c.createdAt).toLocaleString("zh-CN")}</div>
                    <div className="text-xs text-muted-foreground">{c.profileName || "未知客户"}</div>
                    <div className="text-xs text-muted-foreground">{c.addressSnapshot || "-"}</div>
                    <div className="text-sm">照片 {c.photoCount}</div>
                  </CardContent>
                </Card>
              )}
              emptyTitle="暂无签到记录"
            />
          )}
        </AnimatedTabPanel>

        <AnimatedTabPanel activeValue={tab} value="followUps" className="mt-4 space-y-3">
          {(openFollowUpsTruncated || followUpsTotal > openFollowUps.length) && (
            <p className="text-xs text-muted-foreground">
              共 {followUpsTotal} 条开放跟进，当前第 {followUpsPage}/{followUpsTotalPages} 页
              （每页 {followUpsPageSize} 条）{followUpsLoading ? " · 加载中" : ""}
            </p>
          )}
          {openFollowUps.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">暂无待处理跟进</p>
          ) : (
            <DataTable
              columns={followUpColumns}
              data={openFollowUps}
              keyExtractor={(f) => f.id}
              renderMobileCard={(f) => (
                <Card>
                  <CardContent className="p-4 space-y-2">
                    <div className="font-medium">{f.title}</div>
                    <div className="text-xs text-muted-foreground">{f.profile?.name || "未命名客户"}</div>
                    <div className="text-sm">{new Date(f.dueAt).toLocaleDateString("zh-CN")}</div>
                    <div><FollowUpStatusBadge status={f.status} /></div>
                  </CardContent>
                </Card>
              )}
              emptyTitle="暂无待处理跟进"
            />
          )}
          {followUpsTotalPages > 1 && (
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={followUpsPage <= 1}
                onClick={() => setFollowUpsPage((p) => Math.max(1, p - 1))}
              >
                上一页
              </Button>
              <span className="text-xs text-muted-foreground">{followUpsPage}/{followUpsTotalPages}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={followUpsPage >= followUpsTotalPages}
                onClick={() => setFollowUpsPage((p) => Math.min(followUpsTotalPages, p + 1))}
              >
                下一页
              </Button>
            </div>
          )}
        </AnimatedTabPanel>

        <AnimatedTabPanel activeValue={tab} value="communication" className="mt-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardContent className="p-4 space-y-2 text-sm">
                <h3 className="font-medium">沟通任务检查</h3>
                <div className="flex justify-between"><span className="text-muted-foreground">应沟通任务</span><span>{dueCommunicationTaskCount || 0}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">已完成沟通任务</span><span>{doneCommunicationTaskCount || 0}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">30天有效沟通客户</span><span>{communicatedCustomerCount30d || 0}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">30天沟通覆盖率</span><span>{Math.round((communicationCoverageRate30d || 0) * 100)}%</span></div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 space-y-2 text-sm">
                <h3 className="font-medium">客户运营检查</h3>
                <div className="flex justify-between"><span className="text-muted-foreground">30天下单客户</span><span>{orderedCustomerCount30d || 0}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">30天复购客户</span><span>{repeatCustomerCount30d || 0}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">30天复购率</span><span>{Math.round((repeatCustomerRate30d || 0) * 100)}%</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">90天下单客户</span><span>{orderedCustomerCount90d || 0}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">90天复购客户</span><span>{repeatCustomerCount90d || 0}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">90天复购率</span><span>{Math.round((repeatCustomerRate90d || 0) * 100)}%</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">休眠客户</span><span>{dormantCustomerCount || 0}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">休眠预警</span><span>{dormantWarningCustomerCount || 0}</span></div>
              </CardContent>
            </Card>
          </div>

          {/* C4: Communication event timeline */}
          {recentCommunicationEvents && recentCommunicationEvents.length > 0 && (
            <Card className="mt-4">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">近期沟通事件</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y">
                  {recentCommunicationEvents.slice(0, 20).map((e) => {
                    const customerName =
                      e.profileName
                      || customers.find((c) => c.id === e.profileId)?.customerView?.name
                      || "未知客户";
                    return (
                    <Link
                      key={e.eventKey}
                      href={`/crm/customers/${e.profileId}`}
                      className="flex items-center justify-between gap-2 px-4 py-2.5 hover:bg-muted/60 transition-colors"
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <span className="font-medium text-sm truncate">{customerName}</span>
                        <Badge variant="outline" className="text-[10px] shrink-0">
                          {e.sourceType === "CHECKIN" ? "签到" : (INTERACTION_TYPE_LABELS[e.interactionType || ""] || e.interactionType || "沟通")}
                        </Badge>
                        {e.originType === "CUSTOMER_APPLICATION" && (
                          <Badge variant="secondary" className="text-[10px] shrink-0">客户申请</Badge>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {new Date(e.happenedAt).toLocaleString("zh-CN")}
                      </span>
                    </Link>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </AnimatedTabPanel>

        {canManageBindings && (
          <AnimatedTabPanel activeValue={tab} value="organizations" className="mt-4">
            <RepresentativeOrganizationsTab representativeId={representative.id} />
          </AnimatedTabPanel>
        )}

        <AnimatedTabPanel activeValue={tab} value="trends" className="mt-4 space-y-4">
          <CustomerGrowthChart data={trends.customerGrowth} />
          <AverageOrderValueChart data={trends.averageOrderValue} />
          <CategoryConversionChart
            points={trends.categoryConversion.points}
            details={trends.categoryConversion.details}
          />
        </AnimatedTabPanel>

        <AnimatedTabPanel activeValue={tab} value="report" className="mt-4">
          <RepresentativeReportPanel representativeId={representative.id} readOnly />
        </AnimatedTabPanel>
      </Tabs>
    </PageShell>
  );
}

const customerColumns = [
  {
    key: "customerView.name",
    header: "客户",
    render: (p: CrmRepresentativeDetail["customers"][number]) => (
      <Link href={`/crm/customers/${p.id}`} className="text-primary hover:underline font-medium">
        {p.customerView?.name || "未命名客户"}
      </Link>
    ),
  },
  { key: "customerView.organization", header: "单位", render: (p: CrmRepresentativeDetail["customers"][number]) => p.customerView?.organization || "-" },
  { key: "stage", header: "阶段", render: (p: CrmRepresentativeDetail["customers"][number]) => <StageBadge stage={p.stage} /> },
  { key: "importance", header: "重要度", render: (p: CrmRepresentativeDetail["customers"][number]) => <ImportanceBadge importance={p.importance} /> },
];

const checkinColumns = [
  {
    key: "happenedAt",
    header: "时间",
    render: (c: CrmRepresentativeDetail["recentCheckins"][number]) =>
      new Date(c.happenedAt || c.createdAt).toLocaleString("zh-CN"),
  },
  {
    key: "profileName",
    header: "客户",
    render: (c: CrmRepresentativeDetail["recentCheckins"][number]) => c.profileName || "未知客户",
  },
  {
    key: "addressSnapshot",
    header: "地址",
    render: (c: CrmRepresentativeDetail["recentCheckins"][number]) => c.addressSnapshot || "-",
  },
  { key: "photoCount", header: "照片", align: "right" as const },
];

const followUpColumns = [
  { key: "title", header: "任务" },
  { key: "profile.name", header: "客户", render: (f: CrmRepresentativeDetail["openFollowUps"][number]) => f.profile?.name || "未命名客户" },
  { key: "dueAt", header: "截止", render: (f: CrmRepresentativeDetail["openFollowUps"][number]) => new Date(f.dueAt).toLocaleDateString("zh-CN") },
  { key: "status", header: "状态", render: (f: CrmRepresentativeDetail["openFollowUps"][number]) => <FollowUpStatusBadge status={f.status} /> },
];
