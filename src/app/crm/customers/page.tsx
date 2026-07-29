"use client";

import { Suspense } from "react";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useRef, useEffect, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectDisplay, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StageBadge, ImportanceBadge, AssignmentStatusBadge, PersonCategoryBadge, GraduationStatusBadge } from "@/components/crm/badges";
import { ActivateProfileDialog } from "@/components/crm/activate-profile-dialog";
import { CustomerApplicationFormDialog } from "@/components/crm/customer-application-form-dialog";
import { CustomerCreateFab } from "@/components/crm/customer-create-fab";
import { CRM_STAGES, STAGE_LABELS, CRM_IMPORTANCE, IMPORTANCE_LABELS, CRM_PERSON_CATEGORIES, PERSON_CATEGORY_LABELS, CRM_GRADUATION_STATUSES, GRADUATION_STATUS_LABELS } from "@/lib/crm/constants";
import { crmKeys } from "@/lib/crm/query-keys";
import type { CrmCustomerProfileItem } from "@/lib/crm/types";
import { toast } from "sonner";
import Link from "next/link";
import { useMediaQuery } from "@/hooks/use-media-query";
import { Card, CardContent } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Search, Filter, X, Users, Pencil, Archive, ArchiveRestore, ShieldAlert, LayoutList, AlertCircle, UserPlus, Eye, MoreHorizontal, SlidersHorizontal } from "lucide-react";
import { CrmEmptyState } from "@/components/crm/empty-state";
import { DataTable, DataTableColumn } from "@/components/ui/data-table";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CustomerEditDialog } from "@/components/crm/customer-edit-dialog";

type TableViewMode = "default" | "orders" | "followup" | "governance";

function isCommunicationTaskOverdue(p: CrmCustomerProfileItem): boolean {
  return Boolean(p.nextCommunicationTaskAt && new Date(p.nextCommunicationTaskAt) < new Date());
}

function getStatusSummary(p: CrmCustomerProfileItem): string | null {
  if (p.dormantRisk) return "休眠预警";
  if (isCommunicationTaskOverdue(p)) return "任务逾期";
  if (p.isRepeatCustomer) return "复购";
  if ((p.historicalOrderCount || 0) === 0) return "未下单";
  return null;
}

function profileIdentityId(p: { id: string }) {
  return p.id;
}

function profileToEditInitialCustomer(p: CrmCustomerProfileItem) {
  const v = p.customerView;
  return {
    id: profileIdentityId(p),
    name: v?.name ?? null,
    customerCode: v?.customerCode ?? null,
    principal: v?.principal ?? null,
    email: v?.email ?? null,
    wechat: v?.wechat ?? null,
    organization: v?.organization ?? null,
    organizationId: v?.organizationId ?? null,
    organizationSiteId: v?.organizationSiteId ?? null,
    organizationRawInput: v?.organizationRawInput ?? null,
    address: v?.address ?? null,
    miniProgramId: v?.miniProgramId ?? null,
    labOrGroup: v?.labOrGroup ?? null,
    phone: v?.phone ?? null,
  };
}

export default function CrmCustomersPage() {
  return (
    <Suspense fallback={<PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>}>
      <CrmCustomersWrapper />
    </Suspense>
  );
}

function CrmCustomersWrapper() {
  const { status } = useSession();
  const router = useRouter();
  const sp = useSearchParams();

  if (status === "unauthenticated") { router.push("/login"); return null; }
  if (status === "loading") return <PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>;

  return <CustomerPool initialSearch={sp.get("search") || ""} initialOrganizationId={sp.get("organizationId") || ""} initialOrganizationName={sp.get("organizationName") || ""} initialAssignee={sp.get("assignee") || ""} initialStage={sp.get("stage") || ""} initialSiteId={sp.get("siteId") || ""} />;
}

