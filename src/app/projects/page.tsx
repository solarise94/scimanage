"use client";

import { useState, useRef, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ProjectItem } from "@/lib/types";
import {
  Plus,
  Search,
  Clock,
  CheckCircle2,
  Circle,
  PauseCircle,
  Ban,
  ClipboardCopy,
  SlidersHorizontal,
  Filter,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectDisplay, SelectItem, SelectTrigger } from "@/components/ui/select";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { RepresentativeSelect } from "@/components/representative-select";
import { CustomerSelect } from "@/components/customer-select";
import { OrganizationSelect } from "@/components/organization-select";
import { DraftInputPanel } from "@/components/draft-input-panel";
import { getFeishuProjectHeader, projectsToFeishuText } from "@/lib/feishu-export";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { ProjectCard } from "@/components/projects/project-card";
import { StatusChips, StatusChipItem } from "@/components/projects/status-chips";
import { Pagination } from "@/components/ui/pagination";
import { useMediaQuery } from "@/hooks/use-media-query";
import { Fab } from "@/components/ui/fab";

const STATUS_CONFIG: Record<string, { label: string; icon: React.ElementType; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  NOT_STARTED: { label: "未开始", icon: Circle, variant: "secondary" },
  IN_PROGRESS: { label: "进行中", icon: Clock, variant: "default" },
  COMPLETED: { label: "已完成", icon: CheckCircle2, variant: "outline" },
  ON_HOLD: { label: "暂停", icon: PauseCircle, variant: "destructive" },
  TERMINATED: { label: "终止", icon: Ban, variant: "destructive" },
};

// 状态 chip 配色点（未选中时的视觉提示，与 ProjectCard 左边框语义色一致）
const STATUS_DOT: Record<string, string> = {
  NOT_STARTED: "bg-muted-foreground/40",
  IN_PROGRESS: "bg-info",
  COMPLETED: "bg-success",
  ON_HOLD: "bg-warning",
  TERMINATED: "bg-danger",
};

const STATUS_CHIP_ORDER = ["NOT_STARTED", "IN_PROGRESS", "COMPLETED", "ON_HOLD", "TERMINATED"];

const SORT_OPTIONS = [
  { value: "", label: "默认" },
  { value: "progress", label: "进度" },
  { value: "createdAt", label: "创建时间" },
  { value: "updatedAt", label: "更新时间" },
];

const PAGE_SIZE = 12;

export default function ProjectsPage() {
  return (
    <Suspense fallback={<PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>}>
      <ProjectsPageShell />
    </Suspense>
  );
}

function ProjectsPageShell() {
  const searchParams = useSearchParams();
  const createParam = searchParams.get("create") === "1";
  return (
    <ProjectsPageInner
      key={createParam ? "create" : "default"}
      defaultOpen={createParam}
      initialSortKey={searchParams.get("sort") || ""}
      initialSortDir={(searchParams.get("order") === "asc" ? "asc" : "desc")}
    />
  );
}

