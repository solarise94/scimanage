"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Search, CheckCircle, XCircle, Plus, Building2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { OrganizationAiFillPlugin, type OrganizationDraftPreview } from "@/components/organization-ai-fill-plugin";
import { OrganizationAdminSelect } from "@/components/organization-admin-select";
import { CRM_SITE_TYPES, SITE_TYPE_LABELS } from "@/lib/crm/constants";
import { toast } from "sonner";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";

interface ReviewTask {
  id: string;
  rawInput: string;
  normalizedInput: string;
  suggestedCanonicalName: string | null;
  suggestedAddress: string | null;
  confidence: number | null;
  status: string;
  sourceType: string;
  sourceId: string;
  resolutionSource: string | null;
  reviewNote: string | null;
  suggestedAliasesJson: string | null;
  suggestedSitesJson: string | null;
  evidenceJson: string | null;
  createdAt: string;
  reviewedAt: string | null;
  suggestedOrg: { id: string; canonicalName: string; orgCode: string } | null;
  suggestedSite: { id: string; siteName: string } | null;
  createdByUser: { id: string; name: string } | null;
  reviewedByUser: { id: string; name: string } | null;
}

const sourceLabels: Record<string, string> = {
  CUSTOMER_CREATE: "客户创建",
  CUSTOMER_EDIT: "客户编辑",
  SMART_FILL: "智能填写",
  ORG_CREATE_REQUEST: "手工建档",
};

