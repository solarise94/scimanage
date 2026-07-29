"use client";

import { Suspense, useState, useMemo } from "react";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectDisplay } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable, DataTableColumn } from "@/components/ui/data-table";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { CrmEmptyState } from "@/components/crm/empty-state";
import { crmKeys } from "@/lib/crm/query-keys";
import { SITE_TYPE_LABELS } from "@/lib/crm/constants";
import { Search, Building2, Users, Layers, Link2, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { useMediaQuery } from "@/hooks/use-media-query";

interface OrganizationFlowRow {
  organizationId: string;
  organizationName: string;
  orgCode: string;
  organizationSiteId: string | null;
  siteName: string | null;
  siteType: string | null;
  bindingStatus: "unbound" | "bound" | "pending" | "conflict";
  representative: {
    id: string;
    name: string;
    email: string;
    bindingId: string;
    isPrimary: boolean;
  } | null;
  activeBindingCount: number;
  pendingBindingCount: number;
  customerCount: number;
  recentOrderedCustomerCount: number;
  dormantWarningCustomerCount: number;
  uncommunicatedCustomerCount: number;
  lastHistoricalOrderAt: string | null;
}

const BINDING_STATUS_LABELS: Record<string, string> = {
  unbound: "未绑定",
  bound: "已绑定",
  pending: "待审核",
  conflict: "绑定冲突",
};

export default function OrganizationFlowPage() {
  return (
    <Suspense fallback={<PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>}>
      <OrganizationFlowPageInner />
    </Suspense>
  );
}

function OrganizationFlowPageInner() {
  const { data: session, status } = useSession();
  const router = useRouter();

  if (status === "unauthenticated") { router.push("/login"); return null; }
  if (status === "loading") return <PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>;
  if (session?.user?.role === "REPRESENTATIVE") { router.push("/crm"); return null; }

  return <OrganizationFlow />;
}

function OrganizationFlow() {
  const sp = useSearchParams();
  const queryClient = useQueryClient();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [search, setSearch] = useState(() => sp.get("search") || "");
  const [organizationId, setOrganizationId] = useState(() => sp.get("organizationId") || "");
  const [siteId, setSiteId] = useState(() => sp.get("siteId") || "");
  const [bindingStatus, setBindingStatus] = useState("");
  const [hasDormantWarning, setHasDormantWarning] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState("customerCount");
  const [order, setOrder] = useState("desc");
  const [bindTarget, setBindTarget] = useState<OrganizationFlowRow | null>(null);
  const [selectedRepId, setSelectedRepId] = useState("");

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (organizationId) params.set("organizationId", organizationId);
  if (siteId) params.set("siteId", siteId);
  if (bindingStatus) params.set("bindingStatus", bindingStatus);
  if (hasDormantWarning) params.set("hasDormantWarning", hasDormantWarning);
  params.set("page", String(page));
  params.set("sort", sort);
  params.set("order", order);

  const { data, isLoading } = useQuery<{
    rows: OrganizationFlowRow[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>({
    queryKey: ["crm-organization-flow", search, organizationId, siteId, bindingStatus, hasDormantWarning, page, sort, order],
    queryFn: () => fetch(`/api/crm/organization-flow?${params}`).then((r) => r.json()),
  });

  const rows = data?.rows || [];
  const totalPages = data?.totalPages || 1;

  const scanMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/crm/lifecycle/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      if (!res.ok) throw new Error("扫描失败");
      return res.json();
    },
    onSuccess: (d: { dormantCount: number; warnedCount: number }) => {
      toast.success(`休眠扫描完成，${d.dormantCount} 个客户进入休眠，${d.warnedCount} 个客户进入预警`);
      queryClient.invalidateQueries({ queryKey: crmKeys.organizationFlow() });
      queryClient.invalidateQueries({ queryKey: crmKeys.myToday() });
      queryClient.invalidateQueries({ queryKey: crmKeys.adminOverview() });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const bindMutation = useMutation({
    mutationFn: async () => {
      if (!bindTarget || !selectedRepId) throw new Error("请选择代表");
      const res = await fetch("/api/crm/representative-organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: bindTarget.organizationId,
          organizationSiteId: bindTarget.organizationSiteId,
          representativeId: selectedRepId,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "绑定失败");
      return json;
    },
    onSuccess: () => {
      toast.success("机构绑定已更新");
      setBindTarget(null);
      setSelectedRepId("");
      queryClient.invalidateQueries({ queryKey: crmKeys.organizationFlow() });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const { data: repsData } = useQuery<{ representatives: { id: string; name: string; email: string; archived: boolean }[] }>({
    queryKey: ["admin-representatives"],
    queryFn: () => fetch("/api/representatives/list").then((r) => r.json()),
    enabled: !!bindTarget,
  });
  const reps = repsData?.representatives.filter((r) => !r.archived) || [];

  const columns = useMemo<DataTableColumn<OrganizationFlowRow>[]>(() => [
    {
      key: "organization",
      header: "机构",
      render: (r) => (
        <div className="min-w-0 max-w-[220px]">
          <div className="font-medium text-sm truncate" title={r.organizationName}>{r.organizationName}</div>
          <div className="text-[11px] text-muted-foreground truncate">
            {r.siteName ? `${r.siteName}${r.siteType ? ` (${SITE_TYPE_LABELS[r.siteType] || r.siteType})` : ""}` : "机构级"}
          </div>
        </div>
      ),
    },
    {
      key: "binding",
      header: "绑定代表",
      render: (r) => (
        <div className="min-w-0">
          {r.representative ? (
            <Link href={`/crm/representatives/${r.representative.id}`} className="text-primary hover:underline text-sm truncate block">
              {r.representative.name}
            </Link>
          ) : (
            <span className="text-muted-foreground text-sm">未绑定</span>
          )}
          <Badge
            variant={r.bindingStatus === "conflict" ? "destructive" : r.bindingStatus === "bound" ? "default" : "secondary"}
            className="text-[10px] mt-1"
          >
            {BINDING_STATUS_LABELS[r.bindingStatus]}
          </Badge>
        </div>
      ),
    },
    {
      key: "customerCount",
      header: "客户",
      align: "right",
      render: (r) => <span className="text-sm">{r.customerCount}</span>,
    },
    {
      key: "recentOrderedCustomerCount",
      header: "近期下单",
      align: "right",
      className: "hidden md:table-cell",
      render: (r) => <span className="text-sm">{r.recentOrderedCustomerCount}</span>,
    },
    {
      key: "dormantWarningCustomerCount",
      header: "休眠预警",
      align: "right",
      className: "hidden lg:table-cell",
      render: (r) => (
        r.dormantWarningCustomerCount > 0
          ? <span className="text-warning text-sm font-medium">{r.dormantWarningCustomerCount}</span>
          : <span className="text-sm text-muted-foreground">0</span>
      ),
    },
    {
      key: "uncommunicatedCustomerCount",
      header: "30天未沟通",
      align: "right",
      className: "hidden lg:table-cell",
      render: (r) => <span className="text-sm">{r.uncommunicatedCustomerCount}</span>,
    },
    {
      key: "lastHistoricalOrderAt",
      header: "最近下单",
      className: "hidden xl:table-cell",
      render: (r) => (
        <span className="text-sm text-muted-foreground">
          {r.lastHistoricalOrderAt ? new Date(r.lastHistoricalOrderAt).toLocaleDateString("zh-CN") : "—"}
        </span>
      ),
    },
    {
      key: "actions",
      header: "操作",
      render: (r) => (
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => { setBindTarget(r); setSelectedRepId(r.representative?.id || ""); }}>
            <Link2 className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-8 px-2" render={
            <Link href={`/crm/customers?organizationId=${r.organizationId}${r.organizationSiteId ? `&siteId=${r.organizationSiteId}` : ""}&organizationName=${encodeURIComponent(r.organizationName)}`} />
          }>
            <Users className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-8 px-2" render={
            <Link href={`/admin/organizations/${r.organizationId}`} />
          }>
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        </div>
      ),
    },
  ], []);

  return (
    <PageShell className="space-y-4">
      <PageHeader
        title="机构流转"
        description="按机构/院区治理代表绑定；客户归属由机构绑定推导，不再支持客户级改派"
        actions={
          <Button variant="outline" className="h-9" onClick={() => scanMutation.mutate()} disabled={scanMutation.isPending}>
            <Layers className="h-4 w-4 mr-1" />
            {scanMutation.isPending ? "扫描中..." : "扫描休眠状态"}
          </Button>
        }
      />

      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="搜索机构名称、编号..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="pl-9"
          />
        </div>
        {!isMobile && (
          <>
            <Select value={bindingStatus || "__all__"} onValueChange={(v) => { setBindingStatus(v === "__all__" ? "" : (v || "")); setPage(1); }}>
              <SelectTrigger className="w-[120px] h-9 text-xs">
                <SelectDisplay label="绑定" valueLabel={bindingStatus ? BINDING_STATUS_LABELS[bindingStatus] : "全部绑定"} placeholder="绑定" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全部绑定</SelectItem>
                <SelectItem value="unbound">未绑定</SelectItem>
                <SelectItem value="bound">已绑定</SelectItem>
                <SelectItem value="pending">待审核</SelectItem>
                <SelectItem value="conflict">绑定冲突</SelectItem>
              </SelectContent>
            </Select>
            <Select value={hasDormantWarning || "__all__"} onValueChange={(v) => { setHasDormantWarning(v === "__all__" ? "" : (v || "")); setPage(1); }}>
              <SelectTrigger className="w-[120px] h-9 text-xs">
                <SelectDisplay label="休眠" valueLabel={hasDormantWarning === "true" ? "有预警" : hasDormantWarning === "false" ? "无预警" : "休眠预警"} placeholder="休眠" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全部</SelectItem>
                <SelectItem value="true">有预警</SelectItem>
                <SelectItem value="false">无预警</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={(v) => { setSort(v || "customerCount"); setPage(1); }}>
              <SelectTrigger className="w-[110px] h-9 text-xs"><span>排序</span></SelectTrigger>
              <SelectContent>
                <SelectItem value="customerCount">客户数</SelectItem>
                <SelectItem value="dormantWarningCustomerCount">休眠预警</SelectItem>
                <SelectItem value="lastHistoricalOrderAt">最近下单</SelectItem>
                <SelectItem value="organizationName">机构名</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="ghost" size="sm" className="h-9" onClick={() => setOrder(order === "asc" ? "desc" : "asc")}>
              {order === "asc" ? "↑" : "↓"}
            </Button>
          </>
        )}
      </div>

      <DataTable
        columns={columns}
        data={rows}
        keyExtractor={(r) => `${r.organizationId}:${r.organizationSiteId || ""}`}
        isLoading={isLoading}
        renderEmpty={<CrmEmptyState icon={Building2} title="暂无机构数据" />}
        pagination={totalPages > 1 ? { page, pageSize: 20, total: data?.total || 0, totalPages, onPageChange: setPage } : undefined}
        renderMobileCard={(r) => (
          <Card>
            <CardContent className="p-4 space-y-2">
              <div className="font-medium">{r.organizationName}</div>
              {r.siteName && <div className="text-xs text-muted-foreground">{r.siteName}</div>}
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="secondary">{BINDING_STATUS_LABELS[r.bindingStatus]}</Badge>
                <span>{r.customerCount} 客户</span>
                <span>{r.dormantWarningCustomerCount} 预警</span>
              </div>
              <div className="flex gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={() => { setBindTarget(r); setSelectedRepId(r.representative?.id || ""); }}>绑定代表</Button>
                <Button size="sm" variant="outline" render={
                  <Link href={`/crm/customers?organizationId=${r.organizationId}${r.organizationSiteId ? `&siteId=${r.organizationSiteId}` : ""}`} />
                }>查看客户</Button>
              </div>
            </CardContent>
          </Card>
        )}
      />

      <Dialog open={!!bindTarget} onOpenChange={(open) => { if (!open) { setBindTarget(null); setSelectedRepId(""); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>绑定代表</DialogTitle></DialogHeader>
          {bindTarget && (
            <p className="text-sm text-muted-foreground">
              {bindTarget.organizationName}
              {bindTarget.siteName ? ` · ${bindTarget.siteName}` : ""}
            </p>
          )}
          <Select value={selectedRepId} onValueChange={(v) => setSelectedRepId(v || "")}>
            <SelectTrigger>
              {selectedRepId
                ? <span>{reps.find((r) => r.id === selectedRepId)?.name || selectedRepId}</span>
                : <span className="text-muted-foreground">选择代表</span>}
            </SelectTrigger>
            <SelectContent>
              {reps.map((r) => (
                <SelectItem key={r.id} value={r.id}>{r.name} ({r.email})</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => bindMutation.mutate()} disabled={!selectedRepId || bindMutation.isPending} className="w-full">
            {bindMutation.isPending ? "保存中..." : "确认绑定"}
          </Button>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
