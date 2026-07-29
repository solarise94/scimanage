"use client";

import * as React from "react";
import { useState, useRef } from "react";
import { FormSheet } from "@/components/ui/form-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { OrganizationSelect } from "@/components/organization-select";
import { CrmVoiceInput } from "@/components/crm/crm-voice-input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { crmKeys } from "@/lib/crm/query-keys";
import { toast } from "sonner";
import { UserPlus, MapPin, Wand2, Loader2, AlertCircle, ExternalLink } from "lucide-react";
import Link from "next/link";

interface OrgResolveResult {
  status: "exact" | "candidate" | "unmatched";
  organizationId: string | null;
  organizationSiteId: string | null;
  canonicalName: string | null;
  address: string | null;
}

const emptyForm = {
  name: "",
  principal: "",
  email: "",
  wechat: "",
  organization: "",
  organizationId: "",
  organizationSiteId: "",
  organizationRawInput: "",
  address: "",
  miniProgramId: "",
  notes: "",
  locationLat: null as number | null,
  locationLng: null as number | null,
  locationAddress: "" as string,
};

export function CustomerApplicationFormDialog({ trigger }: { trigger?: React.ReactElement<{ onClick?: React.MouseEventHandler<HTMLElement> }> }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [aiInput, setAiInput] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [orgResolveStatus, setOrgResolveStatus] = useState<"exact" | "candidate" | "unmatched" | null>(null);
  const [orgResolving, setOrgResolving] = useState(false);
  const orgResolveAbortRef = useRef<AbortController | null>(null);

  const { data: orgSitesData, error: orgSitesError } = useQuery<{ sites: { id: string; siteName: string; siteType: string }[] }>({
    queryKey: ["organization-sites", form.organizationId],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${form.organizationId}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "加载院区列表失败");
      }
      return { sites: data.organization?.sites || [] };
    },
    enabled: !!form.organizationId && open,
    retry: false,
  });
  const orgSites = orgSitesData?.sites || [];

  // Duplicate candidate state
  const [dupCandidates, setDupCandidates] = useState<Array<{
    id: string; name: string; customerCodeLast6: string;
    organization: string | null; hasCrmProfile: boolean; matchReasons: string[];
    matchedName?: string; matchedNameType?: string;
  }> | null>(null);

  const mutation = useMutation({
    mutationFn: async (override?: { duplicateDecision: string }) => {
      const body = override ? { ...form, ...override } : form;
      const res = await fetch("/api/crm/customer-applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.status === 409 && data.code === "DUPLICATE_CANDIDATES") {
        return { duplicateCandidates: data.candidates };
      }
      if (!res.ok) {
        throw new Error(data.error || "提交失败");
      }
      return data;
    },
    onSuccess: (data: { duplicateCandidates?: unknown[]; application?: unknown }) => {
      if (data.duplicateCandidates) {
        setDupCandidates(data.duplicateCandidates as Array<{
          id: string; name: string; customerCodeLast6: string;
          organization: string | null; hasCrmProfile: boolean; matchReasons: string[];
          matchedName?: string; matchedNameType?: string;
        }>);
        return;
      }
      toast.success("客户已创建，主管将进行复核");
      queryClient.invalidateQueries({ queryKey: crmKeys.customerApplications() });
      setOpen(false);
      setForm({ ...emptyForm });
      setAiInput("");
      setOrgResolveStatus(null);
      setDupCandidates(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  /** Resolve an org name against master data. Does NOT create new orgs. */
  async function resolveOrgName(rawName: string, signal?: AbortSignal): Promise<OrgResolveResult> {
    try {
      const res = await fetch("/api/organizations/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: rawName }),
        signal,
      });
      if (!res.ok) throw new Error("resolve failed");
      return await res.json();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      return { status: "unmatched", organizationId: null, organizationSiteId: null, canonicalName: null, address: null };
    }
  }

  /** Apply org resolution result to form: exact → fill IDs + canonical name; otherwise → keep raw text, mark pending. */
  async function applyOrgResolution(rawName: string, opts?: { onlyIfEmpty?: boolean }) {
    if (!rawName.trim()) return;
    if (opts?.onlyIfEmpty && form.organization?.trim()) return;
    const nextRawName = rawName.trim();

    // Cancel any in-flight resolution to prevent stale responses from overwriting newer input
    orgResolveAbortRef.current?.abort();
    const controller = new AbortController();
    orgResolveAbortRef.current = controller;

    setForm((prev) => ({
      ...prev,
      organization: nextRawName,
      organizationId: "",
      organizationSiteId: "",
      organizationRawInput: nextRawName,
    }));
    setOrgResolveStatus(null);
    setOrgResolving(true);
    try {
      const result = await resolveOrgName(nextRawName, controller.signal);

      setForm((prev) => {
        const next = { ...prev };
        if (result.status === "exact" && result.organizationId && result.canonicalName) {
          next.organization = result.canonicalName;
          next.organizationId = result.organizationId;
          next.organizationSiteId = result.organizationSiteId || "";
          next.organizationRawInput = nextRawName;
          if (!prev.address?.trim() && result.address) {
            next.address = result.address;
          }
        } else {
          // candidate or unmatched: keep raw text, don't auto-create
          next.organization = nextRawName;
          next.organizationId = "";
          next.organizationSiteId = "";
          next.organizationRawInput = nextRawName;
        }
        return next;
      });

      setOrgResolveStatus(result.status === "exact" ? null : result.status);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      // Network/server errors already handled in resolveOrgName returning unmatched
    } finally {
      // Only clear loading if this controller is still the active one
      if (orgResolveAbortRef.current === controller) {
        setOrgResolving(false);
      }
    }
  }

  /** Handle OrganizationSelect change — user explicitly chose, so we trust the selection. */
  function handleOrgSelect(id: string | null, name: string) {
    if (id) {
      // User selected from list: trust it
      setForm((prev) => ({
        ...prev,
        organization: name,
        organizationId: id,
        organizationSiteId: "",
        organizationRawInput: "",
      }));
      setOrgResolveStatus(null);
    } else if (name.trim()) {
      // Free-text input (rep mode): resolve against master data
      applyOrgResolution(name);
    } else {
      setForm((prev) => ({ ...prev, organization: "", organizationId: "", organizationSiteId: "", organizationRawInput: "" }));
      setOrgResolveStatus(null);
    }
  }

  async function handleAiFill() {
    if (!aiInput.trim()) return;
    setAiLoading(true);
    try {
      const res = await fetch("/api/plugins/form-draft/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pluginKey: "project.auto-draft",
          formKey: "customer.create",
          input: aiInput.trim(),
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "AI 填充失败");
      }
      const data = await res.json();
      const fields = data?.result?.draft?.fields as Record<string, unknown> | undefined;
      if (!fields || Object.keys(fields).length === 0) { toast.warning("AI 未能提取到有效字段"); return; }

      // Gather org name from AI result (may be string or { name, id, address } object)
      let aiOrgName = "";
      const orgVal = fields.organization;
      if (orgVal && typeof orgVal === "object" && !Array.isArray(orgVal)) {
        const org = orgVal as Record<string, unknown>;
        if (typeof org.name === "string" && org.name.trim()) aiOrgName = org.name.trim();
      } else if (typeof orgVal === "string" && orgVal.trim()) {
        aiOrgName = orgVal.trim();
      }

      // Fill string fields (only empty ones)
      setForm((prev) => {
        const next = { ...prev };
        const stringKeys: (keyof typeof emptyForm)[] = ["name", "principal", "email", "wechat", "address", "miniProgramId", "notes"];
        for (const key of stringKeys) {
          if (key === "organization") continue;
          const current = prev[key];
          if (current && (typeof current === "string" && current.trim())) continue;
          const val = fields[key];
          if (typeof val === "string" && val.trim()) {
            (next as Record<string, unknown>)[key] = val.trim();
          }
        }
        return next;
      });

      // Resolve org name through master data — never auto-create from AI
      if (aiOrgName) {
        await applyOrgResolution(aiOrgName);
      }

      toast.success("AI 已填充空字段");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "AI 填充失败");
    } finally {
      setAiLoading(false);
    }
  }

  async function handleLocate() {
    if (!navigator.geolocation) {
      toast.error("浏览器不支持定位");
      return;
    }
    setLocating(true);
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 15000, maximumAge: 60000 });
      });
      const { latitude: lat, longitude: lng } = pos.coords;
      const res = await fetch("/api/crm/maps/reverse-geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lng }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "定位失败");
      }
      const data = await res.json();
      const r = data.result as { address?: string; formattedAddress?: string; pois?: Array<{ name?: string }> } | undefined;
      if (!r) { toast.warning("未获取到位置信息"); return; }

      setForm((prev) => {
        const next = { ...prev };
        next.locationLat = lat;
        next.locationLng = lng;
        next.locationAddress = r.formattedAddress || r.address || "";
        if (!prev.address?.trim()) {
          next.address = r.formattedAddress || r.address || "";
        }
        return next;
      });

      // Resolve POI name against master data — never auto-create from location
      if (!form.organization?.trim() && r.pois?.length) {
        const poiName = r.pois[0].name?.trim();
        if (poiName) {
          await applyOrgResolution(poiName);
        }
      }

      toast.success("已获取位置信息");
    } catch (err) {
      if (err instanceof GeolocationPositionError) {
        toast.error(err.code === err.PERMISSION_DENIED ? "定位权限被拒绝" : err.code === err.TIMEOUT ? "定位超时" : "定位失败");
      } else {
        toast.error(err instanceof Error ? err.message : "定位失败");
      }
    } finally {
      setLocating(false);
    }
  }

  function handleVoiceTranscribed(text: string) {
    setForm((prev) => ({
      ...prev,
      notes: prev.notes ? `${prev.notes}\n${text}` : text,
    }));
  }

  const showOrgPending = orgResolveStatus && orgResolveStatus !== "exact" && form.organization?.trim();

  return (
    <>
      {trigger ? (
        React.cloneElement(trigger, {
          onClick: (e: React.MouseEvent<HTMLElement>) => {
            setOpen(true);
            trigger.props.onClick?.(e);
          },
        })
      ) : (
        <Button onClick={() => setOpen(true)}>
          <UserPlus className="h-4 w-4 mr-1" />申请新增客户
        </Button>
      )}
      <FormSheet
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) {
            setForm({ ...emptyForm });
            setAiInput("");
            setOrgResolveStatus(null);
            setDupCandidates(null);
          }
        }}
        title="申请新增客户"
        desktopVariant="scrollable"
        desktopMaxW="sm:max-w-lg"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!form.name.trim()) return;
            if (orgResolving) {
              toast.warning("单位正在匹配，请稍后再提交");
              return;
            }
            if (!form.organizationId) {
              toast.error("请先选择已绑定单位，或提交单位绑定申请后再新增客户");
              return;
            }
            mutation.mutate(undefined);
          }}
          className="space-y-4"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>客户姓名 *</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>课题组负责人</Label>
              <Input
                value={form.principal}
                onChange={(e) => setForm({ ...form, principal: e.target.value })}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>邮箱</Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>微信</Label>
              <Input
                value={form.wechat}
                onChange={(e) => setForm({ ...form, wechat: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label>客户单位</Label>
              {orgResolving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
              {showOrgPending && (
                <Badge variant="secondary" className="text-xs bg-warning-bg text-warning">
                  <AlertCircle className="h-3 w-3 mr-0.5" />
                  待确认
                </Badge>
              )}
            </div>
            <OrganizationSelect
              value={form.organizationId}
              displayValue={form.organization || undefined}
              onChange={handleOrgSelect}
            />
            {showOrgPending && (
              <p className="text-xs text-muted-foreground">
                未在单位主数据中精确匹配。请在选择器中选中已有单位，或先提交单位绑定/快速添加后再申请客户。
              </p>
            )}
            {orgSitesError instanceof Error && (
              <p className="text-xs text-destructive">{orgSitesError.message}</p>
            )}
            {form.organizationId && orgSites.length > 0 && (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">院区/学院/大楼</Label>
                <Select value={form.organizationSiteId || "__none__"} onValueChange={(v) => setForm({ ...form, organizationSiteId: (v === "__none__" || v === null) ? "" : v })}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder="不选择（可选）">
                      {form.organizationSiteId ? orgSites.find((s) => s.id === form.organizationSiteId)?.siteName || form.organizationSiteId : "不选择（可选）"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">不选择</SelectItem>
                    {orgSites.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.siteName} ({s.siteType})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>通讯地址</Label>
              <Button type="button" variant="ghost" size="sm" onClick={handleLocate} disabled={locating}>
                {locating ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <MapPin className="mr-1 h-3 w-3" />}
                定位填充
              </Button>
            </div>
            <Input
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>小程序 ID</Label>
            <Input
              value={form.miniProgramId}
              onChange={(e) => setForm({ ...form, miniProgramId: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>备注</Label>
              <CrmVoiceInput onTranscribed={handleVoiceTranscribed} />
            </div>
            <Textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="申请说明或其他备注信息"
              rows={3}
            />
          </div>

          {/* AI fast-fill section */}
          <div className="border rounded-lg p-3 space-y-2 bg-muted/30">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Wand2 className="h-4 w-4" />
              <span>AI 快速填表</span>
            </div>
            <Textarea
              value={aiInput}
              onChange={(e) => setAiInput(e.target.value)}
              placeholder="粘贴客户信息或描述，AI 将自动填充空字段..."
              rows={2}
              className="text-sm"
            />
            <Button type="button" variant="outline" size="sm" onClick={handleAiFill} disabled={aiLoading || !aiInput.trim()}>
              {aiLoading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Wand2 className="mr-1 h-3.5 w-3.5" />}
              AI 填充空字段
            </Button>
          </div>

          {dupCandidates && dupCandidates.length > 0 && (
            <div className="bg-warning-bg border border-warning-border rounded-lg p-3 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-warning">
                <AlertCircle className="h-4 w-4" />
                检测到 {dupCandidates.length} 个可能重复的客户
              </div>
              <div className="space-y-2 max-h-40 overflow-y-auto">
                {dupCandidates.map((c) => (
                  <div key={c.id} className="bg-card rounded-lg border p-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{c.name}</span>
                      <span className="text-xs text-muted-foreground">...{c.customerCodeLast6}</span>
                    </div>
                    {c.matchedName && (
                      <div className="text-xs text-amber-700 mt-0.5">
                        {c.matchedNameType === "MERGED_NAME"
                          ? "合并历史姓名"
                          : c.matchedNameType === "FORMER_NAME"
                            ? "曾用名"
                            : c.matchedNameType === "COMMON"
                              ? "常用称呼"
                              : "正式姓名"}
                        ：{c.matchedName}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground">
                      {c.organization && <span>{c.organization}</span>}
                      {c.hasCrmProfile && <Badge variant="secondary" className="ml-1 text-xs">已有CRM</Badge>}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {c.matchReasons.map((r, i) => (
                        <Badge key={i} variant="secondary" className="text-xs">{r}</Badge>
                      ))}
                    </div>
                    <Link
                      href={`/crm/customers/${c.id}`}
                      target="_blank"
                      className="inline-flex items-center gap-0.5 text-xs text-primary hover:underline mt-1"
                    >
                      查看已有客户 <ExternalLink className="h-3 w-3" />
                    </Link>
                  </div>
                ))}
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => {
                    setDupCandidates(null);
                    setOpen(false);
                  }}
                >
                  取消，去客户档案库查看
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="flex-1"
                  disabled={mutation.isPending}
                  onClick={() => {
                    mutation.mutate({ duplicateDecision: "CREATE_NEW" });
                  }}
                >
                  {mutation.isPending ? "提交中..." : "这是新客户，继续创建"}
                </Button>
              </div>
            </div>
          )}

          {!dupCandidates && (
            <Button type="submit" className="w-full" disabled={mutation.isPending || !form.name.trim()}>
              {mutation.isPending ? "提交中..." : "提交申请"}
            </Button>
          )}
        </form>
      </FormSheet>
    </>
  );
}
