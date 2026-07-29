"use client";

import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Suspense, useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/ui/kpi-card";
import { DataTable } from "@/components/ui/data-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectDisplay } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import { crmKeys } from "@/lib/crm/query-keys";
import type { CrmRepresentativeOpsItem } from "@/lib/crm/types";
import { fetchJsonOrThrow } from "@/lib/fetch-client";
import Link from "next/link";
import { Search, Users, MessageSquare, AlertTriangle, X, UserCog, ShoppingCart, TrendingUp, RefreshCw, Banknote, BadgeCheck, UserCheck } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCollectionCycle, formatCollectionRate } from "@/lib/finance/collection-display";

/** API 金额字段统一为分；展示时换算为元 */
function formatCurrencyFromCents(cents: number) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format((cents || 0) / 100);
}

function amountCents(rep: CrmRepresentativeOpsItem, kind: "reserved" | "confirmed" | "new" | "delivery" | "aov"): number {
  switch (kind) {
    case "reserved":
      return rep.periodReservedOrderAmountCents ?? rep.periodReservedOrderAmount ?? 0;
    case "confirmed":
      return rep.periodConfirmedBusinessAmountCents ?? rep.periodConfirmedBusinessAmount ?? 0;
    case "new":
      return rep.periodNewBusinessAmountCents ?? rep.periodNewBusinessAmount ?? 0;
    case "delivery":
      return rep.periodDeliveryBusinessAmountCents ?? rep.periodDeliveryBusinessAmount ?? 0;
    case "aov":
      return rep.currentMonthAovCents ?? rep.currentMonthAov ?? 0;
  }
}

export default function RepresentativesOpsPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  if (status === "unauthenticated") { router.push("/login"); return null; }
  if (status === "loading") return <PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>;
  if (session?.user?.role === "REPRESENTATIVE") { router.push("/crm"); return null; }

  return <Suspense fallback={<PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>}><RepOpsList /></Suspense>;
}

function RepOpsList() {
  const searchParams = useSearchParams();
  const searchParamsString = searchParams.toString();
  return <RepOpsListState key={searchParamsString} searchParamsString={searchParamsString} />;
}

