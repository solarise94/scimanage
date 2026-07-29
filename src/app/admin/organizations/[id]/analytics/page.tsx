"use client";

import { Suspense, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useRouter, useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/ui/kpi-card";
import { DataTable, DataTableColumn } from "@/components/ui/data-table";
import { StageBadge, ImportanceBadge, PersonCategoryBadge } from "@/components/crm/badges";
import { INTERACTION_TYPE_LABELS, SITE_TYPE_LABELS } from "@/lib/crm/constants";
import {
  Users,
  Building2,
  MapPin,
  Tag,
  Handshake,
  MessageSquare,
  CalendarDays,
  UserCheck,
} from "lucide-react";
import Link from "next/link";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";

interface OrgDetail {
  organization: {
    id: string;
    orgCode: string;
    canonicalName: string;
    address: string | null;
    taxId: string | null;
    aliases: Array<{ id: string; alias: string; aliasType: string }>;
    sites: Array<{ id: string; siteName: string; siteType: string; address: string | null }>;
    customerCount: number;
    crmProfileCount: number;
  };
  customerSummary: Array<{
    profileId: string;
    customerName: string;
    customerCode: string;
    principal: string | null;
    labOrGroup: string | null;
    stage: string;
    importance: string;
    personCategory: string | null;
    ownerName: string;
    siteName: string | null;
    siteType: string | null;
  }>;
  representativeBreakdown: Array<{
    representativeId: string;
    name: string;
    email: string;
    profileCount: number;
    interactionCount: number;
    checkinCount: number;
    lastCheckinAt: string | null;
  }>;
  recentInteractions: Array<{
    id: string;
    type: string;
    summary: string;
    happenedAt: string;
    profile: { id: string; name: string | null };
    createdByUser: { name: string };
  }>;
  recentCheckins: Array<{
    id: string;
    summaryTitle: string | null;
    addressSnapshot: string | null;
    createdAt: string;
    user: { name: string };
  }>;
  distributions: {
    stage: Record<string, number>;
    importance: Record<string, number>;
    personCategory: Record<string, number>;
  };
}

export default function OrgAnalyticsDetailPage() {
  return (
    <Suspense fallback={<PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>}>
      <OrgAnalyticsDetail />
    </Suspense>
  );
}

function OrgAnalyticsDetail() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const params = useParams();
  const orgId = params.id as string;

  useEffect(() => {
    if (status === "authenticated" && session?.user?.role !== "ADMIN") {
      router.push("/dashboard");
    }
  }, [status, session, router]);

  const { data, isLoading } = useQuery<OrgDetail>({
    queryKey: ["org-analytics-detail", orgId],
    queryFn: () => fetch(`/api/crm/organization-analytics/${orgId}`).then((r) => r.json()),
    enabled: status === "authenticated" && session?.user?.role === "ADMIN",
  });

  if (status === "loading") return null;
  if (!session || session.user.role !== "ADMIN") return null;

  if (isLoading) return <PageShell className="space-y-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</PageShell>;

  const d = data;

  const repColumns: DataTableColumn<OrgDetail["representativeBreakdown"][0]>[] = [
    {
      key: "name",
      header: "代表",
      render: (r) => (
        <Link href={`/crm/representatives/${r.representativeId}`} className="text-primary hover:underline">
          {r.name}
        </Link>
      ),
    },
    { key: "profileCount", header: "客户数", align: "right", sortable: true },
    { key: "interactionCount", header: "30天沟通", align: "right", sortable: true },
    { key: "checkinCount", header: "30天签到", align: "right", sortable: true },
    {
      key: "lastCheckinAt",
      header: "最近签到",
      render: (r) => (r.lastCheckinAt ? new Date(r.lastCheckinAt).toLocaleDateString("zh-CN") : "—"),
      sortValue: (r) => r.lastCheckinAt,
    },
  ];

  const customerColumns: DataTableColumn<OrgDetail["customerSummary"][0]>[] = [
    {
      key: "customerName",
      header: "客户",
      render: (c) => (
        <div>
          <Link href={`/crm/customers/${c.profileId}`} className="text-primary hover:underline font-medium">
            {c.customerName}
          </Link>
          <div className="text-xs text-muted-foreground">{c.customerCode}</div>
        </div>
      ),
    },
    { key: "labOrGroup", header: "课题组", render: (c) => c.labOrGroup || "—" },
    { key: "stage", header: "阶段", render: (c) => <StageBadge stage={c.stage} /> },
    { key: "importance", header: "重要度", render: (c) => <ImportanceBadge importance={c.importance} /> },
    {
      key: "personCategory",
      header: "分类",
      render: (c) => <PersonCategoryBadge category={c.personCategory === "未设置" ? null : c.personCategory} />,
    },
    { key: "ownerName", header: "负责人" },
  ];

  const renderRepMobileCard = (r: OrgDetail["representativeBreakdown"][0]) => (
    <div className="rounded-lg border bg-card p-4 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Link href={`/crm/representatives/${r.representativeId}`} className="text-primary hover:underline font-medium truncate">
          {r.name}
        </Link>
      </div>
      <div className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <span className="text-xs text-muted-foreground block">客户数</span>
          <span className="font-medium">{r.profileCount}</span>
        </div>
        <div>
          <span className="text-xs text-muted-foreground block">30天沟通</span>
          <span className="font-medium">{r.interactionCount}</span>
        </div>
        <div>
          <span className="text-xs text-muted-foreground block">30天签到</span>
          <span className="font-medium">{r.checkinCount}</span>
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        最近签到：{r.lastCheckinAt ? new Date(r.lastCheckinAt).toLocaleDateString("zh-CN") : "—"}
      </div>
    </div>
  );

  const renderCustomerMobileCard = (c: OrgDetail["customerSummary"][0]) => (
    <div className="rounded-lg border bg-card p-4 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Link href={`/crm/customers/${c.profileId}`} className="text-primary hover:underline font-medium truncate">
          {c.customerName}
        </Link>
        <StageBadge stage={c.stage} />
      </div>
      <div className="text-xs text-muted-foreground">{c.customerCode}</div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
        {c.labOrGroup && <span className="text-muted-foreground">{c.labOrGroup}</span>}
        <ImportanceBadge importance={c.importance} />
        <PersonCategoryBadge category={c.personCategory === "未设置" ? null : c.personCategory} />
      </div>
      <div className="text-sm">负责人：{c.ownerName}</div>
    </div>
  );

  return (
    <PageShell>
      <PageHeader
        title={d?.organization.canonicalName || "机构分析"}
        backHref="/admin/organizations/analytics"
        backLabel="返回分析"
      />

      {/* Top stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard title="总客户" value={d?.organization.customerCount ?? 0} icon={Users} variant="default" />
        <KpiCard title="CRM客户" value={d?.organization.crmProfileCount ?? 0} icon={UserCheck} variant="default" />
        <KpiCard title="覆盖代表" value={d ? d.representativeBreakdown.length : 0} icon={Handshake} variant="default" />
        <KpiCard
          title="30天沟通"
          value={d?.representativeBreakdown.reduce((s, r) => s + r.interactionCount, 0) ?? 0}
          icon={MessageSquare}
          variant="default"
        />
        <KpiCard
          title="30天签到"
          value={d?.representativeBreakdown.reduce((s, r) => s + r.checkinCount, 0) ?? 0}
          icon={MapPin}
          variant="default"
        />
        <KpiCard
          title="最近活动"
          value={d?.recentInteractions[0] ? new Date(d.recentInteractions[0].happenedAt).toLocaleDateString("zh-CN") : "—"}
          icon={CalendarDays}
          variant="default"
        />
      </div>

      {/* Org info */}
      {d && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Building2 className="h-4 w-4" />{d.organization.canonicalName}</CardTitle></CardHeader>
          <CardContent>
            <div className="text-sm space-y-1">
              <div className="flex gap-2 flex-wrap">
                <span className="text-muted-foreground">编号:</span>
                <span className="font-mono">{d.organization.orgCode}</span>
                {d.organization.taxId && <><span className="text-muted-foreground ml-3">税号:</span><span className="font-mono">{d.organization.taxId}</span></>}
              </div>
              {d.organization.address && <div><MapPin className="h-3 w-3 inline mr-1 text-muted-foreground" />{d.organization.address}</div>}
              {d.organization.aliases.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Tag className="h-3 w-3 text-muted-foreground" />
                  {d.organization.aliases.map((a) => <Badge key={a.id} variant="outline" className="text-xs">{a.alias}</Badge>)}
                </div>
              )}
              {d.organization.sites.length > 0 && (
                <div className="flex gap-1.5 flex-wrap mt-1">
                  {d.organization.sites.map((s) => (
                    <Badge key={s.id} variant="secondary" className="text-xs">{s.siteName}{s.siteType ? ` (${SITE_TYPE_LABELS[s.siteType] || s.siteType})` : ""}</Badge>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Representative breakdown */}
      {d && d.representativeBreakdown.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">代表表现</CardTitle></CardHeader>
          <CardContent>
            <DataTable
              columns={repColumns}
              data={d.representativeBreakdown}
              keyExtractor={(r) => r.representativeId}
              emptyTitle="暂无代表数据"
              renderMobileCard={renderRepMobileCard}
            />
          </CardContent>
        </Card>
      )}

      {/* Distributions */}
      {d && (
        <div className="grid sm:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">阶段分布</CardTitle></CardHeader>
            <CardContent>
              {Object.entries(d.distributions.stage).length === 0 ? (
                <p className="text-sm text-muted-foreground">暂无</p>
              ) : (
                <div className="space-y-1.5">
                  {Object.entries(d.distributions.stage).map(([stage, count]) => (
                    <div key={stage} className="flex items-center justify-between text-sm">
                      <StageBadge stage={stage} />
                      <span className="font-medium">{count}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">重要度分布</CardTitle></CardHeader>
            <CardContent>
              {Object.entries(d.distributions.importance).length === 0 ? (
                <p className="text-sm text-muted-foreground">暂无</p>
              ) : (
                <div className="space-y-1.5">
                  {Object.entries(d.distributions.importance).map(([imp, count]) => (
                    <div key={imp} className="flex items-center justify-between text-sm">
                      <ImportanceBadge importance={imp} />
                      <span className="font-medium">{count}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">人员分类</CardTitle></CardHeader>
            <CardContent>
              {Object.entries(d.distributions.personCategory).length === 0 ? (
                <p className="text-sm text-muted-foreground">暂无</p>
              ) : (
                <div className="space-y-1.5">
                  {Object.entries(d.distributions.personCategory).map(([pc, count]) => (
                    <div key={pc} className="flex items-center justify-between text-sm">
                      <PersonCategoryBadge category={pc === "未设置" ? null : pc} />
                      <span className="font-medium">{count}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Customer list */}
      {d && d.customerSummary.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center justify-between">
              <span>客户列表 <span className="text-sm text-muted-foreground font-normal">({d.organization.crmProfileCount})</span></span>
              <Link href={`/crm/customers?organizationId=${d.organization.id}&organizationName=${encodeURIComponent(d.organization.canonicalName)}`} className="inline-flex items-center gap-1 h-6 px-2 text-xs hover:bg-muted rounded-md"><Users className="h-3 w-3" />管理全部客户</Link>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={customerColumns}
              data={d.customerSummary.slice(0, 20)}
              keyExtractor={(c) => c.profileId}
              emptyTitle="暂无客户"
              renderMobileCard={renderCustomerMobileCard}
            />
          </CardContent>
        </Card>
      )}

      {/* Recent interactions + checkins */}
      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">最近沟通</CardTitle></CardHeader>
          <CardContent>
            {!d?.recentInteractions.length ? (
              <p className="text-sm text-muted-foreground">暂无记录</p>
            ) : (
              <div className="space-y-3">
                {d.recentInteractions.slice(0, 20).map((i) => (
                  <div key={i.id} className="text-sm">
                    <span className="text-muted-foreground">{INTERACTION_TYPE_LABELS[i.type] || i.type}</span>
                    <span className="mx-1">·</span>
                    <span>{i.summary}</span>
                    <span className="mx-1">·</span>
                    <span>{i.profile.name || "未命名客户"}</span>
                    <span className="mx-1">·</span>
                    <span className="text-muted-foreground">{i.createdByUser.name}</span>
                    <span className="mx-1">·</span>
                    <span className="text-muted-foreground">{new Date(i.happenedAt).toLocaleDateString("zh-CN")}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">最近签到</CardTitle></CardHeader>
          <CardContent>
            {!d?.recentCheckins.length ? (
              <p className="text-sm text-muted-foreground">暂无记录</p>
            ) : (
              <div className="space-y-2">
                {d.recentCheckins.slice(0, 20).map((c) => (
                  <div key={c.id} className="text-sm flex justify-between">
                    <span>{c.summaryTitle || c.addressSnapshot || "未知位置"}</span>
                    <span className="text-muted-foreground">{c.user.name} · {new Date(c.createdAt).toLocaleDateString("zh-CN")}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}
