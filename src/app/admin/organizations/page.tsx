"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Search, Plus, Pencil, Archive, ArchiveRestore, Trash2, Merge,
  Building2, Tag, MapPin, X, Users, BarChart3, UserCog, Link2, Sparkles,
  FileText, ShieldAlert, ClipboardList,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { OrganizationAiFillPlugin, type OrganizationDraftPreview } from "@/components/organization-ai-fill-plugin";
import { OrganizationAdminSelect } from "@/components/organization-admin-select";
import { TaxIdLookupInput } from "@/components/tax-id-lookup-input";
import { SiteMapPicker } from "@/components/site-map-picker";
import { CRM_SITE_TYPES, SITE_TYPE_LABELS } from "@/lib/crm/constants";
import { normalizeOrganizationLookupText, organizationLookupIncludes } from "@/lib/organization-normalize";
import Link from "next/link";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable } from "@/components/ui/data-table";
import type { DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";

interface OrgAlias {
  id: string;
  alias: string;
  aliasType: string;
}

interface OrgSite {
  id: string;
  siteName: string;
  siteType: string;
  address: string | null;
  lat?: number | null;
  lng?: number | null;
}

interface SiteForm {
  siteName: string;
  address: string;
  siteType: string;
}

// Task 1.12 — one suggestion row per site-less profile (from suggest-site API)
interface SiteSuggestRow {
  profileId: string;
  customerName: string;
  suggestedSiteId: string | null;
  suggestedSiteName: string | null;
  confidence: "HIGH" | "LOW" | null;
  matchedSignals: string[];
}

interface OrgItem {
  id: string;
  orgCode: string;
  canonicalName: string;
  address: string | null;
  taxId: string | null;
  isInvoiceSubject: boolean;
  invoiceAddress: string | null;
  invoicePhone: string | null;
  invoiceBankName: string | null;
  invoiceBankAccount: string | null;
  archived: boolean;
  aliases: OrgAlias[];
  sites: OrgSite[];
  _count: { customers: number };
}

interface ActiveBindingItem {
  bindingId: string;
  representativeId: string;
  name: string;
  email: string;
  organizationSiteId: string | null;
  organizationSiteName: string | null;
  isPrimary: boolean;
}

// 一致性巡检结果（需求 2 修复点 C）—— 与 GET /api/organizations/consistency-scan 对齐
interface ConsistencyScanResult {
  archivedOrgsWithCustomers: Array<{
    id: string;
    canonicalName: string;
    orgCode: string;
    _count: { customers: number };
  }>;
  customersPointingToDeletedOrgs: Array<{
    id: string;
    name: string;
    customerCode: string | null;
    organizationId: string | null;
    organization: string | null;
  }>;
  customersPointingToArchivedOrgs: Array<{
    id: string;
    name: string;
    customerCode: string | null;
    organizationId: string | null;
    organization: string | null;
    org: { canonicalName: string; orgCode: string } | null;
  }>;
  profilesWithMissingOrganizationSnapshot?: Array<{
    profileId: string;
    name: string | null;
    snapshotName: string | null;
    canonicalName: string;
  }>;
  profilesWithMismatchedOrganizationSnapshot?: Array<{
    profileId: string;
    name: string | null;
    snapshotName: string | null;
    canonicalName: string;
  }>;
  profilesWithInvalidSiteBinding?: Array<{
    profileId: string;
    name: string | null;
    canonicalName: string;
    organizationSiteId: string | null;
  }>;
  organizationsWithInvisibleCharacters?: Array<{
    id: string;
    orgCode: string;
    canonicalName: string;
    invisibleCodePoints: string[];
  }>;
  aliasesWithInvisibleCharacters?: Array<{
    id: string;
    organizationId: string;
    alias: string;
    invisibleCodePoints: string[];
  }>;
  sitesWithInvisibleCharacters?: Array<{
    id: string;
    organizationId: string;
    siteName: string;
    invisibleCodePoints: string[];
  }>;
  counts: {
    archivedOrgsWithCustomers: number;
    customersPointingToDeletedOrgs: number;
    customersPointingToArchivedOrgs: number;
    profilesWithMissingOrganizationSnapshot?: number;
    profilesWithMismatchedOrganizationSnapshot?: number;
    profilesWithInvalidSiteBinding?: number;
    organizationsWithInvisibleCharacters?: number;
    aliasesWithInvisibleCharacters?: number;
    sitesWithInvisibleCharacters?: number;
  };
}

const emptyCreate = { canonicalName: "", address: "", taxId: "", aliases: [""], sites: [{ siteName: "", address: "", siteType: "CAMPUS" }] };

export default function OrganizationsPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data: session, status } = useSession();
  const { confirm } = useConfirm();
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [editing, setEditing] = useState<OrgItem | null>(null);
  const [mergeSource, setMergeSource] = useState<OrgItem | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState("");
  // Site merge (Task 1.6) — merge two sites under the SAME org
  const [siteMergeOpen, setSiteMergeOpen] = useState(false);
  const [siteMergeOrgId, setSiteMergeOrgId] = useState<string | null>(null);
  const [siteMergeSource, setSiteMergeSource] = useState<OrgSite | null>(null);
  const [siteMergeTargetId, setSiteMergeTargetId] = useState("");
  const [siteMergePreserveHierarchy, setSiteMergePreserveHierarchy] = useState(true);
  const [siteMergeReason, setSiteMergeReason] = useState("");
  const [siteMergePreview, setSiteMergePreview] = useState<{ migratedCustomers: number; archivedBindings: number } | null>(null);
  // Customer → site drill-down (Task 1.12) — suggest + batch-assign site for org-level customers
  const [drillOpen, setDrillOpen] = useState(false);
  const [drillOrg, setDrillOrg] = useState<OrgItem | null>(null);
  const [drillRowSite, setDrillRowSite] = useState<Record<string, string>>({}); // profileId -> manually chosen siteId
  // Site map picker (Task 1.13) — pick lat/lng for an existing site
  const [mapPickerOpen, setMapPickerOpen] = useState(false);
  const [mapPickerSite, setMapPickerSite] = useState<OrgSite | null>(null);
  const [form, setForm] = useState({ ...emptyCreate });
  const [editForm, setEditForm] = useState({ canonicalName: "", address: "", taxId: "", isInvoiceSubject: false, invoiceAddress: "", invoicePhone: "", invoiceBankName: "", invoiceBankAccount: "" });
  const [newAliases, setNewAliases] = useState<string[]>([""]);
  const [newSites, setNewSites] = useState<SiteForm[]>([{ siteName: "", address: "", siteType: "CAMPUS" }]);
  const [assignFilter, setAssignFilter] = useState<"all" | "assigned" | "unassigned">("all");
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [assignTargetOrg, setAssignTargetOrg] = useState<OrgItem | null>(null);
  const [selectedRepId, setSelectedRepId] = useState<string>("");
  const [selectedAssignSiteId, setSelectedAssignSiteId] = useState<string>("__org__");
  const [editingBindingSite, setEditingBindingSite] = useState<Record<string, string>>({});
  const [actingBindingId, setActingBindingId] = useState<string | null>(null);
  // 一致性巡检（需求 2 修复点 C）—— 按需触发的只读巡检
  const [consistencyResult, setConsistencyResult] = useState<ConsistencyScanResult | null>(null);
  const [consistencyOpen, setConsistencyOpen] = useState(false);

  const { data, isLoading, error } = useQuery<{ organizations: OrgItem[] }>({
    queryKey: ["organizations"],
    queryFn: async () => {
      const res = await fetch("/api/organizations");
      if (res.status === 403) throw new Error("无权访问");
      if (!res.ok) throw new Error("加载失败");
      return res.json();
    },
    enabled: status === "authenticated" && session?.user?.role === "ADMIN",
  });

  const { data: bindingsData } = useQuery<{ bindings: Array<{
    id: string;
    status: string;
    organizationId: string | null;
    organizationSiteId: string | null;
    isPrimary?: boolean;
    organizationSite?: { id: string; siteName: string; siteType: string } | null;
    representative: { id: string; name: string; email: string } | null;
  }> }>({
    queryKey: ["representative-organizations", "all"],
    queryFn: async () => {
      const res = await fetch("/api/crm/representative-organizations");
      if (!res.ok) return { bindings: [] };
      return res.json();
    },
    enabled: status === "authenticated" && session?.user?.role === "ADMIN",
  });

  const { data: repsData } = useQuery<{ representatives: Array<{ id: string; name: string; email: string }> }>({
    queryKey: ["representatives-list"],
    queryFn: async () => {
      const res = await fetch("/api/representatives/list");
      if (!res.ok) return { representatives: [] };
      return res.json();
    },
    enabled: assignDialogOpen && status === "authenticated",
  });

  const assignRepMutation = useMutation({
    mutationFn: async ({ orgId, repId, siteId }: { orgId: string; repId: string; siteId: string | null }) => {
      const res = await fetch("/api/crm/representative-organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          representativeId: repId,
          organizationId: orgId,
          organizationSiteId: siteId,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "分配失败");
      return json;
    },
    onSuccess: () => {
      toast.success("代表已分配");
      setAssignDialogOpen(false);
      setAssignTargetOrg(null);
      setSelectedRepId("");
      setSelectedAssignSiteId("__org__");
      setEditingBindingSite({});
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      queryClient.invalidateQueries({ queryKey: ["representative-organizations", "all"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const bindingActionMutation = useMutation({
    mutationFn: async ({
      bindingId,
      action,
      siteId,
    }: {
      bindingId: string;
      action: "archive" | "change-scope";
      siteId?: string | null;
    }) => {
      setActingBindingId(bindingId);
      const res = await fetch(`/api/crm/representative-organizations/${bindingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          organizationSiteId: siteId,
          reviewNote: action === "archive" ? "admin_cancel_assignment" : "admin_change_assignment_scope",
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "操作失败");
      return { ...json, action };
    },
    onSuccess: (data) => {
      setActingBindingId(null);
      if (data.action === "archive") {
        toast.success("已取消分配");
      } else {
        const count = typeof data.autoAssigned === "number" ? data.autoAssigned : 0;
        toast.success(count > 0 ? `已修改分配范围，并自动分配 ${count} 个客户` : "已修改分配范围");
      }
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      queryClient.invalidateQueries({ queryKey: ["representative-organizations", "all"] });
    },
    onError: (err: Error) => {
      setActingBindingId(null);
      toast.error(err.message);
    },
  });

  useEffect(() => {
    if (status === "authenticated" && session?.user?.role !== "ADMIN") {
      router.push("/dashboard");
    }
    if (error?.message === "无权访问") {
      router.push("/dashboard");
    }
  }, [status, session, error, router]);

  // 一致性巡检（需求 2 修复点 C）—— 只读扫描历史脏数据，不做任何写
  const consistencyMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/organizations/consistency-scan");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "巡检失败");
      return data as ConsistencyScanResult;
    },
    onSuccess: (data) => {
      setConsistencyResult(data);
      setConsistencyOpen(true);
      const total =
        data.counts.archivedOrgsWithCustomers +
        data.counts.customersPointingToDeletedOrgs +
        data.counts.customersPointingToArchivedOrgs +
        (data.counts.profilesWithMissingOrganizationSnapshot ?? 0) +
        (data.counts.profilesWithMismatchedOrganizationSnapshot ?? 0) +
        (data.counts.profilesWithInvalidSiteBinding ?? 0) +
        (data.counts.organizationsWithInvisibleCharacters ?? 0) +
        (data.counts.aliasesWithInvisibleCharacters ?? 0) +
        (data.counts.sitesWithInvisibleCharacters ?? 0);
      if (total === 0) toast.success("一致性巡检通过，未发现异常");
      else toast.warning(`巡检发现 ${total} 处需关注的数据`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const createMutation = useMutation({
    mutationFn: async (payload: typeof emptyCreate) => {
      const res = await fetch("/api/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          canonicalName: payload.canonicalName,
          address: payload.address || null,
          taxId: payload.taxId || null,
          aliases: payload.aliases.filter(Boolean),
          sites: (payload.sites as SiteForm[]).filter((s) => s.siteName).map((s) => ({ siteName: s.siteName, address: s.address, siteType: s.siteType || "CAMPUS" })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "创建失败");
      return data;
    },
    onSuccess: () => {
      toast.success("机构创建成功");
      setCreateOpen(false);
      setForm({ ...emptyCreate });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown> & { id: string }) => {
      const { id, ...body } = payload;
      const res = await fetch(`/api/organizations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "更新失败");
      return data;
    },
    onSuccess: () => {
      toast.success("已更新");
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/organizations/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "删除失败");
      return data;
    },
    onSuccess: () => {
      toast.success("机构已删除");
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const mergeMutation = useMutation({
    mutationFn: async ({ sourceId, targetId }: { sourceId: string; targetId: string }) => {
      const res = await fetch(`/api/organizations/${sourceId}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "合并失败");
      return data;
    },
    onSuccess: () => {
      toast.success("机构已合并");
      setMergeOpen(false);
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const siteMergeMutation = useMutation({
    mutationFn: async ({ orgId, sourceSiteId, targetSiteId, preserveHierarchy, reason, dryRun }: {
      orgId: string; sourceSiteId: string; targetSiteId: string;
      preserveHierarchy: boolean; reason: string; dryRun: boolean;
    }) => {
      const res = await fetch(`/api/organizations/${orgId}/sites/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceSiteId, targetSiteId, preserveHierarchy, reason: reason || undefined, dryRun }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "合并院区失败");
      return data;
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Task 1.12 — load per-customer site suggestions for the drill-down dialog
  const { data: drillData, isLoading: drillLoading, refetch: refetchDrill } = useQuery<{ suggestions: SiteSuggestRow[] }>({
    queryKey: ["org-customer-site-suggest", drillOrg?.id],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${drillOrg!.id}/customers/suggest-site`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error("加载客户下钻建议失败");
      return res.json();
    },
    enabled: drillOpen && !!drillOrg,
  });

  // Task 1.12 — apply suggestions in batches (one group per target site); reused by
  // "全部确认高置信度" and per-row "挂载".
  const drillAssignMutation = useMutation({
    mutationFn: async (groups: { profileIds: string[]; organizationSiteId: string }[]) => {
      let updated = 0;
      for (const g of groups) {
        const res = await fetch("/api/crm/profiles/batch-assign-site", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(g),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "挂院区失败");
        updated += typeof data.updated === "number" ? data.updated : 0;
      }
      return { updated };
    },
    onSuccess: (data) => {
      toast.success(`已挂院区（${data.updated} 个客户）`);
      setDrillRowSite({});
      refetchDrill();
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const orgs = data?.organizations || [];
  const bindings = bindingsData?.bindings || [];
  const bindingMap = new Map<string, ActiveBindingItem[]>();
  const bindingStatusMap = new Map<string, Set<string>>();
  for (const b of bindings) {
    if (b.organizationId) {
      const statuses = bindingStatusMap.get(b.organizationId) || new Set<string>();
      statuses.add(b.status);
      bindingStatusMap.set(b.organizationId, statuses);
    }
    if (b.organizationId && b.status === "ACTIVE" && b.representative) {
      const list = bindingMap.get(b.organizationId) || [];
      list.push({
        bindingId: b.id,
        representativeId: b.representative.id,
        name: b.representative.name,
        email: b.representative.email,
        organizationSiteId: b.organizationSiteId || null,
        organizationSiteName: b.organizationSite?.siteName || null,
        isPrimary: !!b.isPrimary,
      });
      bindingMap.set(b.organizationId, list);
    }
  }

  const normalizedSearch = useMemo(() => normalizeOrganizationLookupText(search), [search]);

  const filtered = orgs
    .filter((o) => {
      if (!normalizedSearch) return true;
      return (
        organizationLookupIncludes(o.canonicalName, normalizedSearch) ||
        organizationLookupIncludes(o.orgCode, normalizedSearch) ||
        o.aliases.some((a) => organizationLookupIncludes(a.alias, normalizedSearch))
      );
    })
    .filter((o) => {
      if (assignFilter === "all") return true;
      const hasActiveBinding = bindingMap.has(o.id);
      return assignFilter === "assigned" ? hasActiveBinding : !hasActiveBinding;
    });
  const assignActiveBindings = assignTargetOrg ? bindingMap.get(assignTargetOrg.id) || [] : [];

  const drillColumns = useMemo<DataTableColumn<SiteSuggestRow>[]>(
    () => [
      { key: "customerName", header: "客户名" },
      {
        key: "suggestedSiteName",
        header: "建议院区",
        render: (r) => r.suggestedSiteName || "—",
      },
      {
        key: "confidence",
        header: "置信度",
        render: (r) =>
          r.confidence === "HIGH" ? (
            <Badge className="bg-success-bg text-success border-success-border">高</Badge>
          ) : r.confidence === "LOW" ? (
            <Badge variant="outline" className="text-warning border-warning-border">低</Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">无</Badge>
          ),
      },
      {
        key: "matchedSignals",
        header: "匹配信号",
        className: "text-xs text-muted-foreground",
        render: (r) => (r.matchedSignals.length > 0 ? r.matchedSignals.join("、") : "—"),
      },
      {
        key: "actions",
        header: "操作",
        render: (r) => {
          const chosen = drillRowSite[r.profileId] ?? (r.confidence === "HIGH" ? (r.suggestedSiteId ?? "") : "");
          return (
            <div className="flex items-center gap-2">
              <Select
                value={chosen}
                onValueChange={(v) => setDrillRowSite((prev) => ({ ...prev, [r.profileId]: v ?? "" }))}
              >
                <SelectTrigger className="h-8 w-40"><SelectValue placeholder="选择院区..." /></SelectTrigger>
                <SelectContent>
                  {(drillOrg?.sites || []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.siteName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                disabled={!chosen || drillAssignMutation.isPending}
                onClick={() => {
                  if (chosen) {
                    drillAssignMutation.mutate([{ profileIds: [r.profileId], organizationSiteId: chosen }]);
                  }
                }}
              >
                挂载
              </Button>
            </div>
          );
        },
      },
    ],
    [drillRowSite, drillOrg?.sites, drillAssignMutation]
  );

  function openCreateDialog(initialName = "") {
    setForm({
      canonicalName: initialName,
      address: "",
      taxId: "",
      aliases: [""],
      sites: [{ siteName: "", address: "", siteType: "CAMPUS" }],
    });
    setCreateOpen(true);
  }

  function applyDraftToCreateForm(draft: OrganizationDraftPreview) {
    setForm({
      canonicalName: draft.canonicalName,
      address: draft.address || "",
      taxId: "",
      aliases: draft.aliases.length > 0 ? draft.aliases : [""],
      sites: draft.sites.length > 0
        ? draft.sites.map((site) => ({ siteName: site.siteName, address: site.address || "", siteType: "CAMPUS" }))
        : [{ siteName: "", address: "", siteType: "CAMPUS" }],
    });
    toast.success("已应用 AI 草稿，请检查后再保存");
  }

  function applyDraftToEditSupplement(draft: OrganizationDraftPreview) {
    if (!editing) return;

    const normalizedAliases = new Set(editing.aliases.map((a) => a.alias.trim().toLowerCase()));
    const aliasesToAdd = draft.aliases
      .map((alias) => alias.trim())
      .filter((alias) => alias && !normalizedAliases.has(alias.toLowerCase()));

    const normalizedSites = new Set(editing.sites.map((site) => site.siteName.trim().toLowerCase()));
    const sitesToAdd = draft.sites
      .map((site) => ({
        siteName: site.siteName.trim(),
        address: site.address?.trim() || "",
        siteType: "CAMPUS",
      }))
      .filter((site) => site.siteName && !normalizedSites.has(site.siteName.toLowerCase()));

    const addressToApply = !editForm.address.trim() && draft.address?.trim() ? draft.address.trim() : undefined;
    if (!addressToApply && aliasesToAdd.length === 0 && sitesToAdd.length === 0) {
      toast.info("AI 草稿没有发现可新增的信息");
      return;
    }

    if (addressToApply) {
      setEditForm((prev) => ({ ...prev, address: addressToApply }));
    }
    if (aliasesToAdd.length > 0) {
      setNewAliases((prev) => [...prev.filter((alias) => alias.trim()), ...aliasesToAdd]);
    }
    if (sitesToAdd.length > 0) {
      setNewSites((prev) => [...prev.filter((site) => site.siteName.trim()), ...sitesToAdd]);
    }
    toast.success("AI 内容已填入撰写区，请检查后再保存");
  }

  if (status === "loading") return null;
  if (!session || session.user.role !== "ADMIN") return null;
  if (error?.message === "无权访问") return null;

  return (
    <PageShell>
      <PageHeader
        title="单位主数据管理"
        description="管理机构标准名称、别名和院区/校区"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" render={<Link href="/admin/customer-org-bindings" />}>
              <ClipboardList className="mr-1.5 h-4 w-4" />无机构客户治理
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => consistencyMutation.mutate()}
              disabled={consistencyMutation.isPending}
            >
              <ShieldAlert className="mr-1.5 h-4 w-4" />
              {consistencyMutation.isPending ? "巡检中..." : "一致性巡检"}
            </Button>
          </div>
        }
      />

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="搜索机构..." className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={assignFilter} onValueChange={(v) => setAssignFilter(v as "all" | "assigned" | "unassigned")}>
          <SelectTrigger className="w-36">
            <SelectValue>
              {assignFilter === "assigned" ? "已分配代表" : assignFilter === "unassigned" ? "未分配代表" : "全部单位"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部单位</SelectItem>
            <SelectItem value="assigned">已分配代表</SelectItem>
            <SelectItem value="unassigned">未分配代表</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={() => openCreateDialog()}>
          <Plus className="mr-2 h-4 w-4" />新增机构
        </Button>
      </div>

      {consistencyOpen && consistencyResult && (() => {
        const c = consistencyResult;
        const total =
          c.counts.archivedOrgsWithCustomers +
          c.counts.customersPointingToDeletedOrgs +
          c.counts.customersPointingToArchivedOrgs +
          (c.counts.profilesWithMissingOrganizationSnapshot ?? 0) +
          (c.counts.profilesWithMismatchedOrganizationSnapshot ?? 0) +
          (c.counts.profilesWithInvalidSiteBinding ?? 0) +
          (c.counts.organizationsWithInvisibleCharacters ?? 0) +
          (c.counts.aliasesWithInvisibleCharacters ?? 0) +
          (c.counts.sitesWithInvisibleCharacters ?? 0);
        const clean = total === 0;
        return (
          <div className={`rounded-lg border p-4 ${clean ? "border-success-border bg-success-bg" : "border-warning-border bg-warning-bg"}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <ShieldAlert className={`h-4 w-4 ${clean ? "text-success" : "text-warning"}`} />
                <span className={`text-sm font-medium ${clean ? "text-success" : "text-warning"}`}>
                  {clean ? "一致性巡检通过，未发现历史残留脏数据" : `一致性巡检发现 ${total} 处需关注的数据`}
                </span>
              </div>
              <button className="text-muted-foreground hover:text-foreground" onClick={() => setConsistencyOpen(false)}>
                <X className="h-4 w-4" />
              </button>
            </div>
            {!clean && (
              <div className="mt-3 space-y-3 text-sm">
                {c.archivedOrgsWithCustomers.length > 0 && (
                  <div>
                    <div className="text-xs font-medium text-warning mb-1">
                      已归档但仍挂客户的机构（{c.archivedOrgsWithCustomers.length}）
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {c.archivedOrgsWithCustomers.map((o) => (
                        <Link
                          key={o.id}
                          href={`/admin/organizations/${o.id}`}
                          className="inline-flex items-center gap-1 rounded-md border border-warning-border bg-background px-2 py-1 text-xs text-warning hover:bg-warning-bg"
                        >
                          {o.canonicalName}
                          <span className="text-muted-foreground">· {o._count.customers} 客户</span>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
                {c.customersPointingToArchivedOrgs.length > 0 && (
                  <div>
                    <div className="text-xs font-medium text-warning mb-1">
                      指向已归档机构的客户（{c.customersPointingToArchivedOrgs.length}）
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {c.customersPointingToArchivedOrgs.map((cu) => (
                        <Link
                          key={cu.id}
                          href={`/crm/customers/${cu.id}`}
                          className="inline-flex items-center gap-1 rounded-md border border-warning-border bg-background px-2 py-1 text-xs text-warning hover:bg-warning-bg"
                        >
                          {cu.name}
                          {cu.org?.canonicalName && <span className="text-muted-foreground">→ {cu.org.canonicalName}</span>}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
                {c.customersPointingToDeletedOrgs.length > 0 && (
                  <div>
                    <div className="text-xs font-medium text-danger mb-1">
                      指向已删除机构的客户（{c.customersPointingToDeletedOrgs.length}，异常残留）
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {c.customersPointingToDeletedOrgs.map((cu) => (
                        <Link
                          key={cu.id}
                          href={`/crm/customers/${cu.id}`}
                          className="inline-flex items-center gap-1 rounded-md border border-danger-border bg-background px-2 py-1 text-xs text-danger hover:bg-danger-bg"
                        >
                          {cu.name}
                          {cu.organization && <span className="text-muted-foreground">· {cu.organization}</span>}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
                {(c.counts.profilesWithMissingOrganizationSnapshot ?? 0) > 0 && (
                  <div>
                    <div className="text-xs font-medium text-warning mb-1">
                      有 FK 但机构名称快照为空（{c.counts.profilesWithMissingOrganizationSnapshot}）
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(c.profilesWithMissingOrganizationSnapshot ?? []).map((p) => (
                        <Link
                          key={p.profileId}
                          href={`/crm/customers/${p.profileId}`}
                          className="inline-flex items-center gap-1 rounded-md border border-warning-border bg-background px-2 py-1 text-xs text-warning hover:bg-warning-bg"
                        >
                          {p.name || p.profileId}
                          <span className="text-muted-foreground">→ {p.canonicalName}</span>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
                {(c.counts.profilesWithMismatchedOrganizationSnapshot ?? 0) > 0 && (
                  <div>
                    <div className="text-xs font-medium text-warning mb-1">
                      机构名称快照与 canonical 不一致（{c.counts.profilesWithMismatchedOrganizationSnapshot}）
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(c.profilesWithMismatchedOrganizationSnapshot ?? []).map((p) => (
                        <Link
                          key={p.profileId}
                          href={`/crm/customers/${p.profileId}`}
                          className="inline-flex items-center gap-1 rounded-md border border-warning-border bg-background px-2 py-1 text-xs text-warning hover:bg-warning-bg"
                        >
                          {p.name || p.profileId}
                          <span className="text-muted-foreground">「{p.snapshotName}」→ {p.canonicalName}</span>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
                {(c.counts.profilesWithInvalidSiteBinding ?? 0) > 0 && (
                  <div>
                    <div className="text-xs font-medium text-warning mb-1">
                      院区归属无效（{c.counts.profilesWithInvalidSiteBinding}）
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(c.profilesWithInvalidSiteBinding ?? []).map((p) => (
                        <Link
                          key={p.profileId}
                          href={`/crm/customers/${p.profileId}`}
                          className="inline-flex items-center gap-1 rounded-md border border-warning-border bg-background px-2 py-1 text-xs text-warning hover:bg-warning-bg"
                        >
                          {p.name || p.profileId}
                          <span className="text-muted-foreground">· {p.canonicalName}</span>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
                {(c.counts.organizationsWithInvisibleCharacters ?? 0) > 0 && (
                  <div>
                    <div className="text-xs font-medium text-warning mb-1">
                      机构名含不可见字符（{c.counts.organizationsWithInvisibleCharacters}）
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(c.organizationsWithInvisibleCharacters ?? []).map((o) => (
                        <Link
                          key={o.id}
                          href={`/admin/organizations/${o.id}`}
                          className="inline-flex items-center gap-1 rounded-md border border-warning-border bg-background px-2 py-1 text-xs text-warning hover:bg-warning-bg"
                        >
                          {o.canonicalName}
                          <span className="text-muted-foreground font-mono">{o.invisibleCodePoints.join(" ")}</span>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
                {(c.counts.aliasesWithInvisibleCharacters ?? 0) > 0 && (
                  <div>
                    <div className="text-xs font-medium text-warning mb-1">
                      别名含不可见字符（{c.counts.aliasesWithInvisibleCharacters}）
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(c.aliasesWithInvisibleCharacters ?? []).map((a) => (
                        <Link
                          key={a.id}
                          href={`/admin/organizations/${a.organizationId}`}
                          className="inline-flex items-center gap-1 rounded-md border border-warning-border bg-background px-2 py-1 text-xs text-warning hover:bg-warning-bg"
                        >
                          {a.alias}
                          <span className="text-muted-foreground font-mono">{a.invisibleCodePoints.join(" ")}</span>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
                {(c.counts.sitesWithInvisibleCharacters ?? 0) > 0 && (
                  <div>
                    <div className="text-xs font-medium text-warning mb-1">
                      院区名含不可见字符（{c.counts.sitesWithInvisibleCharacters}）
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(c.sitesWithInvisibleCharacters ?? []).map((s) => (
                        <Link
                          key={s.id}
                          href={`/admin/organizations/${s.organizationId}`}
                          className="inline-flex items-center gap-1 rounded-md border border-warning-border bg-background px-2 py-1 text-xs text-warning hover:bg-warning-bg"
                        >
                          {s.siteName}
                          <span className="text-muted-foreground font-mono">{s.invisibleCodePoints.join(" ")}</span>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {isLoading ? (
        <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20" />)}</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={search ? "未找到匹配的机构" : "暂无机构数据"}
          action={
            search ? (
              <Button variant="outline" size="sm" onClick={() => openCreateDialog(search.trim())}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                手工新增机构
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {filtered.map((o) => (
            <div key={o.id} className={`rounded-lg border bg-card p-4 ${o.archived ? "opacity-60" : ""}`}>
              {(() => {
                const activeBindings = bindingMap.get(o.id) || [];
                const statuses = bindingStatusMap.get(o.id) || new Set<string>();
                const hasPendingBinding = statuses.has("PENDING");
                const hasHistoricalBinding = statuses.has("REJECTED") || statuses.has("ARCHIVED");

                return (
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{o.canonicalName}</span>
                    <span className="text-xs text-muted-foreground font-mono">{o.orgCode}</span>
                    {o.archived && <Badge variant="outline" className="text-xs"><Archive className="h-3 w-3 mr-1" />已归档</Badge>}
                    <Badge variant="secondary" className="text-xs">{o._count.customers} 客户</Badge>
                    {o.taxId && <span className="text-xs text-muted-foreground">税号: {o.taxId}</span>}
                    {o.isInvoiceSubject ? (
                      <Badge className="text-xs bg-success-bg text-success hover:bg-success-bg">开票主体</Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs text-warning border-warning-border">待验真</Badge>
                    )}
                    {activeBindings.length > 0 ? (
                      activeBindings.map((r) => (
                        <Badge key={r.bindingId} variant="default" className="text-xs bg-info text-primary-foreground hover:bg-info/90">
                          <UserCog className="h-3 w-3 mr-1" />
                          {r.name}
                          {r.organizationSiteName ? ` · ${r.organizationSiteName}` : " · 全机构"}
                          {r.isPrimary ? " · 主代表" : ""}
                        </Badge>
                      ))
                    ) : hasPendingBinding ? (
                      <Badge variant="outline" className="text-xs text-info border-info-border">
                        <Link2 className="h-3 w-3 mr-1" />待审核绑定
                      </Badge>
                    ) : hasHistoricalBinding ? (
                      <Badge variant="outline" className="text-xs text-muted-foreground">
                        <Link2 className="h-3 w-3 mr-1" />当前无生效代表
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs text-warning border-warning-border">
                        <Link2 className="h-3 w-3 mr-1" />未分配代表
                      </Badge>
                    )}
                    <Link href={`/crm/customers?organizationId=${o.id}&organizationName=${encodeURIComponent(o.canonicalName)}`} className="inline-flex items-center gap-1 h-6 px-2 text-xs hover:bg-muted rounded-md"><Users className="h-3 w-3" />客户档案库</Link>
                    <Link href={`/admin/organizations/${o.id}/analytics`} className="inline-flex items-center gap-1 h-6 px-2 text-xs hover:bg-muted rounded-md"><BarChart3 className="h-3 w-3" />分析</Link>
                  </div>
                  {o.address && <div className="text-sm text-muted-foreground mt-1"><MapPin className="h-3 w-3 inline mr-1" />{o.address}</div>}
                  {o.aliases.length > 0 && (
                    <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                      <Tag className="h-3 w-3 text-muted-foreground shrink-0" />
                      {o.aliases.map((a) => (
                        <Badge key={a.id} variant="outline" className="text-xs">{a.alias}</Badge>
                      ))}
                    </div>
                  )}
                  {o.sites.length > 0 && (
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <Building2 className="h-3 w-3 text-muted-foreground shrink-0" />
                      {o.sites.map((s) => (
                        <Badge key={s.id} variant="secondary" className="text-xs">{s.siteName}{s.address ? ` · ${s.address}` : ""}</Badge>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="sm" title="详情" render={<Link href={`/admin/organizations/${o.id}`} />}>
                    <FileText className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="sm" title="分配代表"
                    onClick={() => {
                      setAssignTargetOrg(o);
                      setSelectedRepId("");
                      setSelectedAssignSiteId("__org__");
                      setEditingBindingSite(
                        Object.fromEntries((bindingMap.get(o.id) || []).map((b) => [b.bindingId, b.organizationSiteId || "__org__"])),
                      );
                      setAssignDialogOpen(true);
                    }}
                  ><UserCog className="h-3 w-3" /></Button>
                  <Button variant="ghost" size="sm" title="编辑"
                    onClick={() => {
                      setEditing(o);
                      setEditForm({ canonicalName: o.canonicalName, address: o.address || "", taxId: o.taxId || "", isInvoiceSubject: o.isInvoiceSubject, invoiceAddress: o.invoiceAddress || "", invoicePhone: o.invoicePhone || "", invoiceBankName: o.invoiceBankName || "", invoiceBankAccount: o.invoiceBankAccount || "" });
                      setNewAliases([""]);
                      setNewSites([{ siteName: "", address: "", siteType: "CAMPUS" }]);
                      setEditOpen(true);
                    }}
                  ><Pencil className="h-3 w-3" /></Button>
                  <Button variant="ghost" size="sm" title="合并"
                    onClick={() => { setMergeSource(o); setMergeTargetId(""); setMergeOpen(true); }}
                  >
                    <Merge className="h-3 w-3" />
                  </Button>
                  {o.sites.length > 0 && (
                    <Button variant="ghost" size="sm" title="客户挂院区（建议）"
                      onClick={() => { setDrillOrg(o); setDrillRowSite({}); setDrillOpen(true); }}
                    >
                      <Sparkles className="h-3 w-3" />
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" title={o.archived ? "恢复" : "归档"}
                    className={o.archived ? "text-success" : "text-warning"}
                    onClick={() => updateMutation.mutate({ id: o.id, archived: !o.archived })}
                  >
                    {o.archived ? <ArchiveRestore className="h-3 w-3" /> : <Archive className="h-3 w-3" />}
                  </Button>
                  {o._count.customers === 0 && (
                    <Button variant="ghost" size="sm" title="删除" className="text-danger"
                      onClick={async () => {
                        const ok = await confirm({
                          title: "删除机构",
                          description: `确定删除 "${o.canonicalName}"？`,
                          variant: "destructive",
                        });
                        if (ok) deleteMutation.mutate(o.id);
                      }}
                    ><Trash2 className="h-3 w-3" /></Button>
                  )}
                </div>
              </div>
                );
              })()}
            </div>
          ))}
        </div>
      )}

      {/* Assign Representative Dialog */}
      <Dialog
        open={assignDialogOpen}
        onOpenChange={(open) => {
          setAssignDialogOpen(open);
          if (!open) {
            setAssignTargetOrg(null);
            setSelectedRepId("");
            setSelectedAssignSiteId("__org__");
            setEditingBindingSite({});
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle>管理代表分配</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              管理单位 <span className="font-medium text-foreground">{assignTargetOrg?.canonicalName}</span> 的代表绑定。取消分配会归档绑定记录，不会批量改动已有客户负责人。
            </p>
            <div className="space-y-2">
              <Label>当前分配</Label>
              {assignActiveBindings.length > 0 ? (
                <div className="space-y-2">
                  {assignActiveBindings.map((binding) => {
                    const selectedSite = editingBindingSite[binding.bindingId] ?? (binding.organizationSiteId || "__org__");
                    const originalSite = binding.organizationSiteId || "__org__";
                    return (
                      <div key={binding.bindingId} className="rounded-md border p-3 space-y-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium text-sm">{binding.name}</span>
                              {binding.isPrimary && <Badge variant="secondary" className="text-[10px]">主代表</Badge>}
                            </div>
                            <div className="text-xs text-muted-foreground truncate">{binding.email}</div>
                          </div>
                          <Badge variant="outline" className="shrink-0">
                            {binding.organizationSiteName || "整个单位"}
                          </Badge>
                        </div>
                        <div className="flex flex-col sm:flex-row gap-2">
                          <Select
                            value={selectedSite}
                            onValueChange={(v) => setEditingBindingSite((prev) => ({
                              ...prev,
                              [binding.bindingId]: v || "__org__",
                            }))}
                          >
                            <SelectTrigger className="flex-1">
                              <SelectValue placeholder="选择绑定范围...">
                                {selectedSite === "__org__" ? "整个单位" : assignTargetOrg?.sites.find((s) => s.id === selectedSite)?.siteName || selectedSite}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__org__">整个单位</SelectItem>
                              {assignTargetOrg?.sites.map((site) => (
                                <SelectItem key={site.id} value={site.id}>
                                  {site.siteName}
                                  {site.siteType ? ` (${SITE_TYPE_LABELS[site.siteType] || site.siteType})` : ""}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={selectedSite === originalSite || (bindingActionMutation.isPending && actingBindingId === binding.bindingId)}
                            onClick={() => {
                              bindingActionMutation.mutate({
                                bindingId: binding.bindingId,
                                action: "change-scope",
                                siteId: selectedSite === "__org__" ? null : selectedSite,
                              });
                            }}
                          >
                            保存范围
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-danger hover:text-danger/80"
                            disabled={bindingActionMutation.isPending && actingBindingId === binding.bindingId}
                            onClick={async () => {
                              const ok = await confirm({
                                title: "取消分配",
                                description: `确定取消 ${binding.name} 对 ${assignTargetOrg?.canonicalName} 的分配？`,
                                variant: "destructive",
                              });
                              if (ok) {
                                bindingActionMutation.mutate({ bindingId: binding.bindingId, action: "archive" });
                              }
                            }}
                          >
                            取消分配
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  当前没有生效代表绑定。
                </div>
              )}
            </div>
            <hr />
            <div className="space-y-2">
              <Label>新增分配</Label>
              <Select value={selectedRepId} onValueChange={(v) => setSelectedRepId(v || "")}>
                <SelectTrigger>
                  <SelectValue placeholder="选择代表...">
                    {selectedRepId ? repsData?.representatives.find((r) => r.id === selectedRepId)?.name || selectedRepId : "选择代表..."}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {repsData?.representatives.map((r) => (
                    <SelectItem key={r.id} value={r.id}>{r.name} ({r.email})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>绑定范围</Label>
              <Select value={selectedAssignSiteId} onValueChange={(v) => setSelectedAssignSiteId(v || "__org__")}>
                <SelectTrigger>
                  <SelectValue placeholder="选择绑定范围...">
                    {selectedAssignSiteId === "__org__" ? "整个单位" : assignTargetOrg?.sites.find((s) => s.id === selectedAssignSiteId)?.siteName || selectedAssignSiteId}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__org__">整个单位</SelectItem>
                  {assignTargetOrg?.sites.map((site) => (
                    <SelectItem key={site.id} value={site.id}>
                      {site.siteName}
                      {site.siteType ? ` (${SITE_TYPE_LABELS[site.siteType] || site.siteType})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              className="w-full"
              disabled={!selectedRepId || assignRepMutation.isPending}
              onClick={() => {
                if (assignTargetOrg && selectedRepId) {
                  assignRepMutation.mutate({
                    orgId: assignTargetOrg.id,
                    repId: selectedRepId,
                    siteId: selectedAssignSiteId === "__org__" ? null : selectedAssignSiteId,
                  });
                }
              }}
            >
              {assignRepMutation.isPending ? "分配中..." : "确认分配"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-lg">
          <DialogHeader><DialogTitle>新增机构</DialogTitle></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); if (!form.canonicalName.trim()) return; createMutation.mutate(form); }} className="contents">
            <div className="-mx-4 min-h-0 overflow-y-auto px-4 pb-1">
            <div className="space-y-4">
            <OrganizationAiFillPlugin query={form.canonicalName} onApply={applyDraftToCreateForm} disabled={createMutation.isPending} />
            <div className="space-y-2">
              <Label>标准名称 *</Label>
              <Input value={form.canonicalName} onChange={(e) => setForm({ ...form, canonicalName: e.target.value })} required />
            </div>
            <div className="space-y-2">
              <Label>地址</Label>
              <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>税号</Label>
              <TaxIdLookupInput
                value={form.taxId}
                onChange={(v) => setForm({ ...form, taxId: v })}
                orgName={form.canonicalName}
                placeholder="统一社会信用代码/纳税人识别号"
              />
            </div>
            <div className="space-y-2">
              <Label>别名（简称、旧名等）</Label>
              {form.aliases.map((a, i) => (
                <div key={i} className="flex min-w-0 gap-2">
                  <Input value={a} onChange={(e) => { const arr = [...form.aliases]; arr[i] = e.target.value; setForm({ ...form, aliases: arr }); }} placeholder="如：浙一" />
                  {form.aliases.length > 1 && <Button type="button" variant="ghost" size="sm" onClick={() => setForm({ ...form, aliases: form.aliases.filter((_, j) => j !== i) })}><X className="h-3 w-3" /></Button>}
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={() => setForm({ ...form, aliases: [...form.aliases, ""] })}>
                <Plus className="h-3 w-3 mr-1" />添加别名
              </Button>
            </div>
            <div className="space-y-2">
              <Label>院区/校区</Label>
              {form.sites.map((s, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_90px_minmax(0,1fr)_auto]">
                  <Input value={s.siteName} onChange={(e) => { const arr = [...form.sites]; arr[i] = { ...arr[i], siteName: e.target.value }; setForm({ ...form, sites: arr }); }} placeholder="院区名称" className="flex-1" />
                  <Select value={(s as SiteForm).siteType || "CAMPUS"} onValueChange={(v) => { const arr = [...form.sites]; arr[i] = { ...arr[i], siteType: v || "CAMPUS" }; setForm({ ...form, sites: arr }); }}>
                    <SelectTrigger className="w-[90px]">
                      <SelectValue placeholder="类型">{SITE_TYPE_LABELS[(s as SiteForm).siteType] || "类型"}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {CRM_SITE_TYPES.map((st) => (<SelectItem key={st} value={st}>{SITE_TYPE_LABELS[st]}</SelectItem>))}
                    </SelectContent>
                  </Select>
                  <Input value={s.address} onChange={(e) => { const arr = [...form.sites]; arr[i] = { ...arr[i], address: e.target.value }; setForm({ ...form, sites: arr }); }} placeholder="地址" className="flex-1" />
                  {form.sites.length > 1 && <Button type="button" variant="ghost" size="sm" onClick={() => setForm({ ...form, sites: form.sites.filter((_, j) => j !== i) })}><X className="h-3 w-3" /></Button>}
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={() => setForm({ ...form, sites: [...form.sites, { siteName: "", address: "", siteType: "CAMPUS" }] })}>
                <Plus className="h-3 w-3 mr-1" />添加院区
              </Button>
            </div>
            </div>
            </div>
            <div className="-mx-4 -mb-4 border-t bg-popover/95 px-4 py-3">
              <Button type="submit" className="w-full" disabled={createMutation.isPending}>
                {createMutation.isPending ? "创建中..." : "创建机构"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={(open) => { setEditOpen(open); if (!open) { setEditing(null); setEditForm({ canonicalName: "", address: "", taxId: "", isInvoiceSubject: false, invoiceAddress: "", invoicePhone: "", invoiceBankName: "", invoiceBankAccount: "" }); setNewAliases([""]); setNewSites([{ siteName: "", address: "", siteType: "CAMPUS" }]); } }}>
        <DialogContent className="sm:max-w-lg max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
          <DialogHeader><DialogTitle>编辑机构</DialogTitle></DialogHeader>
          <div className="-mx-4 min-h-0 overflow-y-auto overscroll-contain px-4 pb-1" style={{ WebkitOverflowScrolling: "touch" }}>
            <div className="space-y-4">
            {editing && (
              <OrganizationAiFillPlugin
                query={editForm.canonicalName || editing.canonicalName}
                mode="supplement"
                onApply={applyDraftToEditSupplement}
                disabled={updateMutation.isPending}
              />
            )}
            <div className="space-y-2">
              <Label>标准名称</Label>
              <Input value={editForm.canonicalName} onChange={(e) => setEditForm({ ...editForm, canonicalName: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>地址</Label>
              <Input value={editForm.address} onChange={(e) => setEditForm({ ...editForm, address: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>税号</Label>
              <TaxIdLookupInput
                value={editForm.taxId}
                onChange={(v) => setEditForm({ ...editForm, taxId: v })}
                orgName={editForm.canonicalName}
                placeholder="统一社会信用代码/纳税人识别号"
                onInvoiceSelect={(f) => setEditForm((prev) => ({
                  ...prev,
                  taxId: f.taxId,
                  isInvoiceSubject: true,
                  invoiceAddress: f.unitAddress || prev.invoiceAddress,
                  invoicePhone: f.unitPhone || prev.invoicePhone,
                  invoiceBankName: f.bankName || prev.invoiceBankName,
                  invoiceBankAccount: f.bankNo || prev.invoiceBankAccount,
                }))}
              />
            </div>
            {editForm.taxId && (
              <>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="isInvoiceSubject"
                  checked={editForm.isInvoiceSubject}
                  onCheckedChange={(checked) => setEditForm({ ...editForm, isInvoiceSubject: Boolean(checked) })}
                />
                <Label htmlFor="isInvoiceSubject" className="text-sm cursor-pointer">标记为开票主体</Label>
              </div>
              {(editForm.invoiceAddress || editForm.invoicePhone || editForm.invoiceBankName || editForm.invoiceBankAccount) && (
                <div className="rounded-md border bg-muted/40 p-2 space-y-1 text-xs text-muted-foreground">
                  <div className="font-medium text-foreground">开票信息（来自发票API，可编辑）</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                    <Input className="h-7 text-xs" placeholder="开票地址" value={editForm.invoiceAddress} onChange={(e) => setEditForm({ ...editForm, invoiceAddress: e.target.value })} />
                    <Input className="h-7 text-xs" placeholder="开票电话" value={editForm.invoicePhone} onChange={(e) => setEditForm({ ...editForm, invoicePhone: e.target.value })} />
                    <Input className="h-7 text-xs" placeholder="开户行" value={editForm.invoiceBankName} onChange={(e) => setEditForm({ ...editForm, invoiceBankName: e.target.value })} />
                    <Input className="h-7 text-xs" placeholder="银行账号" value={editForm.invoiceBankAccount} onChange={(e) => setEditForm({ ...editForm, invoiceBankAccount: e.target.value })} />
                  </div>
                </div>
              )}
              </>
            )}
            <hr />
            <div className="space-y-2">
              <Label>别名</Label>
              <div className="flex flex-wrap gap-1.5">
                {editing?.aliases.map((a) => (
                  <Badge key={a.id} variant="outline" className="gap-1">
                    {a.alias}
                    <button type="button" className="hover:text-danger" onClick={() => {
                      updateMutation.mutate({ id: editing.id, removeAliasId: a.id });
                    }}><X className="h-3 w-3" /></button>
                  </Badge>
                ))}
              </div>
              <div className="space-y-2">
                {newAliases.map((alias, idx) => (
                  <div key={idx} className="flex gap-2">
                    <Input
                      value={alias}
                      onChange={(e) => {
                        const aliases = [...newAliases];
                        aliases[idx] = e.target.value;
                        setNewAliases(aliases);
                      }}
                      placeholder="新别名"
                      className="min-w-0 flex-1"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setNewAliases(newAliases.length > 1 ? newAliases.filter((_, i) => i !== idx) : [""])}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" onClick={() => setNewAliases([...newAliases, ""])}>
                  <Plus className="h-3 w-3 mr-1" />添加一行
                </Button>
              </div>
            </div>

            <hr />
            <div className="space-y-2">
              <Label>院区/校区</Label>
              <div className="max-h-48 overflow-y-auto rounded-md border p-2 space-y-1.5">
                {editing?.sites.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 text-sm min-w-0">
                    <Building2 className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="truncate min-w-0">{s.siteName}</span>
                    <Badge variant="secondary" className="text-[10px] shrink-0">{SITE_TYPE_LABELS[s.siteType] || "院区"}</Badge>
                    {s.address && <span className="text-muted-foreground truncate min-w-0">· {s.address}</span>}
                    {Number.isFinite(s.lat as number) && Number.isFinite(s.lng as number) && (
                      <Badge variant="outline" className="text-[10px] shrink-0 text-success border-success-border">已定位</Badge>
                    )}
                    <button type="button" className="ml-auto shrink-0 text-muted-foreground hover:text-primary" title="地图选点" onClick={() => {
                      setMapPickerSite(s);
                      setMapPickerOpen(true);
                    }}><MapPin className="h-3 w-3" /></button>
                    <button type="button" className="shrink-0 text-muted-foreground hover:text-primary" title="合并到其他院区" onClick={() => {
                      if (!editing) return;
                      setSiteMergeOrgId(editing.id);
                      setSiteMergeSource(s);
                      setSiteMergeTargetId("");
                      setSiteMergePreserveHierarchy(true);
                      setSiteMergeReason("");
                      setSiteMergePreview(null);
                      setSiteMergeOpen(true);
                    }}><Merge className="h-3 w-3" /></button>
                    <button type="button" className="shrink-0 text-muted-foreground hover:text-danger" title="删除院区" onClick={() => {
                      updateMutation.mutate({ id: editing.id, removeSiteId: s.id });
                    }}><X className="h-3 w-3" /></button>
                  </div>
                ))}
              </div>
              <div className="space-y-3">
                {newSites.map((site, idx) => (
                  <div key={idx} className="space-y-2 rounded-md border p-2">
                    <div className="flex gap-2">
                      <Input
                        value={site.siteName}
                        onChange={(e) => {
                          const sites = [...newSites];
                          sites[idx] = { ...sites[idx], siteName: e.target.value };
                          setNewSites(sites);
                        }}
                        placeholder="院区名称"
                        className="min-w-0 flex-1"
                      />
                      <Select
                        value={site.siteType || "CAMPUS"}
                        onValueChange={(v) => {
                          const sites = [...newSites];
                          sites[idx] = { ...sites[idx], siteType: v || "CAMPUS" };
                          setNewSites(sites);
                        }}
                      >
                        <SelectTrigger className="w-[100px] shrink-0">
                          <SelectValue placeholder="类型">{SITE_TYPE_LABELS[site.siteType] || "类型"}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {CRM_SITE_TYPES.map((st) => (<SelectItem key={st} value={st}>{SITE_TYPE_LABELS[st]}</SelectItem>))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setNewSites(newSites.length > 1 ? newSites.filter((_, i) => i !== idx) : [{ siteName: "", address: "", siteType: "CAMPUS" }])}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                    <Input
                      value={site.address}
                      onChange={(e) => {
                        const sites = [...newSites];
                        sites[idx] = { ...sites[idx], address: e.target.value };
                        setNewSites(sites);
                      }}
                      placeholder="地址"
                    />
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setNewSites([...newSites, { siteName: "", address: "", siteType: "CAMPUS" }])}
                >
                  <Plus className="h-3 w-3 mr-1" />添加一行
                </Button>
              </div>
            </div>
            </div>
          </div>
          <div className="-mx-4 -mb-4 border-t bg-popover/95 px-4 py-3">
            <Button
              className="w-full"
              disabled={updateMutation.isPending || !editing || (editForm.canonicalName === editing.canonicalName && editForm.address === (editing.address || "") && editForm.taxId === (editing.taxId || "") && editForm.isInvoiceSubject === editing.isInvoiceSubject && editForm.invoiceAddress === (editing.invoiceAddress || "") && editForm.invoicePhone === (editing.invoicePhone || "") && editForm.invoiceBankName === (editing.invoiceBankName || "") && editForm.invoiceBankAccount === (editing.invoiceBankAccount || "") && !newAliases.some((a) => a.trim()) && !newSites.some((s) => s.siteName.trim()))}
              onClick={() => {
                if (!editing) return;
                const updates: Record<string, unknown> & { id: string } = { id: editing.id };
                if (editForm.canonicalName !== editing.canonicalName) updates.canonicalName = editForm.canonicalName;
                if (editForm.address !== (editing.address || "")) updates.address = editForm.address || null;
                if (editForm.taxId !== (editing.taxId || "")) updates.taxId = editForm.taxId || null;
                if (editForm.isInvoiceSubject !== editing.isInvoiceSubject) updates.isInvoiceSubject = editForm.isInvoiceSubject;
                if (editForm.invoiceAddress !== (editing.invoiceAddress || "")) updates.invoiceAddress = editForm.invoiceAddress || null;
                if (editForm.invoicePhone !== (editing.invoicePhone || "")) updates.invoicePhone = editForm.invoicePhone || null;
                if (editForm.invoiceBankName !== (editing.invoiceBankName || "")) updates.invoiceBankName = editForm.invoiceBankName || null;
                if (editForm.invoiceBankAccount !== (editing.invoiceBankAccount || "")) updates.invoiceBankAccount = editForm.invoiceBankAccount || null;
                const aliasesToAdd = newAliases.map((a) => a.trim()).filter(Boolean);
                if (aliasesToAdd.length > 0) updates.addAliases = aliasesToAdd;
                const sitesToAdd = newSites
                  .map((s) => ({ siteName: s.siteName.trim(), address: s.address.trim(), siteType: s.siteType || "CAMPUS" }))
                  .filter((s) => s.siteName);
                if (sitesToAdd.length > 0) updates.addSites = sitesToAdd;
                if (Object.keys(updates).length === 1) {
                  toast.info("没有需要保存的修改");
                  return;
                }
                updateMutation.mutate(updates, {
                  onSuccess: () => {
                    setNewAliases([""]);
                    setNewSites([{ siteName: "", address: "", siteType: "CAMPUS" }]);
                  },
                });
              }}
            >
              {updateMutation.isPending ? "保存中..." : "保存修改"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Merge Dialog */}
      <Dialog open={mergeOpen} onOpenChange={setMergeOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>合并机构</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              将 <span className="font-medium text-foreground">{mergeSource?.canonicalName}</span> 的所有客户、别名和院区转移到目标机构。源机构将被标记为已删除，其标准名称会作为目标机构的别名保留。
            </p>
            <div className="space-y-2">
              <Label>目标机构</Label>
              <OrganizationAdminSelect
                value={mergeTargetId}
                onChange={(org) => setMergeTargetId(org?.id || "")}
                excludeIds={mergeSource ? [mergeSource.id] : undefined}
                placeholder="搜索并选择目标机构..."
              />
              {mergeTargetId && (
                <div className="rounded-md border bg-muted/30 p-3 space-y-1">
                  {(() => {
                    const target = orgs.find((o) => o.id === mergeTargetId);
                    if (!target) return <p className="text-xs text-muted-foreground">加载目标机构信息...</p>;
                    return (
                      <>
                        <p className="text-xs text-muted-foreground">目标机构摘要</p>
                        <p className="text-sm font-medium">{target.canonicalName} <span className="text-xs text-muted-foreground font-normal">({target.orgCode})</span></p>
                        {target.address && <p className="text-xs text-muted-foreground">{target.address}</p>}
                        <p className="text-xs text-muted-foreground">
                          {target.sites.length > 0 ? `${target.sites.length} 个院区 · ` : ""}
                          {target._count.customers} 位客户
                        </p>
                        <p className="text-xs text-warning mt-1">
                          确认后将迁移源机构的客户、别名和院区到此目标机构，源机构将被标记为已删除。
                        </p>
                      </>
                    );
                  })()}
                </div>
              )}
            </div>
            <Button className="w-full" disabled={!mergeTargetId || mergeMutation.isPending}
              onClick={async () => {
                if (!mergeSource || !mergeTargetId) return;
                const target = orgs.find((o) => o.id === mergeTargetId);
                const ok = await confirm({
                  title: "合并机构",
                  description: `确定将 "${mergeSource.canonicalName}" 合并到 "${target?.canonicalName}"？`,
                  variant: "destructive",
                });
                if (ok) {
                  mergeMutation.mutate({ sourceId: mergeSource.id, targetId: mergeTargetId });
                }
              }}
            >
              <Merge className="mr-2 h-4 w-4" />
              {mergeMutation.isPending ? "合并中..." : "确认合并"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Site Merge Dialog (Task 1.6) — merge two sites under the same org */}
      <Dialog open={siteMergeOpen} onOpenChange={(open) => {
        setSiteMergeOpen(open);
        if (!open) { setSiteMergeSource(null); setSiteMergeTargetId(""); setSiteMergePreview(null); setSiteMergeReason(""); }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>合并院区</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              将院区 <span className="font-medium text-foreground">{siteMergeSource?.siteName}</span> 合并到同机构下的目标院区。源院区的客户将迁移到目标院区，<span className="text-warning">源院区的代表绑定将被归档，目标院区绑定保留</span>。源院区合并后归档。
            </p>
            <div className="space-y-2">
              <Label>目标院区</Label>
              <Select value={siteMergeTargetId} onValueChange={(v) => { setSiteMergeTargetId(v ?? ""); setSiteMergePreview(null); }}>
                <SelectTrigger><SelectValue placeholder="选择目标院区..." /></SelectTrigger>
                <SelectContent>
                  {(editing?.sites || []).filter((x) => x.id !== siteMergeSource?.id).map((x) => (
                    <SelectItem key={x.id} value={x.id}>{x.siteName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(editing?.sites || []).filter((x) => x.id !== siteMergeSource?.id).length === 0 && (
                <p className="text-xs text-muted-foreground">该机构下没有其他可合并的未归档院区。</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="siteMergePreserveHierarchy"
                checked={siteMergePreserveHierarchy}
                onCheckedChange={(checked) => setSiteMergePreserveHierarchy(Boolean(checked))}
              />
              <Label htmlFor="siteMergePreserveHierarchy" className="text-sm cursor-pointer">保留层级信息（在目标院区记录被合并的来源）</Label>
            </div>
            <div className="space-y-2">
              <Label>备注（选填）</Label>
              <Input value={siteMergeReason} onChange={(e) => setSiteMergeReason(e.target.value)} placeholder="合并原因" />
            </div>
            {siteMergePreview && (
              <div className="rounded-md border bg-muted/30 p-3 space-y-1">
                <p className="text-xs text-muted-foreground">合并预览</p>
                <p className="text-sm">将迁移 <span className="font-medium">{siteMergePreview.migratedCustomers}</span> 位客户，归档 <span className="font-medium">{siteMergePreview.archivedBindings}</span> 条代表绑定。</p>
              </div>
            )}
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" disabled={!siteMergeTargetId || siteMergeMutation.isPending}
                onClick={() => {
                  if (!siteMergeOrgId || !siteMergeSource || !siteMergeTargetId) return;
                  siteMergeMutation.mutate(
                    { orgId: siteMergeOrgId, sourceSiteId: siteMergeSource.id, targetSiteId: siteMergeTargetId, preserveHierarchy: siteMergePreserveHierarchy, reason: siteMergeReason, dryRun: true },
                    { onSuccess: (d) => setSiteMergePreview({ migratedCustomers: d.migratedCustomers, archivedBindings: d.archivedBindings }) },
                  );
                }}>
                {siteMergeMutation.isPending ? "..." : "预览"}
              </Button>
              <Button className="flex-1" disabled={!siteMergeTargetId || siteMergeMutation.isPending}
                onClick={async () => {
                  if (!siteMergeOrgId || !siteMergeSource || !siteMergeTargetId) return;
                  const targetName = (editing?.sites || []).find((x) => x.id === siteMergeTargetId)?.siteName || "目标院区";
                  const sourceId = siteMergeSource.id;
                  const sourceName = siteMergeSource.siteName;
                  const ok = await confirm({
                    title: "合并院区",
                    description: `确定将院区 "${sourceName}" 合并到 "${targetName}"？源院区将被归档，其代表绑定将被归档。`,
                    variant: "destructive",
                  });
                  if (!ok) return;
                  siteMergeMutation.mutate(
                    { orgId: siteMergeOrgId, sourceSiteId: sourceId, targetSiteId: siteMergeTargetId, preserveHierarchy: siteMergePreserveHierarchy, reason: siteMergeReason, dryRun: false },
                    { onSuccess: (d) => {
                      toast.success(`院区已合并（迁移 ${d.migratedCustomers} 客户，归档 ${d.archivedBindings} 绑定）`);
                      setSiteMergeOpen(false);
                      setSiteMergeSource(null);
                      setSiteMergeTargetId("");
                      setSiteMergePreview(null);
                      setSiteMergeReason("");
                      setEditing((prev) => prev ? { ...prev, sites: prev.sites.filter((x) => x.id !== sourceId) } : prev);
                      queryClient.invalidateQueries({ queryKey: ["organizations"] });
                      queryClient.invalidateQueries({ queryKey: ["representative-organizations", "all"] });
                    } },
                  );
                }}>
                <Merge className="mr-2 h-4 w-4" />
                {siteMergeMutation.isPending ? "合并中..." : "确认合并"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Customer Site Drill-down Dialog (Task 1.12) — suggest + batch-assign site for org-level customers */}
      <Dialog open={drillOpen} onOpenChange={(open) => {
        setDrillOpen(open);
        if (!open) { setDrillOrg(null); setDrillRowSite({}); }
      }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader><DialogTitle>客户挂院区建议</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              为 <span className="font-medium text-foreground">{drillOrg?.canonicalName}</span> 下尚未挂院区的客户，按地址/名称文本规则推荐院区。
              <span className="text-success"> 高置信度</span>可一键批量挂载；低置信度/未匹配请逐个手动选择院区后挂载。
            </p>
            {drillLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : (() => {
              const rows = drillData?.suggestions || [];
              const highRows = rows.filter((r) => r.confidence === "HIGH" && r.suggestedSiteId);
              return (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-muted-foreground">共 {rows.length} 个待挂客户，其中高置信度 {highRows.length} 个</span>
                    <Button size="sm" disabled={highRows.length === 0 || drillAssignMutation.isPending}
                      onClick={() => {
                        const bySite = new Map<string, string[]>();
                        for (const r of highRows) {
                          const arr = bySite.get(r.suggestedSiteId!) || [];
                          arr.push(r.profileId);
                          bySite.set(r.suggestedSiteId!, arr);
                        }
                        const groups = [...bySite.entries()].map(([organizationSiteId, profileIds]) => ({ organizationSiteId, profileIds }));
                        if (groups.length > 0) drillAssignMutation.mutate(groups);
                      }}>
                      {drillAssignMutation.isPending ? "挂载中..." : `全部确认高置信度 (${highRows.length})`}
                    </Button>
                  </div>
                  <div className="max-h-[50vh] overflow-y-auto">
                    <DataTable
                      columns={drillColumns}
                      data={rows}
                      keyExtractor={(r) => r.profileId}
                      emptyTitle="该机构下没有待挂院区的客户"
                    />
                  </div>
                </>
              );
            })()}
          </div>
        </DialogContent>
      </Dialog>

      {/* Site Map Picker (Task 1.13) — pick lat/lng for an existing site */}
      {mapPickerSite && (
        <SiteMapPicker
          open={mapPickerOpen}
          onOpenChange={(o) => { setMapPickerOpen(o); if (!o) setMapPickerSite(null); }}
          siteId={mapPickerSite.id}
          siteName={mapPickerSite.siteName}
          initialLat={mapPickerSite.lat ?? null}
          initialLng={mapPickerSite.lng ?? null}
          onSaved={(loc) => {
            // reflect new coords locally so the "已定位" badge updates without a refetch
            setEditing((prev) => prev ? { ...prev, sites: prev.sites.map((x) => x.id === mapPickerSite.id ? { ...x, lat: loc.lat, lng: loc.lng } : x) } : prev);
            queryClient.invalidateQueries({ queryKey: ["organizations"] });
          }}
        />
      )}
    </PageShell>
  );
}