function RepOpsListState({ searchParamsString }: { searchParamsString: string }) {
  const searchParams = new URLSearchParams(searchParamsString);
  const booleanFilter = (key: string) => searchParams.get(key) === "true" ? "true" : searchParams.get(key) === "false" ? "false" : "";
  const periodFilter = () => {
    const value = searchParams.get("period");
    return value === "today" || value === "week" ? value : "";
  };
  const [searchInput, setSearchInput] = useState(() => searchParams.get("search") || "");
  const [search, setSearch] = useState(() => searchParams.get("search") || "");
  const [archived, setArchived] = useState(() => {
    const value = searchParams.get("archived");
    return value === "archived" || value === "all" ? value : "active";
  });
  const [hasOverdue, setHasOverdue] = useState(() => booleanFilter("hasOverdue"));
  const [hasLongUnvisited, setHasLongUnvisited] = useState(() => booleanFilter("hasLongUnvisited"));
  const [sort, setSort] = useState(() => searchParams.get("sort") || "name");
  const [order, setOrder] = useState(() => searchParams.get("order") === "desc" ? "desc" : "asc");
  const [regionId, setRegionId] = useState(() => searchParams.get("regionId") || "");
  const [selectedRepIds, setSelectedRepIds] = useState<string[]>(() => (searchParams.get("representativeIds") || "").split(",").filter(Boolean));
  const [period, setPeriod] = useState(() => periodFilter());

  // 搜索 debounce，避免每个按键全库重算
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (archived !== "active") params.set("archived", archived);
  if (hasOverdue) params.set("hasOverdue", hasOverdue);
  if (hasLongUnvisited) params.set("hasLongUnvisited", hasLongUnvisited);
  if (sort !== "name") params.set("sort", sort);
  if (order !== "asc") params.set("order", order);
  if (regionId) params.set("regionId", regionId);
  if (selectedRepIds.length > 0) params.set("representativeIds", selectedRepIds.join(","));
  if (period) params.set("period", period);
  const queryString = params.toString();

  useEffect(() => {
    const url = new URL(window.location.href);
    const nextSearch = queryString ? `?${queryString}` : "";
    if (url.search === nextSearch) return;
    window.history.replaceState(null, "", `${url.pathname}${nextSearch}${url.hash}`);
  }, [queryString]);

  const { data, isLoading, error } = useQuery<{ representatives: CrmRepresentativeOpsItem[] }>({
    queryKey: [...crmKeys.representativeOps(), search, archived, hasOverdue, hasLongUnvisited, sort, order, regionId, selectedRepIds.join(","), period],
    queryFn: () => fetchJsonOrThrow(`/api/crm/representatives?${params}`),
  });

  const { data: regionsData } = useQuery<{ regions: { id: string; name: string }[] }>({
    queryKey: ["representative-regions"],
    queryFn: () => fetchJsonOrThrow("/api/crm/representative-regions"),
  });
  const regions = regionsData?.regions || [];

  // 代表选择器只需要轻量列表，不走完整 KPI 聚合
  const { data: allRepsData } = useQuery<{
    representatives: Array<{ representativeId: string; name: string; email: string; archived: boolean }>;
  }>({
    queryKey: [...crmKeys.representativeOps(), "all-reps-lite"],
    queryFn: () => fetchJsonOrThrow("/api/crm/representatives?archived=all&lite=1"),
  });
  const allReps = allRepsData?.representatives || [];

  const reps = data?.representatives || [];
  const [repSelectOpen, setRepSelectOpen] = useState(false);

  const hasPeriod = period === "today" || period === "week";
  const totalInteractions = hasPeriod
    ? reps.reduce((s, r) => s + (r.periodInteractionCount || 0), 0)
    : reps.reduce((s, r) => s + (r.interactionCount30d || 0), 0);
  const totalNewCustomers = hasPeriod
    ? reps.reduce((s, r) => s + (r.periodNewCustomerCount || 0), 0)
    : 0;
  const totalOrders = hasPeriod
    ? reps.reduce((s, r) => s + (r.periodReservedOrderCount || 0), 0)
    : 0;
  const totalOrderAmountCents = hasPeriod
    ? reps.reduce((s, r) => s + amountCents(r, "reserved"), 0)
    : 0;
  const totalConfirmedBusinessAmountCents = hasPeriod
    ? reps.reduce((s, r) => s + amountCents(r, "confirmed"), 0)
    : 0;
  const totalOverdue = reps.reduce((s, r) => s + r.overdueFollowUps, 0);

  const totalCustomers = reps.reduce((s, r) => s + r.customerCount, 0);
  const totalActiveCustomers = reps.reduce((s, r) => s + (r.activeCustomerCount || 0), 0);
  const totalNewCustomerCount30d = reps.reduce((s, r) => s + (r.newCustomerCount30d || 0), 0);
  const totalConvertedCustomerCount30d = reps.reduce((s, r) => s + (r.convertedCustomerCount30d || 0), 0);
  const totalConversionRate30d = totalNewCustomerCount30d > 0
    ? totalConvertedCustomerCount30d / totalNewCustomerCount30d
    : 0;
  const totalNewCustomerCount90d = reps.reduce((s, r) => s + (r.newCustomerCount90d || 0), 0);
  const totalConvertedCustomerCount90d = reps.reduce((s, r) => s + (r.convertedCustomerCount90d || 0), 0);
  const totalConversionRate90d = totalNewCustomerCount90d > 0
    ? totalConvertedCustomerCount90d / totalNewCustomerCount90d
    : 0;
  const totalOrderedCustomerCount30d = reps.reduce((s, r) => s + (r.orderedCustomerCount30d || 0), 0);
  const totalRepeatCustomerCount30d = reps.reduce((s, r) => s + (r.repeatCustomerCount30d || 0), 0);
  const totalRepeatCustomerRate30d = totalOrderedCustomerCount30d > 0
    ? totalRepeatCustomerCount30d / totalOrderedCustomerCount30d
    : 0;
  const totalOrderedCustomerCount90d = reps.reduce((s, r) => s + (r.orderedCustomerCount90d || 0), 0);
  const totalRepeatCustomerCount90d = reps.reduce((s, r) => s + (r.repeatCustomerCount90d || 0), 0);
  const totalRepeatCustomerRate90d = totalOrderedCustomerCount90d > 0
    ? totalRepeatCustomerCount90d / totalOrderedCustomerCount90d
    : 0;

  const activeFilterCount =
    (searchInput || search ? 1 : 0)
    + (archived !== "active" ? 1 : 0)
    + (hasOverdue ? 1 : 0)
    + (hasLongUnvisited ? 1 : 0)
    + (regionId ? 1 : 0)
    + (selectedRepIds.length > 0 ? 1 : 0)
    + (period ? 1 : 0)
    + (sort !== "name" || order !== "asc" ? 1 : 0);

  const sortLabel = sort === "customerCount" ? "客户数"
    : sort === "overdueFollowUps" ? "逾期跟进"
    : sort === "longUnvisitedCount" ? "长期未访"
    : sort === "name" ? "姓名"
    : sort;

  return (
    <PageShell>
      <PageHeader title="代表运营" />

      <div className="grid gap-4 grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        {hasPeriod ? (
          <>
            <KpiCard icon={MessageSquare} title="已有客户沟通" value={totalInteractions} />
            <KpiCard icon={Users} title="新增客户" value={totalNewCustomers} />
            <KpiCard icon={ShoppingCart} title="下单数" value={totalOrders} />
            <KpiCard icon={Banknote} title="下单金额" value={totalOrderAmountCents} unit="cents" />
            <KpiCard icon={BadgeCheck} title="确认业务额" value={totalConfirmedBusinessAmountCents} unit="cents" />
            <KpiCard icon={AlertTriangle} title="逾期跟进" value={totalOverdue} variant={totalOverdue > 0 ? "danger" : "default"} />
          </>
        ) : (
          <>
            <KpiCard icon={Users} title="总客户数" value={totalCustomers} />
            <KpiCard icon={UserCheck} title="总活跃客户" value={totalActiveCustomers} />
            <KpiCard icon={TrendingUp} title="整体30天转化率" value={`${Math.round(totalConversionRate30d * 100)}%`} />
            <KpiCard icon={TrendingUp} title="整体90天转化率" value={`${Math.round(totalConversionRate90d * 100)}%`} />
            <KpiCard icon={RefreshCw} title="整体30天复购率" value={`${Math.round(totalRepeatCustomerRate30d * 100)}%`} />
            <KpiCard icon={RefreshCw} title="整体90天复购率" value={`${Math.round(totalRepeatCustomerRate90d * 100)}%`} />
            <KpiCard icon={AlertTriangle} title="逾期跟进" value={totalOverdue} variant={totalOverdue > 0 ? "danger" : "default"} />
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-sm flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="搜索代表姓名或邮箱..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={archived} onValueChange={(v) => setArchived(v || "active")}>
          <SelectTrigger className="w-[100px] h-9 text-xs"><SelectDisplay label="状态" valueLabel={archived === "active" ? "在职" : archived === "archived" ? "已归档" : "全部"} placeholder="状态" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="active">在职</SelectItem>
            <SelectItem value="archived">已归档</SelectItem>
            <SelectItem value="all">全部</SelectItem>
          </SelectContent>
        </Select>
        <Select value={hasOverdue} onValueChange={(v) => setHasOverdue(v || "")}>
          <SelectTrigger className="w-[100px] h-9 text-xs"><SelectDisplay label="逾期" valueLabel={hasOverdue === "true" ? "有逾期" : hasOverdue === "false" ? "无逾期" : "全部"} placeholder="逾期" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">全部</SelectItem>
            <SelectItem value="true">有逾期</SelectItem>
            <SelectItem value="false">无逾期</SelectItem>
          </SelectContent>
        </Select>
        <Select value={hasLongUnvisited} onValueChange={(v) => setHasLongUnvisited(v || "")}>
          <SelectTrigger className="w-[110px] h-9 text-xs"><SelectDisplay label="长期未访" valueLabel={hasLongUnvisited === "true" ? "有长期未访" : hasLongUnvisited === "false" ? "无长期未访" : "全部"} placeholder="长期未访" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">全部</SelectItem>
            <SelectItem value="true">有长期未访</SelectItem>
            <SelectItem value="false">无长期未访</SelectItem>
          </SelectContent>
        </Select>
        <Select value={regionId || "__all__"} onValueChange={(v) => setRegionId(v === "__all__" ? "" : (v || ""))}>
          <SelectTrigger className="w-[100px] h-9 text-xs"><SelectDisplay label="地区" valueLabel={regionId ? (regions.find((r) => r.id === regionId)?.name || regionId) : "全部"} placeholder="地区" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部地区</SelectItem>
            {regions.map((r) => (
              <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" className="h-9 text-xs" onClick={() => setRepSelectOpen(true)}>
          <UserCog className="h-3.5 w-3.5 mr-1" />
          {selectedRepIds.length > 0 ? `代表 (${selectedRepIds.length})` : "代表"}
        </Button>
        <Tabs value={period} onValueChange={(v) => setPeriod(v || "")} className="ml-auto">
          <TabsList>
            <TabsTrigger value="">全量</TabsTrigger>
            <TabsTrigger value="today">今日</TabsTrigger>
            <TabsTrigger value="week">本周</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {activeFilterCount > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {(searchInput || search) && (
            <Badge variant="secondary" className="text-xs gap-1">
              搜索: {search || searchInput}
              <button type="button" className="hover:text-danger" onClick={() => { setSearchInput(""); setSearch(""); }}>
                <X className="h-3 w-3 cursor-pointer" />
              </button>
            </Badge>
          )}
          {archived !== "active" && (
            <Badge variant="secondary" className="text-xs gap-1">
              状态: {archived === "archived" ? "已归档" : "全部"}
              <button type="button" className="hover:text-danger" onClick={() => setArchived("active")}>
                <X className="h-3 w-3 cursor-pointer" />
              </button>
            </Badge>
          )}
          {hasOverdue && (
            <Badge variant="secondary" className="text-xs gap-1">
              逾期: {hasOverdue === "true" ? "有逾期" : "无逾期"}
              <button type="button" className="hover:text-danger" onClick={() => setHasOverdue("")}>
                <X className="h-3 w-3 cursor-pointer" />
              </button>
            </Badge>
          )}
          {hasLongUnvisited && (
            <Badge variant="secondary" className="text-xs gap-1">
              长期未访: {hasLongUnvisited === "true" ? "有长期未访" : "无长期未访"}
              <button type="button" className="hover:text-danger" onClick={() => setHasLongUnvisited("")}>
                <X className="h-3 w-3 cursor-pointer" />
              </button>
            </Badge>
          )}
          {regionId && (
            <Badge variant="secondary" className="text-xs gap-1">
              地区: {regions.find((r) => r.id === regionId)?.name || regionId}
              <button type="button" className="hover:text-danger" onClick={() => setRegionId("")}>
                <X className="h-3 w-3 cursor-pointer" />
              </button>
            </Badge>
          )}
          {selectedRepIds.length > 0 && (
            <Badge variant="secondary" className="text-xs gap-1">
              代表 ×{selectedRepIds.length}
              <button type="button" className="hover:text-danger" onClick={() => setSelectedRepIds([])}>
                <X className="h-3 w-3 cursor-pointer" />
              </button>
            </Badge>
          )}
          {period && (
            <Badge variant="secondary" className="text-xs gap-1">
              {period === "today" ? "今日" : "本周"}
              <button type="button" className="hover:text-danger" onClick={() => setPeriod("")}>
                <X className="h-3 w-3 cursor-pointer" />
              </button>
            </Badge>
          )}
          {(sort !== "name" || order !== "asc") && (
            <Badge variant="secondary" className="text-xs gap-1">
              排序: {sortLabel} {order === "asc" ? "升" : "降"}
              <button type="button" className="hover:text-danger" onClick={() => { setSort("name"); setOrder("asc"); }}>
                <X className="h-3 w-3 cursor-pointer" />
              </button>
            </Badge>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={() => {
              setSearchInput("");
              setSearch("");
              setArchived("active");
              setHasOverdue("");
              setHasLongUnvisited("");
              setRegionId("");
              setSelectedRepIds([]);
              setPeriod("");
              setSort("name");
              setOrder("asc");
            }}
          >
            <X className="h-3 w-3 mr-0.5" />清空
          </Button>
        </div>
      )}

      {error ? (
        <div className="text-sm text-danger py-8 text-center">
          代表数据加载失败：{error instanceof Error ? error.message : "未知错误"}
        </div>
      ) : (
        <DataTable
          columns={hasPeriod ? periodColumns : allColumns}
          data={reps}
          keyExtractor={(r) => r.representativeId}
          renderMobileCard={(r) => <RepMobileCard rep={r} hasPeriod={hasPeriod} />}
          isLoading={isLoading}
          emptyTitle="暂无代表数据"
          sortKey={sort}
          sortDir={order === "desc" ? "desc" : "asc"}
          onSortChange={(key, dir) => {
            if (!key) {
              setSort("name");
              setOrder("asc");
              return;
            }
            setSort(key);
            setOrder(dir === "desc" ? "desc" : "asc");
          }}
        />
      )}

      <Dialog open={repSelectOpen} onOpenChange={setRepSelectOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>选择代表</DialogTitle></DialogHeader>
          <div className="border rounded-md max-h-60 overflow-y-auto p-2 space-y-1">
            {allReps.map((r) => (
              <label key={r.representativeId} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/50 rounded px-1 py-0.5">
                <input
                  type="checkbox"
                  checked={selectedRepIds.includes(r.representativeId)}
                  onChange={(e) => {
                    if (e.target.checked) setSelectedRepIds([...selectedRepIds, r.representativeId]);
                    else setSelectedRepIds(selectedRepIds.filter((id) => id !== r.representativeId));
                  }}
                />
                {r.name} <span className="text-xs text-muted-foreground">{r.email}</span>
              </label>
            ))}
            {allReps.length === 0 && <p className="text-xs text-muted-foreground p-2">暂无代表</p>}
          </div>
          <Button onClick={() => setRepSelectOpen(false)} className="w-full">确定</Button>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

function RepRegions({ rep }: { rep: CrmRepresentativeOpsItem }) {
  const regions = rep.regions ?? [];
  if (regions.length === 0) {
    return <span className="text-xs text-muted-foreground">-</span>;
  }
  return (
    <div className="flex gap-1 flex-wrap">
      {regions.map((region) => (
        <Badge key={region.id} variant={region.isPrimary ? "default" : "secondary"} className="text-xs">
          {region.name}
        </Badge>
      ))}
    </div>
  );
}

function RepMobileCard({ rep, hasPeriod }: { rep: CrmRepresentativeOpsItem; hasPeriod: boolean }) {
  const dormant = rep.dormantCustomerCount || 0;
  const unvisited = rep.longUnvisitedCount || 0;
  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link href={`/crm/representatives/${rep.representativeId}`} className="text-primary hover:underline font-medium">
              {rep.name}
            </Link>
            {rep.archived && <Badge variant="secondary" className="text-xs">已归档</Badge>}
          </div>
          {rep.overdueFollowUps > 0 && <span className="text-danger text-sm font-medium">逾期 {rep.overdueFollowUps}</span>}
        </div>
        <div className="text-xs text-muted-foreground"><RepRegions rep={rep} /></div>
        {hasPeriod ? (
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>已有客户沟通 <span className="font-medium tabular-nums">{rep.periodInteractionCount ?? 0}</span></div>
            <div>新增客户 <span className="font-medium tabular-nums">{rep.periodNewCustomerCount ?? 0}</span></div>
            <div>
              下单金额 <span className="font-medium tabular-nums">{formatCurrencyFromCents(amountCents(rep, "reserved"))}</span>
              <div className="text-xs text-muted-foreground tabular-nums">{rep.periodReservedOrderCount ?? 0} 单</div>
            </div>
            <div>确认业务额 <span className="font-medium tabular-nums">{formatCurrencyFromCents(amountCents(rep, "confirmed"))}</span></div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              客户数 <span className="font-medium tabular-nums">{rep.customerCount}</span>
              <div className="text-xs text-muted-foreground tabular-nums">活跃 {rep.activeCustomerCount ?? 0}</div>
            </div>
            <div>转化率(30d/90d) <span className="font-medium tabular-nums">{Math.round((rep.conversionRate30d || 0) * 100)}% · {Math.round((rep.conversionRate90d || 0) * 100)}%</span></div>
            <div>复购率(30d/90d) <span className="font-medium tabular-nums">{Math.round((rep.repeatCustomerRate30d || 0) * 100)}% · {Math.round((rep.repeatCustomerRate90d || 0) * 100)}%</span></div>
            <div>
              本月新增 <span className="font-medium tabular-nums">{rep.currentMonthNewCustomers ?? 0}</span>
              <div className="text-xs text-muted-foreground tabular-nums">转化 {Math.round((rep.currentMonthConversionRate || 0) * 100)}%</div>
            </div>
          </div>
        )}
        <div className="text-sm tabular-nums">
          休眠 <span className={`font-medium ${dormant > 0 ? "text-neutral" : ""}`}>{dormant}</span>
          {" · "}
          未访 <span className={`font-medium ${unvisited > 0 ? "text-warning" : ""}`}>{unvisited}</span>
        </div>
      </CardContent>
    </Card>
  );
}

const allColumns = [
  {
    key: "name",
    header: "代表",
    render: (r: CrmRepresentativeOpsItem) => (
      <div className="flex items-center gap-2">
        <Link href={`/crm/representatives/${r.representativeId}`} className="text-primary hover:underline font-medium">
          {r.name}
        </Link>
        {r.archived && <Badge variant="secondary" className="text-xs">已归档</Badge>}
      </div>
    ),
  },
  { key: "regions", header: "地区", render: (r: CrmRepresentativeOpsItem) => <RepRegions rep={r} /> },
  {
    key: "customerCount",
    header: "客户数",
    align: "right" as const,
    sortable: true,
    render: (r: CrmRepresentativeOpsItem) => (
      <div className="flex flex-col items-end">
        <span className="font-medium tabular-nums">{r.customerCount}</span>
        <span className="text-xs text-muted-foreground tabular-nums">活跃 {r.activeCustomerCount ?? 0}</span>
      </div>
    ),
  },
  {
    key: "conversion",
    header: "转化率(30d/90d)",
    align: "right" as const,
    render: (r: CrmRepresentativeOpsItem) => (
      <span className="tabular-nums">{Math.round((r.conversionRate30d || 0) * 100)}% · {Math.round((r.conversionRate90d || 0) * 100)}%</span>
    ),
  },
  {
    key: "repeat",
    header: "复购率(30d/90d)",
    align: "right" as const,
    render: (r: CrmRepresentativeOpsItem) => (
      <span className="tabular-nums">{Math.round((r.repeatCustomerRate30d || 0) * 100)}% · {Math.round((r.repeatCustomerRate90d || 0) * 100)}%</span>
    ),
  },
  {
    key: "currentMonthNewCustomers",
    header: "本月新增",
    align: "right" as const,
    render: (r: CrmRepresentativeOpsItem) => (
      <div className="flex flex-col items-end">
        <span className="font-medium tabular-nums">{r.currentMonthNewCustomers ?? 0}</span>
        <span className="text-xs text-muted-foreground tabular-nums">转化 {Math.round((r.currentMonthConversionRate || 0) * 100)}%</span>
      </div>
    ),
  },
  {
    key: "currentMonthAov",
    header: "本月客单价",
    align: "right" as const,
    render: (r: CrmRepresentativeOpsItem) => <span className="tabular-nums">{formatCurrencyFromCents(amountCents(r, "aov"))}</span>,
  },
  {
    key: "collection",
    header: "回款",
    align: "right" as const,
    render: (r: CrmRepresentativeOpsItem) => (
      <div className="flex flex-col items-end">
        <span className="tabular-nums">{formatCollectionCycle(r.avgCollectionCycleDays ?? null, r.collectionPairCount ?? 0)}</span>
        <span className="text-xs text-muted-foreground tabular-nums">季 {formatCollectionRate(
          r.quarterlyReceiptRate ?? null,
          r.quarterlyReceiptAmount ?? 0,
          r.quarterlyReceivableAmount ?? 0,
        )} · 年 {formatCollectionRate(
          r.yearlyReceiptRate ?? null,
          r.yearlyReceiptAmount ?? 0,
          r.yearlyReceivableAmount ?? 0,
        )}</span>
      </div>
    ),
  },
  {
    key: "overdueFollowUps",
    header: "逾期跟进",
    align: "right" as const,
    sortable: true,
    render: (r: CrmRepresentativeOpsItem) => (
      <span className={`tabular-nums ${r.overdueFollowUps > 0 ? "text-danger font-medium" : ""}`}>{r.overdueFollowUps}</span>
    ),
  },
  {
    key: "risk",
    header: "休眠/未访",
    align: "right" as const,
    render: (r: CrmRepresentativeOpsItem) => {
      const dormant = r.dormantCustomerCount || 0;
      const unvisited = r.longUnvisitedCount || 0;
      return (
        <span className="tabular-nums">
          休眠 <span className={dormant > 0 ? "text-neutral font-medium" : ""}>{dormant}</span>
          {" · "}
          未访 <span className={unvisited > 0 ? "text-warning font-medium" : ""}>{unvisited}</span>
        </span>
      );
    },
  },
];

const periodColumns = [
  {
    key: "name",
    header: "代表",
    render: (r: CrmRepresentativeOpsItem) => (
      <div className="flex items-center gap-2">
        <Link href={`/crm/representatives/${r.representativeId}`} className="text-primary hover:underline font-medium">
          {r.name}
        </Link>
        {r.archived && <Badge variant="secondary" className="text-xs">已归档</Badge>}
      </div>
    ),
  },
  { key: "regions", header: "地区", render: (r: CrmRepresentativeOpsItem) => <RepRegions rep={r} /> },
  { key: "periodInteractionCount", header: "已有客户沟通", align: "right" as const, sortable: false, render: (r: CrmRepresentativeOpsItem) => <span className="tabular-nums">{r.periodInteractionCount ?? 0}</span> },
  { key: "periodNewCustomerCount", header: "新增客户", align: "right" as const, sortable: false, render: (r: CrmRepresentativeOpsItem) => <span className="tabular-nums">{r.periodNewCustomerCount ?? 0}</span> },
  {
    key: "periodReservedOrderAmount",
    header: "下单金额",
    align: "right" as const,
    sortable: false,
    render: (r: CrmRepresentativeOpsItem) => (
      <div className="flex flex-col items-end">
        <span className="font-medium tabular-nums">{formatCurrencyFromCents(amountCents(r, "reserved"))}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{r.periodReservedOrderCount ?? 0} 单</span>
      </div>
    ),
  },
  {
    key: "periodNewBusinessAmount",
    header: "新增业务额",
    align: "right" as const,
    sortable: false,
    render: (r: CrmRepresentativeOpsItem) => <span className="tabular-nums">{formatCurrencyFromCents(amountCents(r, "new"))}</span>,
  },
  {
    key: "periodDeliveryBusinessAmount",
    header: "交付业务额",
    align: "right" as const,
    sortable: false,
    render: (r: CrmRepresentativeOpsItem) => <span className="tabular-nums">{formatCurrencyFromCents(amountCents(r, "delivery"))}</span>,
  },
  {
    key: "periodConfirmedBusinessAmount",
    header: "确认业务额",
    align: "right" as const,
    sortable: false,
    render: (r: CrmRepresentativeOpsItem) => <span className="tabular-nums">{formatCurrencyFromCents(amountCents(r, "confirmed"))}</span>,
  },
  {
    key: "overdueFollowUps",
    header: "逾期跟进",
    align: "right" as const,
    sortable: true,
    render: (r: CrmRepresentativeOpsItem) => (
      <span className={`tabular-nums ${r.overdueFollowUps > 0 ? "text-danger font-medium" : ""}`}>{r.overdueFollowUps}</span>
    ),
  },
];
