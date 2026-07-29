"use client";

import { Suspense, useState, useEffect, useMemo } from "react";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectDisplay, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Search, ArrowRight, Users, Building2 } from "lucide-react";
import Link from "next/link";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable, DataTableColumn } from "@/components/ui/data-table";

interface OrgAnalyticsRow {
  organizationId: string;
  canonicalName: string;
  orgCode: string;
  customerCount: number;
  crmProfileCount: number;
  assignedProfileCount: number;
  unassignedProfileCount: number;
  representativeCount: number;
  interactionCount: number;
  checkinCount: number;
  visitDensity: number;
  interactionDensity: number;
  lastInteractionAt: string | null;
  lastCheckinAt: string | null;
  lastActivityAt: string | null;
}

export default function OrgAnalyticsPage() {
  return (
    <Suspense fallback={<PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>}>
      <OrgAnalyticsInner />
    </Suspense>
  );
}

function OrgAnalyticsInner() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const sp = useSearchParams();

  const [search, setSearch] = useState(sp.get("search") || "");
  const [range, setRange] = useState("30");
  const [sort, setSort] = useState("customerCount");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (status === "authenticated" && session?.user?.role !== "ADMIN") {
      router.push("/dashboard");
    }
  }, [status, session, router]);

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("range", range);
  params.set("sort", sort);
  params.set("order", order);
  params.set("page", String(page));
  params.set("pageSize", "25");

  const { data, isLoading } = useQuery<{
    organizations: OrgAnalyticsRow[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>({
    queryKey: ["org-analytics", search, range, sort, order, page],
    queryFn: () => fetch(`/api/crm/organization-analytics?${params}`).then((r) => r.json()),
    enabled: status === "authenticated" && session?.user?.role === "ADMIN",
  });

  const columns: DataTableColumn<OrgAnalyticsRow>[] = useMemo(() => [
    {
      key: "organization",
      header: "机构",
      render: (o) => (
        <div>
          <span className="font-medium">{o.canonicalName}</span>
          <div className="text-xs text-muted-foreground font-mono">{o.orgCode}</div>
        </div>
      ),
    },
    { key: "customerCount", header: "客户", align: "right", sortable: true },
    { key: "crmProfileCount", header: "CRM客户", align: "right", sortable: true, className: "hidden md:table-cell" },
    { key: "representativeCount", header: "负责代表", align: "right", sortable: true, className: "hidden lg:table-cell" },
    { key: "interactionCount", header: `${range}天沟通`, align: "right", sortable: true, sortValue: (o) => o.interactionCount },
    { key: "checkinCount", header: `${range}天签到`, align: "right", sortable: true, sortValue: (o) => o.checkinCount },
    {
      key: "visitDensity",
      header: "拜访密度",
      align: "right",
      sortable: true,
      className: "hidden sm:table-cell",
      render: (o) => <span className="font-mono">{o.visitDensity.toFixed(1)}</span>,
      sortValue: (o) => o.visitDensity,
    },
    {
      key: "lastActivityAt",
      header: "最近活动",
      align: "left",
      sortable: true,
      className: "hidden lg:table-cell",
      render: (o) => o.lastActivityAt ? new Date(o.lastActivityAt).toLocaleDateString("zh-CN") : "—",
      sortValue: (o) => o.lastActivityAt ?? "",
    },
    {
      key: "actions",
      header: "操作",
      render: (o) => (
        <div className="flex gap-1">
          <Link href={`/crm/customers?organizationId=${o.organizationId}&organizationName=${encodeURIComponent(o.canonicalName)}`} className="inline-flex items-center gap-1 h-6 px-2 text-xs hover:bg-muted rounded-md">
            <Users className="h-3 w-3" />客户
          </Link>
          <Link href={`/admin/organizations/${o.organizationId}/analytics`} className="inline-flex items-center gap-1 h-6 px-2 text-xs hover:bg-muted rounded-md">
            分析<ArrowRight className="h-3 w-3 ml-1" />
          </Link>
        </div>
      ),
    },
  ], [range]);

  if (status === "loading") return null;
  if (!session || session.user.role !== "ADMIN") return null;

  const orgs = data?.organizations || [];

  return (
    <PageShell>
      <PageHeader
        title="机构运营分析"
        description="按机构维度查看客户覆盖、沟通和拜访数据"
      />

      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="搜索机构..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="pl-9"
          />
        </div>
        <Select value={range} onValueChange={(v) => { setRange(v || "30"); setPage(1); }}>
          <SelectTrigger className="w-[120px]"><span>{range === "7" ? "近7天" : range === "30" ? "近30天" : range === "90" ? "近90天" : range + "天"}</span></SelectTrigger>
          <SelectContent>
            <SelectItem value="7">近7天</SelectItem>
            <SelectItem value="30">近30天</SelectItem>
            <SelectItem value="90">近90天</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => { setSort(v || "customerCount"); setPage(1); }}>
          <SelectTrigger className="w-[130px]"><SelectDisplay label="排序" valueLabel={
            sort === "customerCount" ? "客户数" :
            sort === "crmProfileCount" ? "CRM客户" :
            sort === "checkinCount" ? "签到数" :
            sort === "interactionCount" ? "沟通数" :
            sort === "visitDensity" ? "拜访密度" :
            sort === "lastActivityAt" ? "最近活动" : "默认"
          } placeholder="排序" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="customerCount">客户数</SelectItem>
            <SelectItem value="crmProfileCount">CRM客户</SelectItem>
            <SelectItem value="checkinCount">签到数</SelectItem>
            <SelectItem value="interactionCount">沟通数</SelectItem>
            <SelectItem value="visitDensity">拜访密度</SelectItem>
            <SelectItem value="lastActivityAt">最近活动</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" onClick={() => setOrder(order === "asc" ? "desc" : "asc")} className="h-9 text-xs">
          {order === "asc" ? "↑ 升序" : "↓ 降序"}
        </Button>
        <Link href="/admin/organizations" className="inline-flex items-center gap-1 h-7 px-2.5 text-[0.8rem] border border-input bg-background hover:bg-muted rounded-md"><Building2 className="h-4 w-4" />机构管理</Link>
      </div>

      <DataTable
        columns={columns}
        data={orgs}
        keyExtractor={(o) => o.organizationId}
        isLoading={isLoading}
        emptyTitle={search ? "未找到匹配的机构" : "暂无数据"}
        emptyDescription={search ? "请尝试更换搜索关键词" : "机构数据将在此展示"}
        sortKey={sort}
        sortDir={order}
        onSortChange={(key, dir) => { setSort(key); setOrder(dir); setPage(1); }}
        pagination={data?.totalPages ? {
          page: data.page,
          pageSize: data.pageSize,
          total: data.total,
          totalPages: data.totalPages,
          onPageChange: setPage,
        } : undefined}
      />
    </PageShell>
  );
}