function CustomerPool({ initialSearch, initialOrganizationId, initialOrganizationName, initialAssignee, initialStage, initialSiteId }: { initialSearch: string; initialOrganizationId: string; initialOrganizationName: string; initialAssignee: string; initialStage: string; initialSiteId: string }) {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState(initialSearch);
  const [organizationId, setOrganizationId] = useState(initialOrganizationId);
  const [organizationName, setOrganizationName] = useState(initialOrganizationName);
  const [siteId, setSiteId] = useState(initialSiteId);
  const [stage, setStage] = useState(initialStage || "ALL");
  const [importance, setImportance] = useState("ALL");
  const [personCategory, setPersonCategory] = useState("ALL");
  const [graduationStatus, setGraduationStatus] = useState("ALL");
  const [jobTitle, setJobTitle] = useState("");
  const [hasOrder, setHasOrder] = useState("ALL");
  const [repeatCustomer, setRepeatCustomer] = useState("ALL");
  const [dormantRisk, setDormantRisk] = useState("ALL");
  const [communicationDue, setCommunicationDue] = useState("ALL");
  const [hasOpenComplaint, setHasOpenComplaint] = useState("ALL");
  const [hasHighRiskComplaint, setHasHighRiskComplaint] = useState("ALL");
  const [showArchived, setShowArchived] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [sort, setSort] = useState("updatedAt");
  const [order, setOrder] = useState("desc");
  const [page, setPage] = useState(1);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [viewMode, setViewMode] = useState<TableViewMode>("default");
  const [governanceMode, setGovernanceMode] = useState(false);
  const [assignee, setAssignee] = useState(initialAssignee || "ALL");
  const [editProfile, setEditProfile] = useState<CrmCustomerProfileItem | null>(null);

  // Batch site re-bind — ADMIN only.
  const [selectedMap, setSelectedMap] = useState<Map<string, { name: string; organizationId: string | null }>>(new Map());
  const [batchSiteOpen, setBatchSiteOpen] = useState(false);
  const [batchSiteTargetId, setBatchSiteTargetId] = useState("");

  const toggleSelect = (p: CrmCustomerProfileItem) =>
    setSelectedMap((prev) => {
      const next = new Map(prev);
      const orgId = p.customerView?.organizationId ?? null;
      const key = profileIdentityId(p);
      if (next.has(key)) next.delete(key);
      else next.set(key, { name: p.customerView?.name ?? "", organizationId: orgId });
      return next;
    });
  const clearSelection = () => { setSelectedMap(new Map()); setBatchSiteTargetId(""); };
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (organizationId) params.set("organizationId", organizationId);
  if (siteId) params.set("siteId", siteId);
  if (stage !== "ALL") params.set("stage", stage);
  if (importance !== "ALL") params.set("importance", importance);
  if (personCategory !== "ALL") params.set("personCategory", personCategory);
  if (graduationStatus !== "ALL") params.set("graduationStatus", graduationStatus);
  if (jobTitle) params.set("jobTitle", jobTitle);
  if (hasOrder !== "ALL") params.set("hasOrder", hasOrder);
  if (repeatCustomer !== "ALL") params.set("repeatCustomer", repeatCustomer);
  if (dormantRisk !== "ALL") params.set("dormantRisk", dormantRisk);
  if (communicationDue !== "ALL") params.set("communicationDue", communicationDue);
  if (hasOpenComplaint !== "ALL") params.set("hasOpenComplaint", hasOpenComplaint);
  if (hasHighRiskComplaint !== "ALL") params.set("hasHighRiskComplaint", hasHighRiskComplaint);
  if (showArchived) params.set("archived", "true");
  if (showDeleted) params.set("includeDeleted", "true");
  if (assignee !== "ALL") params.set("assignee", assignee);
  params.set("sort", sort);
  params.set("order", order);
  params.set("page", String(page));
  params.set("pageSize", "20");

  const { data, isLoading, error: listError } = useQuery<{ profiles: CrmCustomerProfileItem[]; total: number; page: number; pageSize: number; totalPages: number }>({
    queryKey: ["crm-profiles", search, organizationId, siteId, stage, importance, personCategory, graduationStatus, jobTitle, assignee, hasOrder, repeatCustomer, dormantRisk, communicationDue, hasOpenComplaint, hasHighRiskComplaint, sort, order, page, showArchived, showDeleted],
    queryFn: () => fetch(`/api/crm/profiles?${params}`).then((r) => {
      if (!r.ok) throw new Error("加载客户档案失败");
      return r.json();
    }),
  });

  const { data: assigneesData } = useQuery<{ assignees: AssigneeOption[] }>({
    queryKey: ["crm-assignees"],
    queryFn: () => fetch("/api/crm/assignees").then((r) => r.json()),
  });

  const { data: orgListData } = useQuery<{ options: { organizationId: string; organization: string | null }[] }>({
    queryKey: crmKeys.profileFilterOptions(),
    queryFn: () => fetch("/api/crm/profile-filter-options").then((r) => r.json()),
  });
  const uniqueOrgs = orgListData?.options
    ? [...new Map(orgListData.options.filter((c) => c.organizationId && c.organization).map((c) => [c.organizationId, c])).values()]
    : [];

  const { data: orgSitesData } = useQuery<{ sites: { id: string; siteName: string; siteType: string }[] }>({
    queryKey: ["organization-sites", organizationId],
    queryFn: () => fetch(`/api/organizations/${organizationId}`).then((r) => r.json()).then((d) => ({ sites: d.organization?.sites || [] })),
    enabled: !!organizationId,
  });
  const orgSites = orgSitesData?.sites || [];

  const { data: siteMetaData } = useQuery<{
    site: { id: string; siteName: string; siteType: string; organizationId: string; organizationName: string } | null;
  }>({
    queryKey: ["organization-site-meta", siteId],
    queryFn: () => fetch(`/api/organization-sites/${siteId}`).then((r) => r.json()),
    enabled: !!siteId && !organizationId,
  });
  const siteMeta = siteMetaData?.site;

  const backfilledRef = useRef(false);
  useEffect(() => {
    if (siteMeta && !organizationId && !backfilledRef.current) {
      backfilledRef.current = true;
      setOrganizationId(siteMeta.organizationId);
      setOrganizationName(siteMeta.organizationName);
    }
  }, [siteMeta, organizationId]);

  const siteDisplayName = siteMeta?.siteName || orgSites.find((s) => s.id === siteId)?.siteName || siteId;

  const selectedValues = [...selectedMap.values()];
  const distinctSelectedOrgIds = [...new Set(selectedValues.map((s) => s.organizationId))];
  const commonOrgId = selectedValues.length > 0 && distinctSelectedOrgIds.length === 1 ? distinctSelectedOrgIds[0] : null;
  const selectionMixedOrg = selectedValues.length > 0 && (distinctSelectedOrgIds.length > 1 || distinctSelectedOrgIds.includes(null));

  const { data: batchOrgData } = useQuery<{ organization?: { sites?: { id: string; siteName: string; siteType: string }[] } }>({
    queryKey: ["org-sites", commonOrgId],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${commonOrgId}`);
      if (!res.ok) throw new Error("加载院区失败");
      return res.json();
    },
    enabled: batchSiteOpen && !!commonOrgId,
  });
  const batchSiteOptions = batchOrgData?.organization?.sites ?? [];

  const batchAssignSiteMutation = useMutation({
    mutationFn: async ({ profileIds, organizationSiteId }: { profileIds: string[]; organizationSiteId: string }) => {
      const res = await fetch("/api/crm/profiles/batch-assign-site", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileIds, organizationSiteId }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "批量挂院区失败");
      return d as { updated: number; organizationSiteId: string };
    },
    onSuccess: (data) => {
      toast.success(`已挂院区（${data.updated} 个客户）`);
      setBatchSiteOpen(false);
      setBatchSiteTargetId("");
      clearSelection();
      queryClient.invalidateQueries({ queryKey: crmKeys.profiles() });
      queryClient.invalidateQueries({ queryKey: ["crm-customer-pool"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const profiles = data?.profiles || [];
  const isAdmin = session?.user?.role === "ADMIN";
  const isRep = session?.user?.role === "REPRESENTATIVE";
  const isMobile = useMediaQuery("(max-width: 767px)");

  const activeFilterCount = [stage, importance, personCategory, graduationStatus, assignee, hasOrder, repeatCustomer, dormantRisk, communicationDue, hasOpenComplaint, hasHighRiskComplaint].filter((v) => v !== "ALL").length + (jobTitle ? 1 : 0) + (organizationId ? 1 : 0) + (siteId ? 1 : 0) + (showArchived ? 1 : 0) + (showDeleted ? 1 : 0);

  function clearAllFilters() {
    setStage("ALL");
    setImportance("ALL");
    setPersonCategory("ALL");
    setGraduationStatus("ALL");
    setJobTitle("");
    setHasOrder("ALL");
    setRepeatCustomer("ALL");
    setDormantRisk("ALL");
    setCommunicationDue("ALL");
    setHasOpenComplaint("ALL");
    setHasHighRiskComplaint("ALL");
    setShowArchived(false);
    setShowDeleted(false);
    setAssignee("ALL");
    setOrganizationId("");
    setOrganizationName("");
    setSiteId("");
    setSort("updatedAt");
    setOrder("desc");
    setPage(1);
  }

  const FilterControls = (
    <div className="space-y-5 max-w-full overflow-x-hidden">
      <FilterSection title="档案属性">
        <FilterField label="阶段">
          <Select value={stage} onValueChange={(v) => { setStage(v || "ALL"); setPage(1); }}>
            <SelectTrigger className="w-full min-w-0 h-8 text-xs"><SelectDisplay label="阶段" valueLabel={stage === "ALL" ? "全部阶段" : STAGE_LABELS[stage] || "未知"} placeholder="阶段" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部阶段</SelectItem>
              {CRM_STAGES.map((s) => (
                <SelectItem key={s} value={s}>{STAGE_LABELS[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>
        <FilterField label="重要度">
          <Select value={importance} onValueChange={(v) => { setImportance(v || "ALL"); setPage(1); }}>
            <SelectTrigger className="w-full min-w-0 h-8 text-xs"><SelectDisplay label="重要度" valueLabel={importance === "ALL" ? "全部重要度" : IMPORTANCE_LABELS[importance] || "未知"} placeholder="重要度" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部重要度</SelectItem>
              {CRM_IMPORTANCE.map((i) => (
                <SelectItem key={i} value={i}>{IMPORTANCE_LABELS[i]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>
        <FilterField label="人员分类">
          <Select value={personCategory} onValueChange={(v) => { setPersonCategory(v || "ALL"); setPage(1); }}>
            <SelectTrigger className="w-full min-w-0 h-8 text-xs"><SelectDisplay label="分类" valueLabel={personCategory === "ALL" ? "全部分类" : PERSON_CATEGORY_LABELS[personCategory] || "未知"} placeholder="全部分类" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部分类</SelectItem>
              {CRM_PERSON_CATEGORIES.map((pc) => (
                <SelectItem key={pc} value={pc}>{PERSON_CATEGORY_LABELS[pc]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>
        <FilterField label="毕业状态">
          <Select value={graduationStatus} onValueChange={(v) => { setGraduationStatus(v || "ALL"); setPage(1); }}>
            <SelectTrigger className="w-full min-w-0 h-8 text-xs"><SelectDisplay label="毕业" valueLabel={graduationStatus === "ALL" ? "全部状态" : GRADUATION_STATUS_LABELS[graduationStatus] || "未知"} placeholder="全部状态" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部状态</SelectItem>
              {CRM_GRADUATION_STATUSES.map((gs) => (
                <SelectItem key={gs} value={gs}>{GRADUATION_STATUS_LABELS[gs]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>
      </FilterSection>

      <FilterSection title="归属与单位">
        <FilterField label="负责人">
          <Select value={assignee} onValueChange={(v) => { setAssignee(v || "ALL"); setPage(1); }}>
            <SelectTrigger className="w-full min-w-0 h-8 text-xs"><SelectDisplay label="负责人" valueLabel={assignee === "ALL" ? "全部" : assignee === "UNASSIGNED" ? "未指派" : (assigneesData?.assignees || []).find((a) => a.userId === assignee)?.name || assignee} placeholder="全部" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部</SelectItem>
              <SelectItem value="UNASSIGNED">未指派</SelectItem>
              {(assigneesData?.assignees || []).map((a) => (
                <SelectItem key={a.userId} value={a.userId}>{a.name}{a.kind === "representative" ? " (代表)" : ""}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>
        <FilterField label="单位">
          <Select value={organizationId || "__all__"} onValueChange={(v) => { const id = v === "__all__" ? "" : (v || ""); setOrganizationId(id); setOrganizationName(""); setSiteId(""); setPage(1); }}>
            <SelectTrigger className="w-full min-w-0 h-8 text-xs"><span className="block truncate">{organizationId ? (uniqueOrgs.find((o) => o.organizationId === organizationId)?.organization?.slice(0, 12) || organizationId) : "全部单位"}</span></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部单位</SelectItem>
              {uniqueOrgs.slice(0, 50).map((o) => (
                <SelectItem key={o.organizationId} value={o.organizationId!}>{o.organization}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>
        {organizationId && (orgSites.length > 0 || siteMeta) && (
          <FilterField label="院区">
            <Select value={siteId || "__all__"} onValueChange={(v) => { setSiteId(v === "__all__" ? "" : (v || "")); setPage(1); }}>
              <SelectTrigger className="w-full min-w-0 h-8 text-xs"><span className="block truncate">{siteId ? siteDisplayName : "全部院区"}</span></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全部院区</SelectItem>
                {orgSites.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.siteName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>
        )}
      </FilterSection>

      <FilterSection title="运营标记">
        <FilterField label="订单状态">
          <Select value={hasOrder} onValueChange={(v) => { setHasOrder(v || "ALL"); setPage(1); }}>
            <SelectTrigger className="w-full min-w-0 h-8 text-xs"><span>{hasOrder === "ALL" ? "全部" : hasOrder === "true" ? "有下单" : "未下单"}</span></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部</SelectItem>
              <SelectItem value="true">有下单</SelectItem>
              <SelectItem value="false">未下单</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>
        <FilterField label="复购">
          <Select value={repeatCustomer} onValueChange={(v) => { setRepeatCustomer(v || "ALL"); setPage(1); }}>
            <SelectTrigger className="w-full min-w-0 h-8 text-xs"><span>{repeatCustomer === "ALL" ? "全部" : repeatCustomer === "true" ? "复购客户" : "非复购"}</span></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部</SelectItem>
              <SelectItem value="true">复购客户</SelectItem>
              <SelectItem value="false">非复购</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>
        <FilterField label="休眠风险">
          <Select value={dormantRisk} onValueChange={(v) => { setDormantRisk(v || "ALL"); setPage(1); }}>
            <SelectTrigger className="w-full min-w-0 h-8 text-xs"><span>{dormantRisk === "ALL" ? "全部" : dormantRisk === "true" ? "有风险" : "无风险"}</span></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部</SelectItem>
              <SelectItem value="true">有风险</SelectItem>
              <SelectItem value="false">无风险</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>
        <FilterField label="沟通任务">
          <Select value={communicationDue} onValueChange={(v) => { setCommunicationDue(v || "ALL"); setPage(1); }}>
            <SelectTrigger className="w-full min-w-0 h-8 text-xs"><span>{communicationDue === "ALL" ? "全部" : communicationDue === "true" ? "有任务" : "无任务"}</span></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部</SelectItem>
              <SelectItem value="true">有任务</SelectItem>
              <SelectItem value="false">无任务</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>
      </FilterSection>

      <FilterSection title="客诉">
        <FilterField label="未关闭客诉">
          <Select value={hasOpenComplaint} onValueChange={(v) => { setHasOpenComplaint(v || "ALL"); setPage(1); }}>
            <SelectTrigger className="w-full min-w-0 h-8 text-xs"><span>{hasOpenComplaint === "ALL" ? "全部" : hasOpenComplaint === "true" ? "有客诉" : "无客诉"}</span></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部</SelectItem>
              <SelectItem value="true">有未关闭客诉</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>
        <FilterField label="高严重客诉">
          <Select value={hasHighRiskComplaint} onValueChange={(v) => { setHasHighRiskComplaint(v || "ALL"); setPage(1); }}>
            <SelectTrigger className="w-full min-w-0 h-8 text-xs"><span>{hasHighRiskComplaint === "ALL" ? "全部" : "高风险"}</span></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部</SelectItem>
              <SelectItem value="true">有高风险客诉</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>
      </FilterSection>

      {isAdmin && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/50 dark:border-amber-900/50 dark:bg-amber-950/20 p-3 space-y-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wider">
            <ShieldAlert className="h-3.5 w-3.5" />
            管理员治理视图
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="crm-show-archived"
              checked={showArchived}
              onCheckedChange={(checked) => { setShowArchived(Boolean(checked)); setPage(1); }}
            />
            <Label htmlFor="crm-show-archived" className="text-xs text-muted-foreground cursor-pointer">显示已归档</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="crm-show-deleted"
              checked={showDeleted}
              onCheckedChange={(checked) => { setShowDeleted(Boolean(checked)); setPage(1); }}
            />
            <Label htmlFor="crm-show-deleted" className="text-xs text-destructive cursor-pointer font-medium">显示已删除</Label>
          </div>
        </div>
      )}

      <FilterSection title="排序">
        <div className="space-y-2">
          <Select value={sort} onValueChange={(v) => { setSort(v || "updatedAt"); setPage(1); }}>
            <SelectTrigger className="w-full min-w-0 h-8 text-xs"><span>{sort === "updatedAt" ? "最近更新" : sort === "createdAt" ? "创建时间" : sort === "lastFollowUpAt" ? "最近跟进" : sort === "nextFollowUpAt" ? "下次跟进" : sort === "stage" ? "阶段" : sort === "lastHistoricalOrderAt" ? "最近下单" : sort === "historicalOrderCount" ? "下单次数" : "默认"}</span></SelectTrigger>
            <SelectContent>
              <SelectItem value="updatedAt">最近更新</SelectItem>
              <SelectItem value="createdAt">创建时间</SelectItem>
              <SelectItem value="lastFollowUpAt">最近跟进</SelectItem>
              <SelectItem value="nextFollowUpAt">下次跟进</SelectItem>
              <SelectItem value="stage">阶段</SelectItem>
              <SelectItem value="lastHistoricalOrderAt">最近下单</SelectItem>
              <SelectItem value="historicalOrderCount">下单次数</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setOrder(order === "asc" ? "desc" : "asc")} className="h-7 text-xs flex-1">
              {order === "asc" ? "↑ 升序" : "↓ 降序"}
            </Button>
            {activeFilterCount > 0 && (
              <Button variant="ghost" size="sm" onClick={clearAllFilters} className="h-7 text-xs"><X className="h-3 w-3 mr-1" />清空</Button>
            )}
          </div>
        </div>
      </FilterSection>
    </div>
  );

  const columns = useMemo<DataTableColumn<CrmCustomerProfileItem>[]>(() => {
    const showGovernance = isAdmin && (governanceMode || viewMode === "governance");
    const cols: DataTableColumn<CrmCustomerProfileItem>[] = [];

    if (showGovernance) {
      cols.push({
        key: "select",
        header: "",
        width: "40px",
        render: (p) => (
          <input
            type="checkbox"
            className="h-4 w-4 cursor-pointer align-middle"
                aria-label={`选择 ${p.customerView?.name ?? "客户"}`}
            checked={selectedMap.has(profileIdentityId(p))}
            onClick={(e) => e.stopPropagation()}
            onChange={() => toggleSelect(p)}
          />
        ),
      });
    }

    cols.push({
      key: "customer",
      header: "客户",
      render: (p) => {
        const status = getStatusSummary(p);
        return (
          <div className="min-w-0 max-w-[180px]">
            <Link href={`/crm/customers/${p.id}`} className="text-primary hover:underline font-medium text-sm truncate block">
              {p.customerView?.name || "—"}
            </Link>
            <div className="text-[11px] text-muted-foreground truncate">{p.customerView?.customerCode || "—"}</div>
            {status && <Badge variant="outline" className="text-[10px] mt-1">{status}</Badge>}
            {p.deleted && <Badge variant="destructive" className="text-[10px] mt-1">已删除</Badge>}
          </div>
        );
      },
    });

    cols.push({
      key: "organization",
      header: "机构",
      className: "hidden md:table-cell",
      render: (p) => (
        <div className="min-w-0 max-w-[200px] text-muted-foreground">
          <div className="text-sm truncate" title={p.customerView?.organization || undefined}>{p.customerView?.organization || "-"}</div>
          {p.customerView?.labOrGroup && (
            <div className="text-xs truncate" title={p.customerView.labOrGroup}>
              {p.customerView.labOrGroup}
            </div>
          )}
        </div>
      ),
    });

    cols.push({
      key: "stage",
      header: "阶段",
      sortable: true,
      render: (p) => (
        <div className="flex items-center gap-1">
          <StageBadge stage={p.stage} />
          <ImportanceBadge importance={p.importance} />
        </div>
      ),
    });

    cols.push({
      key: "owner",
      header: "负责人",
      className: "hidden sm:table-cell",
      render: (p) => (
        <span className="text-sm truncate max-w-[100px] inline-block">
          {p.assignmentStatus === "ASSIGNED" ? p.ownerUser.name : "未绑定"}
        </span>
      ),
    });

    if (viewMode === "orders" || viewMode === "default") {
      cols.push({
        key: "orders",
        header: "订单",
        sortable: viewMode === "orders",
        className: viewMode === "default" ? "hidden lg:table-cell" : undefined,
        render: (p) => (
          <div className="text-sm whitespace-nowrap">
            <div>{p.historicalOrderCount || 0} 单</div>
            <div className="text-xs text-muted-foreground">
              {p.lastHistoricalOrderAt ? new Date(p.lastHistoricalOrderAt).toLocaleDateString("zh-CN") : "未下单"}
            </div>
          </div>
        ),
      });
    }

    if (viewMode === "followup" || viewMode === "default") {
      cols.push({
        key: "followup",
        header: "跟进",
        className: viewMode === "default" ? "hidden xl:table-cell" : undefined,
        render: (p) => (
          <div className="text-sm whitespace-nowrap">
            <div className="text-muted-foreground text-xs">
              最近 {p.lastFollowUpAt ? new Date(p.lastFollowUpAt).toLocaleDateString("zh-CN") : "—"}
            </div>
            <div className={isCommunicationTaskOverdue(p) ? "text-danger text-xs" : "text-xs"}>
              任务 {p.nextCommunicationTaskAt ? new Date(p.nextCommunicationTaskAt).toLocaleDateString("zh-CN") : "—"}
            </div>
          </div>
        ),
      });
    }

    if (viewMode === "governance") {
      cols.push(
        {
          key: "personCategory",
          header: "分类",
          render: (p) => <PersonCategoryBadge category={p.personCategory} />,
        },
        {
          key: "graduationStatus",
          header: "毕业",
          render: (p) => <GraduationStatusBadge status={p.graduationStatus || null} />,
        },
        {
          key: "assignmentStatus",
          header: "分配",
          render: (p) => <AssignmentStatusBadge status={p.assignmentStatus} />,
        },
      );
    }

    if (!isRep) {
      cols.push({
        key: "actions",
        header: "",
        className: "w-[88px]",
        render: (p) => (
          <div className="flex items-center justify-end gap-0.5">
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" render={<Link href={`/crm/customers/${p.id}`} />}>
              <Eye className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setEditProfile(p)}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="h-8 w-8 p-0"><MoreHorizontal className="h-3.5 w-3.5" /></Button>} />
              <DropdownMenuContent align="end">
                {isAdmin && (
                  <ArchiveButton
                    profileId={p.id}
                    name={p.customerView?.name ?? ""}
                    archived={p.archived}
                    asMenuItem
                  />
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      });
    }

    return cols;
  }, [isRep, isAdmin, selectedMap, viewMode, governanceMode]);

  return (
    <PageShell className="space-y-4">
      <PageHeader
        title="客户档案库"
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            {!isRep && !isMobile && <ActivateProfileDialog />}
            {!isMobile && (
              <CustomerApplicationFormDialog
                trigger={
                  <Button variant="outline" size="sm">
                    <UserPlus className="h-4 w-4 mr-1" />申请新增客户
                  </Button>
                }
              />
            )}
          </div>
        }
      />

      {/* Search + compact filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="搜索客户名称、编号、单位..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="pl-9"
          />
        </div>
        {!isMobile && (
          <>
            <Select value={stage} onValueChange={(v) => { setStage(v || "ALL"); setPage(1); }}>
              <SelectTrigger className="w-[100px] h-9 text-xs"><SelectDisplay label="阶段" valueLabel={stage === "ALL" ? "全部阶段" : STAGE_LABELS[stage] || "?"} placeholder="阶段" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">全部阶段</SelectItem>
                {CRM_STAGES.map((s) => (<SelectItem key={s} value={s}>{STAGE_LABELS[s]}</SelectItem>))}
              </SelectContent>
            </Select>
            <Select value={assignee} onValueChange={(v) => { setAssignee(v || "ALL"); setPage(1); }}>
              <SelectTrigger className="w-[100px] h-9 text-xs"><SelectDisplay label="负责人" valueLabel={assignee === "ALL" ? "全部" : assignee === "UNASSIGNED" ? "未绑定" : (assigneesData?.assignees || []).find((a) => a.userId === assignee)?.name || assignee} placeholder="负责人" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">全部</SelectItem>
                <SelectItem value="UNASSIGNED">未绑定</SelectItem>
                {(assigneesData?.assignees || []).map((a) => (
                  <SelectItem key={a.userId} value={a.userId}>{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={organizationId || "__all__"} onValueChange={(v) => { const id = v === "__all__" ? "" : (v || ""); setOrganizationId(id); setOrganizationName(""); setSiteId(""); setPage(1); }}>
              <SelectTrigger className="w-[110px] h-9 text-xs"><span className="truncate">{organizationId ? (uniqueOrgs.find((o) => o.organizationId === organizationId)?.organization?.slice(0, 8) || "机构") : "机构"}</span></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全部机构</SelectItem>
                {uniqueOrgs.slice(0, 50).map((o) => (
                  <SelectItem key={o.organizationId} value={o.organizationId!}>{o.organization}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={hasOrder} onValueChange={(v) => { setHasOrder(v || "ALL"); setPage(1); }}>
              <SelectTrigger className="w-[90px] h-9 text-xs"><span>{hasOrder === "ALL" ? "订单" : hasOrder === "true" ? "有下单" : "未下单"}</span></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">全部</SelectItem>
                <SelectItem value="true">有下单</SelectItem>
                <SelectItem value="false">未下单</SelectItem>
              </SelectContent>
            </Select>
            <Select value={repeatCustomer} onValueChange={(v) => { setRepeatCustomer(v || "ALL"); setPage(1); }}>
              <SelectTrigger className="w-[90px] h-9 text-xs"><span>{repeatCustomer === "ALL" ? "复购" : repeatCustomer === "true" ? "复购" : "非复购"}</span></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">全部</SelectItem>
                <SelectItem value="true">复购</SelectItem>
                <SelectItem value="false">非复购</SelectItem>
              </SelectContent>
            </Select>
            <Select value={dormantRisk} onValueChange={(v) => { setDormantRisk(v || "ALL"); setPage(1); }}>
              <SelectTrigger className="w-[100px] h-9 text-xs"><span>{dormantRisk === "ALL" ? "休眠" : dormantRisk === "true" ? "有风险" : "无风险"}</span></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">全部</SelectItem>
                <SelectItem value="true">有风险</SelectItem>
                <SelectItem value="false">无风险</SelectItem>
              </SelectContent>
            </Select>
            <Select value={viewMode} onValueChange={(v) => setViewMode((v || "default") as TableViewMode)}>
              <SelectTrigger className="w-[100px] h-9 text-xs"><span>{viewMode === "default" ? "默认视图" : viewMode === "orders" ? "订单视图" : viewMode === "followup" ? "跟进视图" : "治理视图"}</span></SelectTrigger>
              <SelectContent>
                <SelectItem value="default">默认视图</SelectItem>
                <SelectItem value="orders">订单视图</SelectItem>
                <SelectItem value="followup">跟进视图</SelectItem>
                <SelectItem value="governance">治理视图</SelectItem>
              </SelectContent>
            </Select>
            <Sheet open={moreFiltersOpen} onOpenChange={setMoreFiltersOpen}>
              <SheetTrigger render={<Button variant="outline" size="sm" className="h-9"><SlidersHorizontal className="h-4 w-4 mr-1" />更多筛选</Button>} />
              <SheetContent side="right" className="w-[320px] overflow-y-auto">
                <SheetHeader><SheetTitle>更多筛选</SheetTitle></SheetHeader>
                <div className="mt-4">{FilterControls}</div>
              </SheetContent>
            </Sheet>
          </>
        )}
        {isMobile && (
          <Sheet open={filterSheetOpen} onOpenChange={setFilterSheetOpen}>
            <SheetTrigger render={<Button variant="outline" size="sm"><Filter className="h-4 w-4 mr-1" />筛选{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}</Button>} />
            <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
              <SheetHeader><SheetTitle>筛选条件</SheetTitle></SheetHeader>
              <div className="mt-4 max-w-full overflow-x-hidden">{FilterControls}</div>
            </SheetContent>
          </Sheet>
        )}
        {isAdmin && (
          <Button
            variant={governanceMode ? "default" : "outline"}
            size="sm"
            className="h-9"
            onClick={() => { setGovernanceMode((v) => !v); if (!governanceMode) setViewMode("governance"); }}
          >
            <ShieldAlert className="h-4 w-4 mr-1" />治理模式
          </Button>
        )}
      </div>

      {activeFilterCount > 0 && (
        <div className="flex gap-1 flex-wrap">
          {stage !== "ALL" && <Badge variant="secondary" className="text-xs">阶段: {STAGE_LABELS[stage]}</Badge>}
          {importance !== "ALL" && <Badge variant="secondary" className="text-xs">重要度: {IMPORTANCE_LABELS[importance]}</Badge>}
          {personCategory !== "ALL" && <Badge variant="secondary" className="text-xs">分类: {PERSON_CATEGORY_LABELS[personCategory]}</Badge>}
          {graduationStatus !== "ALL" && <Badge variant="secondary" className="text-xs">毕业: {GRADUATION_STATUS_LABELS[graduationStatus]}</Badge>}
          {assignee !== "ALL" && <Badge variant="secondary" className="text-xs">负责人: {assignee === "UNASSIGNED" ? "未指派" : (assigneesData?.assignees || []).find((a) => a.userId === assignee)?.name || assignee}</Badge>}
          {jobTitle && <Badge variant="secondary" className="text-xs">职务: {jobTitle}</Badge>}
          {organizationId && (
            <Badge variant="secondary" className="text-xs gap-1">
              机构: {organizationName || organizationId}
              <button type="button" className="hover:text-danger" onClick={() => { setOrganizationId(""); setOrganizationName(""); setSiteId(""); setPage(1); }}>
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {siteId && (
            <Badge variant="secondary" className="text-xs gap-1">
              院区: {siteDisplayName}
              <button type="button" className="hover:text-red-500" onClick={() => { setSiteId(""); setPage(1); }}>
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {showArchived && <Badge variant="secondary" className="text-xs">已归档</Badge>}
          {showDeleted && <Badge variant="destructive" className="text-xs">已删除（治理视图）</Badge>}
        </div>
      )}

      {isAdmin && governanceMode && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/40 dark:border-amber-900/50 dark:bg-amber-950/20 px-4 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wider">
              <ShieldAlert className="h-3.5 w-3.5" />
              管理员治理
            </div>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                className="h-4 w-4 cursor-pointer align-middle rounded border-amber-300 text-amber-600 focus:ring-amber-500"
                aria-label="本页全选"
                checked={profiles.length > 0 && profiles.filter((p) => !p.deleted).every((p) => selectedMap.has(profileIdentityId(p)))}
                onChange={() => {
                  const allPageSelected = profiles.length > 0 && profiles.filter((p) => !p.deleted).every((p) => selectedMap.has(profileIdentityId(p)));
                  setSelectedMap((prev) => {
                    const next = new Map(prev);
                    if (allPageSelected) {
                      for (const p of profiles) next.delete(profileIdentityId(p));
                    } else {
                      for (const p of profiles) {
                        if (!p.deleted) {
                          const orgId = p.customerView?.organizationId ?? null;
                          next.set(profileIdentityId(p), { name: p.customerView?.name ?? "", organizationId: orgId });
                        }
                      }
                    }
                    return next;
                  });
                }}
              />
              本页全选
            </label>
            {selectedMap.size > 0 ? (
              <>
                <span className="font-medium">已选 {selectedMap.size} 个</span>
                <Button size="sm" onClick={() => { setBatchSiteTargetId(""); setBatchSiteOpen(true); }} aria-label="批量挂院区">
                  批量挂院区
                </Button>
                <Button size="sm" variant="ghost" onClick={clearSelection}>清除选择</Button>
                {selectionMixedOrg && (
                  <span className="text-xs text-amber-600">选中客户分属不同机构或未绑定机构，挂院区需同一机构</span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground text-xs">勾选客户后可批量挂院区（须同一机构）</span>
            )}
          </div>
        </div>
      )}

      <div className="min-w-0">
          {listError && (
            <div className="mb-4 rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
              <div className="flex items-center gap-2 font-medium">
                <AlertCircle className="h-4 w-4" />
                加载失败
              </div>
              <p className="mt-1 text-destructive/80">{listError instanceof Error ? listError.message : "请稍后重试"}</p>
            </div>
          )}
          <DataTable
            columns={columns}
            data={profiles}
            keyExtractor={(p) => p.id}
            isLoading={isLoading}
            renderEmpty={<CrmEmptyState icon={Users} title="暂无 CRM 客户档案" />}
            pagination={data?.totalPages ? { page, pageSize: 20, total: data.total, totalPages: data.totalPages, onPageChange: (p) => setPage(p) } : undefined}
            sortKey={sort}
            sortDir={order as "asc" | "desc"}
            onSortChange={(key, dir) => { setSort(key || "updatedAt"); setOrder(dir); setPage(1); }}
            renderMobileCard={(p) => (
              <Card className="hover:border-primary/50 transition-colors">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/crm/customers/${p.id}`}
                        className="block truncate text-base font-medium text-primary hover:underline"
                      >
                        {p.customerView?.name || "—"}
                      </Link>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {p.customerView?.customerCode || "—"}
                        {p.customerView?.organization ? ` · ${p.customerView.organization}` : ""}
                      </div>
                    </div>
                    <StageBadge stage={p.stage} />
                  </div>
                  {p.customerView?.labOrGroup && (
                    <div className="mt-1 truncate text-xs text-muted-foreground">{p.customerView.labOrGroup}</div>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <ImportanceBadge importance={p.importance} />
                    {getStatusSummary(p) && <Badge variant="outline" className="text-xs">{getStatusSummary(p)}</Badge>}
                    <span className="text-xs text-muted-foreground">{p.assignmentStatus === "ASSIGNED" ? p.ownerUser.name : "未绑定"}</span>
                  </div>
                  <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
                    {p.nextCommunicationTaskAt ? (
                      <span className={isCommunicationTaskOverdue(p) ? "text-danger" : ""}>
                        沟通任务: {new Date(p.nextCommunicationTaskAt).toLocaleDateString("zh-CN")}
                      </span>
                    ) : (
                      <span>暂无沟通任务</span>
                    )}
                    <span className="ml-auto">{p.historicalOrderCount || 0} 单 · {p.lastHistoricalOrderAt ? new Date(p.lastHistoricalOrderAt).toLocaleDateString("zh-CN") : "未下单"}</span>
                  </div>
                  {!isRep && (
                    <div className="flex gap-2 mt-3 flex-wrap">
                      <Button variant="outline" size="sm" onClick={() => setEditProfile(p)}>
                        <Pencil className="h-3.5 w-3.5 mr-1" />编辑
                      </Button>
                      {isAdmin && governanceMode && (
                        <ArchiveButton
                          profileId={p.id}
                          name={p.customerView?.name ?? ""}
                          archived={p.archived}
                        />
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          />
      </div>

      {editProfile && (
        <CustomerEditDialog
          profileId={editProfile.id}
          initialCustomer={profileToEditInitialCustomer(editProfile)}
          open={!!editProfile}
          onOpenChange={(open) => { if (!open) setEditProfile(null); }}
          canEdit={!isRep}
        />
      )}

      {/* Batch assign site (院区下钻) */}
      <Dialog open={batchSiteOpen} onOpenChange={setBatchSiteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>批量挂院区</DialogTitle></DialogHeader>
          {!commonOrgId ? (
            <p className="text-sm text-amber-600">
              选中的客户必须属于<span className="font-medium">同一个已绑定机构</span>，才能批量挂院区。请调整选择。
            </p>
          ) : batchSiteOptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              该机构暂无可用院区（未归档）。请先在机构管理中为其添加院区。
            </p>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                将选中的 <span className="font-medium text-foreground">{selectedMap.size}</span> 个客户挂载到下列院区，客户的生效代表将随之重算。
              </p>
              <div className="space-y-2">
                <Label>目标院区</Label>
                <Select value={batchSiteTargetId} onValueChange={(v) => setBatchSiteTargetId(v || "")}>
                  <SelectTrigger>
                    <SelectDisplay label="院区" valueLabel={batchSiteTargetId ? batchSiteOptions.find((s) => s.id === batchSiteTargetId)?.siteName || batchSiteTargetId : "选择院区..."} placeholder="选择院区..." />
                  </SelectTrigger>
                  <SelectContent>
                    {batchSiteOptions.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.siteName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="outline" onClick={() => setBatchSiteOpen(false)}>取消</Button>
                <Button
                  disabled={!batchSiteTargetId || batchAssignSiteMutation.isPending}
                  onClick={() => batchAssignSiteMutation.mutate({ profileIds: [...selectedMap.keys()], organizationSiteId: batchSiteTargetId })}
                >
                  {batchAssignSiteMutation.isPending ? "挂载中..." : `确认挂载（${selectedMap.size}）`}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {isMobile && (
        <CustomerCreateFab />
      )}
    </PageShell>
  );
}

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground uppercase tracking-wider">
        <LayoutList className="h-3 w-3 text-muted-foreground" />
        {title}
      </h4>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs text-muted-foreground font-medium">{label}</label>
      {children}
    </div>
  );
}

interface AssigneeOption {
  userId: string;
  name: string;
  kind: "self" | "representative";
}

function ArchiveButton({
  profileId,
  name,
  archived,
  asMenuItem = false,
}: {
  profileId: string;
  name: string;
  archived: boolean;
  asMenuItem?: boolean;
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

  const handleClick = async () => {
    const action = archived ? "恢复" : "归档";
    const ok = await confirm({
      title: `${action}客户`,
      description: `确定要${action}客户 "${name}" 吗？`,
    });
    if (ok) mutation.mutate();
  };

  if (asMenuItem) {
    return (
      <DropdownMenuItem onClick={handleClick} disabled={mutation.isPending}>
        {archived ? <><ArchiveRestore className="h-3.5 w-3.5 mr-2" />恢复客户</> : <><Archive className="h-3.5 w-3.5 mr-2" />归档客户</>}
      </DropdownMenuItem>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={archived ? `恢复客户 ${name}` : `归档客户 ${name}`}
      className={archived
        ? "h-8 text-green-600 hover:text-green-700 hover:bg-green-50"
        : "h-8 text-amber-600 hover:text-amber-700 hover:bg-amber-50"}
      onClick={handleClick}
      disabled={mutation.isPending}
    >
      {archived ? <><ArchiveRestore className="h-3.5 w-3.5 mr-1" />恢复</> : <><Archive className="h-3.5 w-3.5 mr-1" />归档</>}
    </Button>
  );
}