export default function OrganizationReviewsPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data: session, status } = useSession();
  const [statusFilter, setStatusFilter] = useState("PENDING");

  const [search, setSearch] = useState("");
  const [approveOpen, setApproveOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [activeTask, setActiveTask] = useState<ReviewTask | null>(null);
  const [selectedOrgId, setSelectedOrgId] = useState("");
  const [selectedSiteId, setSelectedSiteId] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [bindSiteTempId, setBindSiteTempId] = useState("");
  const [newOrg, setNewOrg] = useState({ canonicalName: "", address: "", aliases: "", sites: [{ siteName: "", address: "", siteType: "CAMPUS", tempId: crypto.randomUUID() }] as Array<{ siteName: string; address: string; siteType: string; tempId: string }> });
  const [approveMode, setApproveMode] = useState<"bind" | "merge">("bind");
  const [createMode, setCreateMode] = useState<"normal" | "force">("normal");

  const { data, isLoading, error } = useQuery<{ tasks: ReviewTask[] }>({
    queryKey: ["org-reviews", statusFilter, search],
    queryFn: async () => {
      const params = new URLSearchParams({ status: statusFilter });
      if (search) params.set("search", search);
      const res = await fetch(`/api/organization-reviews?${params}`);
      if (res.status === 403) throw new Error("无权访问");
      if (!res.ok) throw new Error("加载失败");
      return res.json();
    },
    enabled: status === "authenticated" && session?.user?.role === "ADMIN",
  });

  useEffect(() => {
    if (status === "authenticated" && session?.user?.role !== "ADMIN") {
      router.push("/dashboard");
    }
    if (error?.message === "无权访问") {
      router.push("/dashboard");
    }
  }, [status, session, error, router]);

  const approveMutation = useMutation({
    mutationFn: async (payload: { id: string; action: string; organizationId?: string; organizationSiteId?: string; reviewNote?: string; canonicalName?: string; address?: string; aliases?: string[]; sites?: Array<{ siteName: string; address: string; siteType?: string }>; bindSiteName?: string; siteName?: string; siteAddress?: string }) => {
      const { id, ...body } = payload;
      const res = await fetch(`/api/organization-reviews/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "操作失败");
      return data;
    },
    onSuccess: (_, vars) => {
      const msg = vars.action === "reject" ? "已拒绝" : "已审批通过";
      toast.success(msg);
      setApproveOpen(false);
      setCreateOpen(false);
      setRejectOpen(false);
      setActiveTask(null);
      queryClient.invalidateQueries({ queryKey: ["org-reviews"] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const tasks = data?.tasks || [];

  const { data: selectedOrgDetail } = useQuery<{
    organization: {
      id: string;
      canonicalName: string;
      orgCode: string;
      address: string | null;
      sites: Array<{ id: string; siteName: string; siteType: string }>;
    };
  }>({
    queryKey: ["organization-detail-for-review", selectedOrgId],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${selectedOrgId}`);
      if (!res.ok) throw new Error("加载机构详情失败");
      return res.json();
    },
    enabled: !!selectedOrgId,
  });

  const selectedOrg = selectedOrgDetail?.organization || null;

  function applyDraftToNewOrg(draft: OrganizationDraftPreview) {
    setNewOrg({
      canonicalName: draft.canonicalName,
      address: draft.address || "",
      aliases: draft.aliases.join(", "),
      sites: draft.sites.length > 0
        ? draft.sites.map((site) => ({ siteName: site.siteName, address: site.address || "", siteType: "CAMPUS", tempId: crypto.randomUUID() }))
        : [{ siteName: "", address: "", siteType: "CAMPUS", tempId: crypto.randomUUID() }],
    });
    toast.success("已应用 AI 草稿，请检查后再保存");
  }

  if (status === "loading") return null;
  if (!session || session.user.role !== "ADMIN") return null;
  if (error?.message === "无权访问") return null;

  return (
    <PageShell>
      <PageHeader
        title="单位复核"
        description="审核未精确匹配的单位信息，确认或新建主数据"
      />

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="搜索..." className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v || "PENDING")}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="选择状态...">
              {{ PENDING: "待审核", APPROVED: "已通过", REJECTED: "已拒绝", CANCELLED: "已取消" }[statusFilter] || statusFilter}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="PENDING">待审核</SelectItem>
            <SelectItem value="APPROVED">已通过</SelectItem>
            <SelectItem value="REJECTED">已拒绝</SelectItem>
            <SelectItem value="CANCELLED">已取消</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : tasks.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center">
          <p className="text-muted-foreground">{statusFilter === "PENDING" ? "暂无待审核任务" : "暂无记录"}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map((t) => (
            <div key={t.id} className="rounded-lg border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{t.rawInput}</span>
                    <Badge variant="outline" className="text-xs">{sourceLabels[t.sourceType] || t.sourceType}</Badge>
                    {t.confidence != null && <Badge variant="secondary" className="text-xs">置信度 {Math.round(t.confidence * 100)}%</Badge>}
                    {t.status === "PENDING" && <Badge className="text-xs bg-amber-500">待审核</Badge>}
                    {t.status === "APPROVED" && <Badge className="text-xs bg-green-600">已通过</Badge>}
                    {t.status === "REJECTED" && <Badge variant="destructive" className="text-xs">已拒绝</Badge>}
                    {t.status === "CANCELLED" && <Badge variant="outline" className="text-xs">已取消</Badge>}
                  </div>
                  {t.suggestedOrg && (
                    <div className="text-sm text-muted-foreground flex items-center gap-1">
                      <Building2 className="h-3 w-3" />
                      建议: {t.suggestedOrg.canonicalName} ({t.suggestedOrg.orgCode})
                      {t.suggestedSite && ` · ${t.suggestedSite.siteName}`}
                    </div>
                  )}
                  {!t.suggestedOrg && t.suggestedCanonicalName && (
                    <div className="text-sm text-muted-foreground">建议: {t.suggestedCanonicalName}{t.suggestedAddress && ` · ${t.suggestedAddress}`}</div>
                  )}
                  {t.suggestedAliasesJson && (() => {
                    try { const a = JSON.parse(t.suggestedAliasesJson) as string[]; return a.length > 0 ? <div className="text-xs text-muted-foreground">别名: {a.join(", ")}</div> : null; } catch { return null; }
                  })()}
                  {t.suggestedSitesJson && (() => {
                    try { const s = JSON.parse(t.suggestedSitesJson) as Array<{ siteName: string }>; return s.length > 0 ? <div className="text-xs text-muted-foreground">院区: {s.map((x) => x.siteName).join(", ")}</div> : null; } catch { return null; }
                  })()}
                  {t.evidenceJson && (() => {
                    try { const e = JSON.parse(t.evidenceJson) as Array<{ title: string; url: string }>; return e.length > 0 ? <div className="text-xs text-muted-foreground">来源: {e.map((x, i) => <a key={i} href={x.url} target="_blank" rel="noopener noreferrer" className="underline mr-2">{x.title || x.url}</a>)}</div> : null; } catch { return null; }
                  })()}
                  <div className="text-xs text-muted-foreground">
                    {t.createdByUser && `提交: ${t.createdByUser.name} · `}
                    {new Date(t.createdAt).toLocaleString("zh-CN")}
                    {t.reviewedByUser && ` · 审核: ${t.reviewedByUser.name}`}
                  </div>
                  {t.reviewNote && <div className="text-xs text-muted-foreground">备注: {t.reviewNote}</div>}
                </div>
                {t.status === "PENDING" && (
                  <div className="flex items-center gap-1 shrink-0 flex-wrap justify-end">
                    <Button size="sm" variant="outline" onClick={() => {
                      setActiveTask(t);
                      setSelectedOrgId(t.suggestedOrg?.id || "");
                      setSelectedSiteId(t.suggestedSite?.id || "");
                      setReviewNote("");
                      setApproveMode("bind");
                      setApproveOpen(true);
                    }}>
                      <CheckCircle className="h-3 w-3 mr-1" />绑定已有
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => {
                      setActiveTask(t);
                      setSelectedOrgId("");
                      setSelectedSiteId("");
                      setReviewNote("");
                      setApproveMode("merge");
                      setApproveOpen(true);
                    }}>
                      <Building2 className="h-3 w-3 mr-1" />合并到已有
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => {
                      setActiveTask(t);
                      let aliases = "";
                      let sites: Array<{ siteName: string; address: string; siteType: string; tempId: string }> = [];
                      try {
                        if (t.suggestedAliasesJson) {
                          const a = JSON.parse(t.suggestedAliasesJson) as string[];
                          aliases = a.join(", ");
                        }
                      } catch { /* ignore */ }
                      try {
                        if (t.suggestedSitesJson) {
                          const s = JSON.parse(t.suggestedSitesJson) as Array<{ siteName: string; address?: string }>;
                          sites = s.filter((x) => x.siteName).map((x) => ({ siteName: x.siteName, address: x.address || "", siteType: "CAMPUS", tempId: crypto.randomUUID() }));
                        }
                      } catch { /* ignore */ }
                      if (sites.length === 0) sites = [{ siteName: "", address: "", siteType: "CAMPUS", tempId: crypto.randomUUID() }];
                      setNewOrg({ canonicalName: t.suggestedCanonicalName || t.rawInput, address: t.suggestedAddress || "", aliases, sites });
                      setReviewNote("");
                      setBindSiteTempId("");
                      setCreateMode("normal");
                      setCreateOpen(true);
                    }}>
                      <Plus className="h-3 w-3 mr-1" />新建机构
                    </Button>
                    <Button size="sm" variant="outline" className="text-amber-600 border-amber-200 hover:bg-amber-50" onClick={() => {
                      setActiveTask(t);
                      let aliases = "";
                      let sites: Array<{ siteName: string; address: string; siteType: string; tempId: string }> = [];
                      try {
                        if (t.suggestedAliasesJson) {
                          const a = JSON.parse(t.suggestedAliasesJson) as string[];
                          aliases = a.join(", ");
                        }
                      } catch { /* ignore */ }
                      try {
                        if (t.suggestedSitesJson) {
                          const s = JSON.parse(t.suggestedSitesJson) as Array<{ siteName: string; address?: string }>;
                          sites = s.filter((x) => x.siteName).map((x) => ({ siteName: x.siteName, address: x.address || "", siteType: "CAMPUS", tempId: crypto.randomUUID() }));
                        }
                      } catch { /* ignore */ }
                      if (sites.length === 0) sites = [{ siteName: "", address: "", siteType: "CAMPUS", tempId: crypto.randomUUID() }];
                      setNewOrg({ canonicalName: t.suggestedCanonicalName || t.rawInput, address: t.suggestedAddress || "", aliases, sites });
                      setReviewNote("");
                      setBindSiteTempId("");
                      setCreateMode("force");
                      setCreateOpen(true);
                    }}>
                      <Plus className="h-3 w-3 mr-1" />强制新建
                    </Button>
                    <Button size="sm" variant="ghost" className="text-red-600" onClick={() => {
                      setActiveTask(t);
                      setReviewNote("");
                      setRejectOpen(true);
                    }}>
                      <XCircle className="h-3 w-3 mr-1" />拒绝
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Approve: bind to existing org / merge to existing */}
      <Dialog open={approveOpen} onOpenChange={setApproveOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{approveMode === "merge" ? "合并到现有机构" : "绑定已有机构"}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">原始输入: <span className="font-medium text-foreground">{activeTask?.rawInput}</span></p>
            {approveMode === "merge" && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                合并操作将把当前申请直接关联到所选机构，并将原始输入记录为机构别名。
              </div>
            )}
            <div className="space-y-2">
              <Label>选择机构</Label>
              <OrganizationAdminSelect
                value={selectedOrgId}
                onChange={(org) => {
                  setSelectedOrgId(org?.id || "");
                  setSelectedSiteId("");
                }}
                placeholder="搜索并选择机构..."
              />
            </div>
            {selectedOrg && (
              <div className="rounded-md border bg-muted/30 p-3 space-y-1">
                <p className="text-xs text-muted-foreground">已选机构摘要</p>
                <p className="text-sm font-medium">
                  {selectedOrg.canonicalName}{" "}
                  <span className="text-xs text-muted-foreground font-normal">({selectedOrg.orgCode})</span>
                </p>
                {selectedOrg.address && <p className="text-xs text-muted-foreground">{selectedOrg.address}</p>}
                <p className="text-xs text-muted-foreground">{selectedOrg.sites.length} 个院区/分支</p>
              </div>
            )}
            {selectedOrg && selectedOrg.sites.length > 0 && (
              <div className="space-y-2">
                <Label>院区（可选）</Label>
                <Select value={selectedSiteId} onValueChange={(v) => setSelectedSiteId(v || "")}>
                  <SelectTrigger>
                    <SelectValue placeholder="不选择院区">
                      {selectedSiteId ? selectedOrg?.sites.find((s) => s.id === selectedSiteId)?.siteName || selectedSiteId : "不选择院区"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">不选择院区</SelectItem>
                    {selectedOrg.sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.siteName}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label>备注</Label>
              <Input value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} placeholder="可选" />
            </div>
            {/* 缺口2: TaxId verification for REP_ORG_REQUEST — try invoice API */}
            {activeTask?.sourceType === "REP_ORG_REQUEST" && (
              <div className="space-y-2">
                <Button variant="outline" size="sm" className="w-full" onClick={async () => {
                  if (!activeTask) return;
                  toast.info("正在查询发票 API...");
                  const res = await fetch(`/api/organization-reviews/${activeTask.id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "verifyTaxId" }),
                  });
                  const data = await res.json();
                  if (data.verified && data.invoiceInfo) {
                    toast.success(`税号验证成功: ${data.invoiceInfo.unitTaxNo}`);
                  } else {
                    toast.error("API 未命中，可手动填写或标记为无需开票");
                  }
                }}>
                  <Search className="mr-1 h-3 w-3" />验证税号（发票API）
                </Button>
              </div>
            )}
            <div className="flex gap-2">
              <Button className="flex-1" disabled={!selectedOrgId || approveMutation.isPending}
                onClick={() => activeTask && approveMutation.mutate({
                  id: activeTask.id, action: approveMode === "merge" ? "mergeToExisting" : "approve",
                  organizationId: selectedOrgId,
                  organizationSiteId: selectedSiteId || undefined,
                  reviewNote: reviewNote || undefined,
                })}
              >
                <CheckCircle className="mr-2 h-4 w-4" />
                {approveMutation.isPending ? "处理中..." : approveMode === "merge" ? "确认合并" : "确认绑定"}
              </Button>
              {activeTask?.sourceType === "REP_ORG_REQUEST" && (
                <Button variant="secondary" className="flex-1" disabled={!selectedOrgId || approveMutation.isPending}
                  onClick={() => activeTask && approveMutation.mutate({
                    id: activeTask.id, action: "markAsNonInvoice",
                    organizationId: selectedOrgId,
                    reviewNote: "标记为无需开票",
                  })}
                >
                  标记无需开票
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Approve and create new org */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-lg">
          <DialogHeader><DialogTitle>{createMode === "force" ? "强制新建机构（越过查重）" : "新建机构并绑定"}</DialogTitle></DialogHeader>
          <div className="-mx-4 min-h-0 overflow-y-auto px-4 pb-1">
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">原始输入: <span className="font-medium text-foreground break-words">{activeTask?.rawInput}</span></p>
            {createMode === "force" && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                ⚠️ 强制新建将越过名称查重保护直接创建机构，请确保已充分了解重复风险并填写备注。
              </div>
            )}
            <OrganizationAiFillPlugin
              query={newOrg.canonicalName || activeTask?.rawInput || ""}
              onApply={applyDraftToNewOrg}
              disabled={approveMutation.isPending}
            />
            <div className="space-y-2">
              <Label>标准名称 *</Label>
              <Input value={newOrg.canonicalName} onChange={(e) => setNewOrg({ ...newOrg, canonicalName: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>地址</Label>
              <Input value={newOrg.address} onChange={(e) => setNewOrg({ ...newOrg, address: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>别名（逗号分隔）</Label>
              <Input value={newOrg.aliases} onChange={(e) => setNewOrg({ ...newOrg, aliases: e.target.value })} placeholder="如: 浙一, 浙大附一" />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>院区/分支</Label>
                <Button type="button" variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setNewOrg({ ...newOrg, sites: [...newOrg.sites, { siteName: "", address: "", siteType: "CAMPUS", tempId: crypto.randomUUID() }] })}>
                  <Plus className="h-3 w-3 mr-1" />添加
                </Button>
              </div>
              {newOrg.sites.map((site, idx) => (
                <div key={site.tempId} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_90px_auto] sm:items-end">
                  <Input placeholder="名称" value={site.siteName} onChange={(e) => {
                    const sites = [...newOrg.sites];
                    sites[idx] = { ...sites[idx], siteName: e.target.value };
                    setNewOrg({ ...newOrg, sites });
                  }} />
                  <Input placeholder="地址" value={site.address} onChange={(e) => {
                    const sites = [...newOrg.sites];
                    sites[idx] = { ...sites[idx], address: e.target.value };
                    setNewOrg({ ...newOrg, sites });
                  }} />
                  <Select value={site.siteType || "CAMPUS"} onValueChange={(v) => {
                    const sites = [...newOrg.sites];
                    sites[idx] = { ...sites[idx], siteType: v || "CAMPUS" };
                    setNewOrg({ ...newOrg, sites });
                  }}>
                    <SelectTrigger className="w-[90px]">
                      <SelectValue placeholder="类型">{SITE_TYPE_LABELS[site.siteType] || "类型"}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {CRM_SITE_TYPES.map((st) => (<SelectItem key={st} value={st}>{SITE_TYPE_LABELS[st]}</SelectItem>))}
                    </SelectContent>
                  </Select>
                  {newOrg.sites.length > 1 && (
                    <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => {
                      const removed = newOrg.sites[idx];
                      if (removed && removed.tempId === bindSiteTempId) setBindSiteTempId("");
                      setNewOrg({ ...newOrg, sites: newOrg.sites.filter((_, i) => i !== idx) });
                    }}>
                      <XCircle className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
            {activeTask && (activeTask.sourceType === "CUSTOMER_CREATE" || activeTask.sourceType === "CUSTOMER_EDIT") && newOrg.sites.some((s) => s.siteName.trim()) && (
              <div className="space-y-2">
                <Label>绑定客户到院区（可选）</Label>
                <Select value={bindSiteTempId} onValueChange={(v) => setBindSiteTempId(v || "")}>
                  <SelectTrigger>
                    <SelectValue placeholder="不绑定院区">
                      {bindSiteTempId ? newOrg.sites.find((s) => s.tempId === bindSiteTempId)?.siteName.trim() || bindSiteTempId : "不绑定院区"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">不绑定院区</SelectItem>
                    {newOrg.sites.map((s) => s.siteName.trim() ? <SelectItem key={s.tempId} value={s.tempId}>{s.siteName.trim()}</SelectItem> : null)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label>备注</Label>
              <Input value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} placeholder="可选" />
            </div>
          </div>
          </div>
          <div className="-mx-4 -mb-4 border-t bg-popover/95 px-4 py-3">
            <Button className="w-full" disabled={!newOrg.canonicalName.trim() || approveMutation.isPending || (createMode === "force" && !reviewNote.trim())}
              onClick={() => activeTask && approveMutation.mutate({
                id: activeTask.id, action: createMode === "force" ? "approveForceNew" : "approveAndCreate",
                canonicalName: newOrg.canonicalName,
                address: newOrg.address || undefined,
                aliases: newOrg.aliases ? newOrg.aliases.split(",").map((a) => a.trim()).filter(Boolean) : undefined,
                sites: newOrg.sites
                  .map((s) => ({ siteName: s.siteName.trim(), address: s.address.trim(), siteType: s.siteType || "CAMPUS" }))
                  .filter((s) => s.siteName),
                bindSiteName: bindSiteTempId ? newOrg.sites.find((s) => s.tempId === bindSiteTempId)?.siteName.trim() : undefined,
                reviewNote: reviewNote || undefined,
              })}
            >
              <Plus className="mr-2 h-4 w-4" />
              {approveMutation.isPending ? "处理中..." : createMode === "force" ? "强制新建并绑定" : "新建并绑定"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Reject */}
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>拒绝复核</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">原始输入: <span className="font-medium text-foreground">{activeTask?.rawInput}</span></p>
            <div className="space-y-2">
              <Label>拒绝原因</Label>
              <Input value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} placeholder="可选" />
            </div>
            <Button variant="destructive" className="w-full" disabled={approveMutation.isPending}
              onClick={() => activeTask && approveMutation.mutate({
                id: activeTask.id, action: "reject",
                reviewNote: reviewNote || undefined,
              })}
            >
              <XCircle className="mr-2 h-4 w-4" />
              {approveMutation.isPending ? "处理中..." : "确认拒绝"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}