function ProjectsPageInner({ defaultOpen, initialSortKey, initialSortDir }: { defaultOpen: boolean; initialSortKey: string; initialSortDir: "asc" | "desc"; }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status, data: session } = useSession();
  const queryClient = useQueryClient();
  const { confirm } = useConfirm();
  const isAdmin = session?.user?.role === "ADMIN";
  const isRepresentative = session?.user?.role === "REPRESENTATIVE";
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [dateRange, setDateRange] = useState<string>("ALL");
  const [archivedFilter, setArchivedFilter] = useState<string>("active");
  const [repFilter, setRepFilter] = useState("ALL");
  const [custFilter, setCustFilter] = useState("ALL");
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState(initialSortKey);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initialSortDir);
  const ARCHIVED_LABELS: Record<string, string> = { active: "活跃", archived: "已归档", deleted: "已删除" };
  const DATE_LABELS: Record<string, string> = { ALL: "全部时间", "7d": "最近7天", "30d": "最近30天", "90d": "最近90天", "1y": "最近一年" };
  const [open, setOpen] = useState(defaultOpen);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [selectedOrgId, setSelectedOrgId] = useState("");
  const [customerOrgId, setCustomerOrgId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    description: "",
    projectNo: "",
    organization: "",
    client: "",
    representative: "",
    representativeId: "",
    profileId: "",
    status: "NOT_STARTED",
    progress: 0,
    startDate: new Date().toISOString().slice(0, 10),
    endDate: "",
  });

  // ── 筛选参数构建（代表/客户改为服务端筛选，看板与分页列表口径一致）──
  const buildParams = (withPage?: number) => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (statusFilter !== "ALL") params.set("status", statusFilter);
    if (dateRange !== "ALL") params.set("dateRange", dateRange);
    if (archivedFilter === "archived") params.set("archived", "true");
    else if (archivedFilter === "active") params.set("archived", "false");
    else if (archivedFilter === "deleted" && isAdmin) params.set("includeDeleted", "true");
    if (repFilter !== "ALL") {
      if (repFilter.startsWith("_text:")) params.set("representativeName", repFilter.slice(6));
      else params.set("representativeId", repFilter);
    }
    if (custFilter !== "ALL") {
      if (custFilter.startsWith("_text:")) params.set("customerName", custFilter.slice(6));
      else params.set("profileId", custFilter);
    }
    if (withPage) {
      params.set("page", String(withPage));
      params.set("pageSize", String(PAGE_SIZE));
      if (sortKey) {
        params.set("sort", sortKey);
        params.set("order", sortDir);
      }
    }
    return params;
  };

  const filterKey = [search, statusFilter, dateRange, archivedFilter, repFilter, custFilter, sortKey, sortDir].join("|");

  // 网格视图：分页查询（始终传 page，走分页分支以应用用户排序）
  const { data: listData, isLoading: listLoading } = useQuery<{ projects: ProjectItem[]; total: number; totalPages: number }>({
    queryKey: ["projects", "list", filterKey, page],
    queryFn: async () => {
      const res = await fetch(`/api/projects?${buildParams(page).toString()}`);
      if (!res.ok) throw new Error("Failed to load projects");
      return res.json();
    },
    enabled: status === "authenticated",
  });

  // 状态 chip 计数：按状态分组，不含 status 筛选（否则只显示当前选中状态计数）
  const filterKeyWithoutStatus = [search, dateRange, archivedFilter, repFilter, custFilter].join("|");
  const { data: countData } = useQuery<{ counts: Record<string, number> }>({
    queryKey: ["projects", "count", filterKeyWithoutStatus],
    queryFn: async () => {
      const params = buildParams();
      // count 接口忽略 status，但 buildParams 会带上——这里剔除
      params.delete("status");
      const res = await fetch(`/api/projects/count?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load counts");
      return res.json();
    },
    enabled: status === "authenticated",
  });

  const { data: filterOptions } = useQuery<{ representatives: { id: string; name: string }[]; customers: { id: string; name: string }[] }>({
    queryKey: ["projects-filter-options"],
    queryFn: async () => {
      const res = await fetch("/api/projects/filter-options");
      if (!res.ok) throw new Error("Failed to load filter options");
      return res.json();
    },
    enabled: status === "authenticated",
  });

  const repOptions = filterOptions?.representatives || [];
  const custOptions = filterOptions?.customers || [];
  const repLabelMap = new Map(repOptions.map((r) => [r.id, r.name]));
  const custLabelMap = new Map(custOptions.map((c) => [c.id, c.name]));

  // 筛选变化时重置到第 1 页
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    setPage(1);
  }, [filterKey]);

  // 排序 URL 同步（仅 sort/order，不扩大其他筛选）。
  // 用 ref 持有最新 searchParams，避免 router.replace → searchParams 变化 → effect 重复触发。
  const searchParamsRef = useRef(searchParams);
  useEffect(() => {
    searchParamsRef.current = searchParams;
  });
  useEffect(() => {
    const current = new URLSearchParams(searchParamsRef.current.toString());
    if (sortKey) {
      current.set("sort", sortKey);
      current.set("order", sortDir);
    } else {
      current.delete("sort");
      current.delete("order");
    }
    router.replace(current.toString() ? `/projects?${current.toString()}` : "/projects", { scroll: false });
  }, [sortKey, sortDir, router]);

  const createMutation = useMutation({
    mutationFn: async (payload: typeof form) => {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Failed to create project");
      return res.json();
    },
    onSuccess: () => {
      toast.success("项目创建成功");
      setOpen(false);
      setForm({ name: "", description: "", projectNo: "", organization: "", client: "", representative: "", representativeId: "", profileId: "", status: "NOT_STARTED", progress: 0, startDate: new Date().toISOString().slice(0, 10), endDate: "" });
      setSelectedOrgId("");
      setCustomerOrgId(null);
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
    },
    onError: () => toast.error("创建项目失败"),
  });

  if (status === "loading") return null;

  const isLoading = listLoading;
  const projects = listData?.projects || [];

  const moreFilterCount = (dateRange !== "ALL" ? 1 : 0) + (repFilter !== "ALL" ? 1 : 0) + (custFilter !== "ALL" ? 1 : 0);
  const hasAnyFilter = !!search || statusFilter !== "ALL" || dateRange !== "ALL" || archivedFilter !== "active" || repFilter !== "ALL" || custFilter !== "ALL";

  // 状态 chip 数据：count 接口驱动
  const counts = countData?.counts;
  const statusChipItems: StatusChipItem[] = [
    { key: "ALL", label: "全部", count: counts?._total ?? 0 },
    ...STATUS_CHIP_ORDER.map((s) => ({
      key: s,
      label: STATUS_CONFIG[s]?.label || s,
      count: counts?.[s] ?? 0,
      dotColor: STATUS_DOT[s],
    })),
  ];

  function clearAllFilters() {
    setRepFilter("ALL");
    setCustFilter("ALL");
    setSearch("");
    setStatusFilter("ALL");
    setDateRange("ALL");
    setArchivedFilter("active");
    setSortKey("");
    setSortDir("desc");
  }

  async function exportFeishu() {
    // 全量导出（无 page → 命中 API 全量分支），不受当前列表分页影响
    try {
      const res = await fetch(`/api/projects?${buildParams().toString()}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      const list: ProjectItem[] = data.projects || [];
      if (list.length === 0) { toast.info("无可导出的项目"); return; }
      const text = getFeishuProjectHeader() + "\n" + projectsToFeishuText(list);
      await navigator.clipboard.writeText(text);
      toast.success(`已复制 ${list.length} 条项目到剪贴板`);
    } catch {
      toast.error("导出失败");
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;

    if (form.profileId && selectedOrgId && !customerOrgId) {
      const confirmed = await confirm({
        title: "同步关联单位",
        description: `是否将单位「${form.organization}」同步关联到客户主数据？`,
      });
      if (confirmed) {
        try {
          const res = await fetch(`/api/customers/${form.profileId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", "x-customer-api-caller": "projects-page" },
            body: JSON.stringify({ organizationId: selectedOrgId, organization: form.organization }),
          });
          if (res.ok) {
            toast.success("客户已关联到该单位");
            queryClient.invalidateQueries({ queryKey: ["customers-list"] });
          } else {
            toast.warning("客户关联单位失败，将继续创建项目");
          }
        } catch {
          toast.warning("客户关联单位失败，将继续创建项目");
        }
      }
    }

    createMutation.mutate(form);
  }

  return (
    <PageShell>
      <PageHeader
        title="项目"
        description="管理您的科研项目"
        actions={
          !isRepresentative && (
            <div className="hidden md:block">
              <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger render={<Button />}>
                  <Plus className="mr-2 h-4 w-4" />
                  新建项目
                </DialogTrigger>
          <DialogContent className="sm:max-w-lg max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
            <DialogHeader>
              <DialogTitle>新建项目</DialogTitle>
            </DialogHeader>
            <form onSubmit={onSubmit} className="contents">
              <div className="-mx-4 min-h-0 overflow-y-auto overscroll-contain px-4 pb-1" style={{ WebkitOverflowScrolling: "touch" }}>
                <div className="space-y-4">
              <DraftInputPanel
                formKey="project.create"
                fieldLabels={{
                  name: "项目名称", description: "项目描述",
                  organization: "单位", client: "客户", representative: "代表",
                  status: "状态", startDate: "开始日期", endDate: "结束日期",
                  progress: "项目进度",
                }}
                fallbackPlugin="project.smart-fill"
                onApply={async (fields) => {
                  // Whitelist: only base fields allowed for new project creation.
                  // Product/financial fields are managed through orders.
                  const ALLOWED_KEYS = new Set([
                    "name", "description", "projectNo",
                    "organization", "client", "profileId", "representativeId", "representative",
                    "status", "progress", "startDate", "endDate",
                  ]);
                  const filtered: Record<string, unknown> = {};
                  for (const [k, v] of Object.entries(fields)) {
                    if (ALLOWED_KEYS.has(k)) filtered[k] = v;
                  }
                  fields = filtered;

                  type EntityField = { id?: string; name: string; matched: boolean; shouldCreate?: boolean; address?: string; organization?: string; organizationId?: string };
                  const updates: Record<string, unknown> = {};
                  let newProfileId = "";
                  let newSelectedOrgId = "";
                  let newCustomerOrgId: string | null = null;
                  let clientTouched = false;
                  let orgTouched = false;

                  // --- Phase 1: Collect all fields and determine intent ---
                  let orgEntity: EntityField | null = null;
                  let clientEntity: EntityField | null = null;
                  for (const [key, value] of Object.entries(fields)) {
                    if (typeof value === "object" && value !== null && "matched" in value) {
                      const entity = value as EntityField;
                      if (key === "organization") { orgEntity = entity; orgTouched = true; }
                      else if (key === "client") { clientEntity = entity; clientTouched = true; }
                    } else {
                      updates[key] = value;
                    }
                  }

                  // Normalize numeric fields to avoid number/string confusion
                  const numFields = ["progress"] as const;
                  for (const k of numFields) {
                    const v = updates[k];
                    if (v === undefined || v === null || v === "") continue;
                    // Clean common formatting: %, ¥, commas, 元, whitespace
                    const cleaned = String(v).replace(/[%¥￥,\s元]/g, "").trim();
                    if (!cleaned) continue;
                    const n = Number(cleaned);
                    if (Number.isFinite(n)) {
                      updates[k] = k === "progress" ? Math.max(0, Math.min(100, Math.round(n))) : String(n);
                    } else {
                      // Unparseable — delete to avoid corrupting the form
                      delete updates[k];
                    }
                  }

                  // --- Phase 2: Decide whether org creation should be skipped ---
                  // If the final client is an existing customer with their own org,
                  // that org takes priority — skip creating a new org to avoid orphan records.
                  const clientWillUseExistingOrg = clientEntity?.id && clientEntity.matched && !!clientEntity.organizationId;
                  const shouldCreateOrg = orgEntity?.shouldCreate && orgEntity.name.trim() && !clientWillUseExistingOrg;

                  // --- Phase 3: Execute org resolution/creation ---
                  if (orgEntity) {
                    updates.organization = orgEntity.name;
                    if (orgEntity.id && orgEntity.matched) {
                      newSelectedOrgId = orgEntity.id;
                    } else if (shouldCreateOrg) {
                      try {
                        const res = await fetch("/api/organizations/quick-create", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ canonicalName: orgEntity.name.trim() }),
                        });
                        if (res.ok) {
                          const data = await res.json();
                          newSelectedOrgId = data.organization.id;
                          updates.organization = data.organization.canonicalName;
                          if (!data.created) toast.info(`单位 "${data.organization.canonicalName}" 已存在，已自动关联`);
                        } else {
                          const err = await res.json().catch(() => ({}));
                          toast.error(err.error || "单位创建失败，请在表单中手动选择");
                        }
                      } catch {
                        toast.error("单位创建失败，请在表单中手动选择");
                      }
                    }
                  }

                  // --- Phase 4: Execute customer resolution/creation ---
                  if (clientEntity) {
                    updates.client = clientEntity.name;
                    if (clientEntity.id && clientEntity.matched) {
                      newProfileId = clientEntity.id;
                      // Existing customer's org takes priority over draft org
                      if (clientEntity.organizationId) {
                        newCustomerOrgId = clientEntity.organizationId;
                        newSelectedOrgId = clientEntity.organizationId;
                        if (clientEntity.organization) updates.organization = clientEntity.organization;
                      }
                    } else if (clientEntity.shouldCreate && clientEntity.name.trim()) {
                      try {
                        const res = await fetch("/api/customers", {
                          method: "POST",
                          headers: { "Content-Type": "application/json", "x-customer-api-caller": "projects-page" },
                          body: JSON.stringify({
                            name: clientEntity.name.trim(),
                          }),
                        });
                        if (res.ok) {
                          const data = await res.json();
                          newProfileId = data.customer.id;
                        } else {
                          const err = await res.json().catch(() => ({}));
                          toast.error(err.error || "客户创建失败，请在表单中手动选择");
                        }
                      } catch {
                        toast.error("客户创建失败，请在表单中手动选择");
                      }
                    }
                  }

                  if (orgTouched) setSelectedOrgId(newSelectedOrgId);
                  if (clientTouched) {
                    setCustomerOrgId(newCustomerOrgId);
                    updates.profileId = newProfileId;
                  } else if (orgTouched && !clientTouched) {
                    if (customerOrgId && customerOrgId !== newSelectedOrgId) {
                      setCustomerOrgId(null);
                      updates.profileId = "";
                    }
                  }
                  setForm((prev) => ({
                    ...prev,
                    ...updates,
                    status: (updates.status as string) || prev.status,
                  }));
                }}
              />

              <div className="space-y-2">
                <Label>项目名称</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="输入项目名称"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>项目描述</Label>
                <Textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="项目简介..."
                  rows={3}
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>项目号</Label>
                  <Input
                    value={form.projectNo}
                    onChange={(e) => setForm({ ...form, projectNo: e.target.value })}
                    placeholder="PRJ-YYYYMMDD-0001（留空自动生成）"
                  />
                </div>
                <div className="space-y-2">
                  <Label>单位</Label>
                  {isRepresentative ? (
                    <Input
                      value={form.organization}
                      onChange={(e) => setForm({ ...form, organization: e.target.value })}
                      placeholder="研究机构/公司"
                    />
                  ) : (
                    <OrganizationSelect
                      value={selectedOrgId}
                      displayValue={form.organization || undefined}
                      disabled={!!customerOrgId}
                      onChange={(id, name) => {
                        setSelectedOrgId(id || "");
                        setForm({ ...form, organization: name });
                      }}
                    />
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>客户</Label>
                  <CustomerSelect
                    value={form.profileId}
                    displayValue={form.client}
                    onChange={(id, name, org, orgId, customer) => {
                      setForm((prev) => ({
                        ...prev,
                        profileId: id || "",
                        client: name || "",
                        organization: orgId ? (org || "") : prev.organization,
                      }));
                      setCustomerOrgId(orgId || null);
                      if (orgId) setSelectedOrgId(orgId);
                      if (id && customer) {
                        setForm((prev) => ({
                          ...prev,
                          representativeId: customer.representativeId || "",
                          representative: customer.representativeName || "",
                        }));
                      }
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label>代表</Label>
                  {form.profileId ? (
                    <Input
                      value={form.representative || form.representativeId || "由客户 CRM 负责人同步"}
                      disabled
                    />
                  ) : (
                    <RepresentativeSelect
                      value={form.representativeId}
                      displayValue={form.representative}
                      onChange={(id, name) => setForm({ ...form, representativeId: id || "", representative: name })}
                    />
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>开始日期</Label>
                  <Input
                    type="date"
                    value={form.startDate}
                    onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>结束日期</Label>
                  <Input
                    type="date"
                    value={form.endDate}
                    onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>初始状态</Label>
                <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v || "NOT_STARTED" })}>
                  <SelectTrigger>
                    <span>{STATUS_CONFIG[form.status]?.label || "未开始"}</span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NOT_STARTED">未开始</SelectItem>
                    <SelectItem value="IN_PROGRESS">进行中</SelectItem>
                    <SelectItem value="COMPLETED">已完成</SelectItem>
                    <SelectItem value="ON_HOLD">暂停</SelectItem>
                    <SelectItem value="TERMINATED">终止</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>项目进度 ({form.progress}%)</Label>
                <Input
                  type="range"
                  min={0}
                  max={100}
                  value={form.progress}
                  onChange={(e) => setForm({ ...form, progress: Number(e.target.value) })}
                />
              </div>
                </div>
              </div>
              <div className="-mx-4 -mb-4 border-t bg-popover/95 px-4 py-3">
                <Button type="submit" className="w-full" disabled={createMutation.isPending}>
                  {createMutation.isPending ? "创建中..." : "创建项目"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      )}
    />

    {!isRepresentative && isMobile && (
      <Fab onClick={() => setOpen(true)} aria-label="新建项目">
        <Plus className="h-6 w-6" />
      </Fab>
    )}

    {/* ── 筛选栏：常驻行 + 更多筛选展开区 ── */}
    {isMobile ? (
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="搜索项目..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Sheet open={filterSheetOpen} onOpenChange={setFilterSheetOpen}>
          <SheetTrigger render={<Button variant="outline" size="icon" className="shrink-0"><Filter className="h-4 w-4" /></Button>} />
          <SheetContent side="bottom" className="h-[80vh] flex flex-col">
            <SheetHeader>
              <SheetTitle>筛选项目</SheetTitle>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto space-y-4 py-4">
              <div className="space-y-2">
                <Label className="text-muted-foreground">归档</Label>
                <Select value={archivedFilter} onValueChange={(v) => setArchivedFilter(v || "active")}>
                  <SelectTrigger>
                    <SelectDisplay label="归档" valueLabel={ARCHIVED_LABELS[archivedFilter]} placeholder="筛选" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">活跃</SelectItem>
                    <SelectItem value="archived">已归档</SelectItem>
                    {isAdmin && <SelectItem value="deleted">已删除</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-muted-foreground">时间</Label>
                <Select value={dateRange} onValueChange={(v) => setDateRange(v || "ALL")}>
                  <SelectTrigger>
                    <SelectDisplay label="时间" valueLabel={DATE_LABELS[dateRange]} placeholder="时间" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">全部时间</SelectItem>
                    <SelectItem value="7d">最近7天</SelectItem>
                    <SelectItem value="30d">最近30天</SelectItem>
                    <SelectItem value="90d">最近90天</SelectItem>
                    <SelectItem value="1y">最近一年</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-muted-foreground">代表</Label>
                <Select value={repFilter} onValueChange={(v) => setRepFilter(v || "ALL")} disabled={repOptions.length === 0}>
                  <SelectTrigger>
                    <SelectDisplay label="代表" valueLabel={repFilter === "ALL" ? "全部代表" : repLabelMap.get(repFilter) || "未知"} placeholder="代表" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">全部代表</SelectItem>
                    {repOptions.map((r) => (
                      <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-muted-foreground">客户</Label>
                <Select value={custFilter} onValueChange={(v) => setCustFilter(v || "ALL")} disabled={custOptions.length === 0}>
                  <SelectTrigger>
                    <SelectDisplay label="客户" valueLabel={custFilter === "ALL" ? "全部客户" : custLabelMap.get(custFilter) || "未知"} placeholder="客户" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">全部客户</SelectItem>
                    {custOptions.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-muted-foreground">排序</Label>
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <Select value={sortKey} onValueChange={(v) => setSortKey(v || "")}>
                      <SelectTrigger>
                        <SelectDisplay label="排序" valueLabel={SORT_OPTIONS.find((o) => o.value === sortKey)?.label} placeholder="排序" />
                      </SelectTrigger>
                      <SelectContent>
                        {SORT_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button variant="outline" size="sm" className="h-9 px-2 shrink-0" onClick={() => setSortDir((prev) => (prev === "asc" ? "desc" : "asc"))} disabled={!sortKey}>
                    {sortDir === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </div>
            </div>
            <div className="flex gap-2 pt-2 border-t">
              <Button variant="outline" className="flex-1" onClick={clearAllFilters}>
                清除
              </Button>
            <SheetClose render={<Button className="flex-1">完成</Button>} />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    ) : (
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="搜索项目..."
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex gap-2 flex-wrap">
            <Select value={archivedFilter} onValueChange={(v) => setArchivedFilter(v || "active")}>
              <SelectTrigger className="w-[110px]">
                <SelectDisplay label="归档" valueLabel={ARCHIVED_LABELS[archivedFilter]} placeholder="筛选" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">活跃</SelectItem>
                <SelectItem value="archived">已归档</SelectItem>
                {isAdmin && <SelectItem value="deleted">已删除</SelectItem>}
              </SelectContent>
            </Select>
            <Select value={sortKey} onValueChange={(v) => setSortKey(v || "")}>
              <SelectTrigger className="w-[120px]">
                <SelectDisplay label="排序" valueLabel={SORT_OPTIONS.find((o) => o.value === sortKey)?.label} placeholder="排序" />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="h-9 px-2"
              onClick={() => setSortDir((prev) => (prev === "asc" ? "desc" : "asc"))}
              disabled={!sortKey}
            >
              {sortDir === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={() => setShowMoreFilters((v) => !v)}
            >
              <SlidersHorizontal className="mr-1 h-4 w-4" />
              更多筛选{moreFilterCount > 0 ? ` (${moreFilterCount})` : ""}
            </Button>
            {!isRepresentative && (
              <Button variant="outline" size="sm" onClick={exportFeishu}>
                <ClipboardCopy className="mr-1 h-4 w-4" />
                导出飞书
              </Button>
            )}
          </div>
        </div>

        {showMoreFilters && (
          <div className="flex gap-2 flex-wrap rounded-lg border bg-muted/20 p-3">
            <Select value={dateRange} onValueChange={(v) => setDateRange(v || "ALL")}>
              <SelectTrigger className="w-[130px]">
                <SelectDisplay label="时间" valueLabel={DATE_LABELS[dateRange]} placeholder="时间" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">全部时间</SelectItem>
                <SelectItem value="7d">最近7天</SelectItem>
                <SelectItem value="30d">最近30天</SelectItem>
                <SelectItem value="90d">最近90天</SelectItem>
                <SelectItem value="1y">最近一年</SelectItem>
              </SelectContent>
            </Select>
            <Select value={repFilter} onValueChange={(v) => setRepFilter(v || "ALL")} disabled={repOptions.length === 0}>
              <SelectTrigger className="w-[130px]">
                <SelectDisplay label="代表" valueLabel={repFilter === "ALL" ? "全部代表" : repLabelMap.get(repFilter) || "未知"} placeholder="代表" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">全部代表</SelectItem>
                {repOptions.map((r) => (
                  <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={custFilter} onValueChange={(v) => setCustFilter(v || "ALL")} disabled={custOptions.length === 0}>
              <SelectTrigger className="w-[130px]">
                <SelectDisplay label="客户" valueLabel={custFilter === "ALL" ? "全部客户" : custLabelMap.get(custFilter) || "未知"} placeholder="客户" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">全部客户</SelectItem>
                {custOptions.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {moreFilterCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9"
                onClick={() => { setDateRange("ALL"); setRepFilter("ALL"); setCustFilter("ALL"); }}
              >
                清除
              </Button>
            )}
          </div>
        )}
      </div>
    )}

      {/* 状态 chip 组（带计数，随筛选刷新） */}
      <StatusChips items={statusChipItems} activeKey={statusFilter} onSelect={(k) => setStatusFilter(k)} />

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center space-y-3">
          {hasAnyFilter ? (
            <>
              <p className="text-muted-foreground">当前筛选无结果</p>
              <Button variant="outline" size="sm" onClick={clearAllFilters}>
                清除筛选
              </Button>
            </>
          ) : (
            <p className="text-muted-foreground">
              {isRepresentative ? "暂无项目" : "暂无项目，点击右上角创建"}
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} onClick={(proj) => router.push(`/projects/${proj.id}`)} />
            ))}
          </div>
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={listData?.total ?? 0}
            totalPages={listData?.totalPages ?? 1}
            onPageChange={(p) => setPage(p)}
            showPageJumper
          />
        </>
      )}
    </PageShell>
  );
}
