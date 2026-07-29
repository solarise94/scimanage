"use client";

import { useState, useEffect, useRef } from "react";
import { FormSheet } from "@/components/ui/form-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { OrganizationSelect } from "@/components/organization-select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { crmKeys } from "@/lib/crm/query-keys";
import { CRM_PERSON_CATEGORIES, PERSON_CATEGORY_LABELS } from "@/lib/crm/constants";
import { toast } from "sonner";
import { Pencil, Loader2, AlertCircle } from "lucide-react";

interface CustomerEditForm {
  name: string;
  principal: string;
  email: string;
  wechat: string;
  organization: string;
  organizationId: string;
  organizationSiteId: string;
  organizationRawInput: string;
  address: string;
  miniProgramId: string;
  labOrGroup: string;
  personCategory: string;
  jobTitle: string;
  graduationDate: string;
}

const emptyForm: CustomerEditForm = {
  name: "", principal: "", email: "", wechat: "",
  organization: "", organizationId: "", organizationSiteId: "",
  organizationRawInput: "", address: "", miniProgramId: "",
  labOrGroup: "", personCategory: "", jobTitle: "", graduationDate: "",
};

interface OrgResolveResult {
  status: "exact" | "candidate" | "unmatched";
  organizationId: string | null;
  organizationSiteId: string | null;
  canonicalName: string | null;
  address: string | null;
}

interface InitialCustomer {
  id: string;
  name?: string | null;
  customerCode?: string | null;
  principal?: string | null;
  email?: string | null;
  wechat?: string | null;
  organization?: string | null;
  organizationId?: string | null;
  organizationSiteId?: string | null;
  organizationRawInput?: string | null;
  address?: string | null;
  miniProgramId?: string | null;
  labOrGroup?: string | null;
  phone?: string | null;
}

export function CustomerEditDialog({
  profileId: profileIdProp,
  initialCustomer,
  open,
  onOpenChange,
  canEdit,
}: {
  /** CRM Profile ID（Phase D 主键）。 */
  profileId: string;
  initialCustomer: InitialCustomer | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
}) {
  const [form, setForm] = useState<CustomerEditForm>(emptyForm);
  const [original, setOriginal] = useState<CustomerEditForm>(emptyForm);
  const [loading, setLoading] = useState(false);
  const [orgResolveStatus, setOrgResolveStatus] = useState<"exact" | "candidate" | "unmatched" | null>(null);
  const [orgResolving, setOrgResolving] = useState(false);
  const orgResolveAbortRef = useRef<AbortController | null>(null);
  const queryClient = useQueryClient();

  const resolvedProfileId = profileIdProp;

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
    enabled: !!form.organizationId && open && canEdit,
    retry: false,
  });
  const orgSites = orgSitesData?.sites || [];

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

  async function applyOrgResolution(rawName: string) {
    if (!rawName.trim()) return;
    const nextRawName = rawName.trim();

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
          // 非精确匹配：保留原始输入，但 organization 仍为 raw 用于展示待处理态；保存时会被拦截。
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
    } finally {
      if (orgResolveAbortRef.current === controller) {
        setOrgResolving(false);
      }
    }
  }

  function handleOrgSelect(id: string | null, name: string, address?: string | null) {
    if (id) {
      setForm((prev) => ({
        ...prev,
        organization: name,
        organizationId: id,
        organizationSiteId: "",
        // 保留历史原始输入作为只读快照；仅当之前没有原始输入时才记录当前 canonical 为历史。
        organizationRawInput: prev.organizationRawInput || name,
        address: address || prev.address,
      }));
      setOrgResolveStatus(null);
      return;
    }

    if (name.trim()) {
      void applyOrgResolution(name);
      return;
    }

    setForm((prev) => ({
      ...prev,
      organization: "",
      organizationId: "",
      organizationSiteId: "",
      organizationRawInput: "",
    }));
    setOrgResolveStatus(null);
  }

  useEffect(() => {
    if (!open || !resolvedProfileId || !canEdit) return;
    let cancelled = false;

    void (async () => {
      setLoading(true);
      try {
        // Phase D：优先按 profileId 加载。
        const directRes = await fetch(`/api/crm/profiles/${encodeURIComponent(resolvedProfileId)}`);
        if (!directRes.ok) {
          const listPayload = await directRes.json().catch(() => ({}));
          throw new Error(listPayload.error || "加载 CRM 档案失败");
        }
        const payload = await directRes.json();
        const pf: {
          id: string;
          personCategory?: string | null;
          jobTitle?: string | null;
          graduationDate?: string | null;
          customerView?: Record<string, string | null | undefined>;
        } | null = payload.profile ?? null;
        if (!pf) {
          throw new Error("未找到 CRM 档案，无法编辑客户主权字段");
        }
        const cv = pf.customerView || {};
        const f: CustomerEditForm = {
          name: cv.name || initialCustomer?.name || "",
          principal: cv.principal || "",
          email: cv.email || "",
          wechat: cv.wechat || "",
          organization: cv.organization || "",
          organizationId: cv.organizationId || "",
          organizationSiteId: cv.organizationSiteId || "",
          organizationRawInput: cv.organizationRawInput || cv.organization || "",
          address: cv.address || "",
          miniProgramId: cv.miniProgramId || "",
          labOrGroup: cv.labOrGroup || "",
          personCategory: pf.personCategory || "",
          jobTitle: pf.jobTitle || "",
          graduationDate: pf.graduationDate ? String(pf.graduationDate).slice(0, 10) : "",
        };
        setForm(f);
        setOriginal(f);
        setOrgResolveStatus(null);
      } catch (error) {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : "加载客户信息失败");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      orgResolveAbortRef.current?.abort();
    };
  }, [open, resolvedProfileId, canEdit, initialCustomer]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!canEdit) {
        throw new Error("无权限编辑此客户");
      }
      const targetProfileId = resolvedProfileId;
      if (!targetProfileId) {
        throw new Error("缺少客户档案 ID");
      }

      const customerFields: (keyof CustomerEditForm)[] = ["name", "principal", "email", "wechat", "organization", "organizationId", "organizationSiteId", "organizationRawInput", "address", "miniProgramId", "labOrGroup"];
      const profileFields: (keyof CustomerEditForm)[] = ["personCategory", "jobTitle", "graduationDate"];

      const patch: Record<string, string | null> = {};
      for (const key of [...customerFields, ...profileFields]) {
        if (form[key] !== original[key]) patch[key] = form[key] || null;
      }

      if (Object.keys(patch).length === 0) {
        onOpenChange(false);
        return;
      }

      // 机构字段 sovereignty：非空单位文本必须已解析为精确匹配，禁止保存漂移文本。
      const orgTouched =
        patch.organization !== undefined ||
        patch.organizationId !== undefined ||
        patch.organizationSiteId !== undefined ||
        patch.organizationRawInput !== undefined;
      if (orgTouched && form.organization.trim() && !form.organizationId) {
        throw new Error("客户单位未精确匹配，请从列表选择或创建单位后再保存");
      }

      if (patch.name === null || patch.name === "") {
        throw new Error("客户姓名不能为空");
      }

      const res = await fetch(`/api/crm/profiles/${targetProfileId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = await res.json();
        const msg = data.error || "保存失败";
        if (res.status === 403) {
          throw new Error(msg === "只能编辑自己负责的客户" ? msg : "无权限编辑此客户");
        }
        throw new Error(msg);
      }

      return true;
    },
    onSuccess: async (data) => {
      if (data) {
        toast.success("客户信息已更新");
        const idForInvalidate = resolvedProfileId;
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: crmKeys.profiles() }),
          queryClient.invalidateQueries({ queryKey: crmKeys.profile(idForInvalidate) }),
          queryClient.invalidateQueries({ queryKey: crmKeys.customers() }),
          queryClient.invalidateQueries({ queryKey: crmKeys.customersList() }),
          queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string)?.startsWith("crm-relations") }),
        ]);
      }
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const showOrgPending = orgResolveStatus && orgResolveStatus !== "exact" && form.organization.trim();

  return (
    <FormSheet
      open={open}
      onOpenChange={(val) => {
        if (!val) {
          setForm(emptyForm);
          setOriginal(emptyForm);
          setOrgResolveStatus(null);
          setOrgResolving(false);
          orgResolveAbortRef.current?.abort();
        }
        onOpenChange(val);
      }}
      title="编辑客户信息"
      desktopVariant="plain"
      desktopMaxW="sm:max-w-lg"
    >
      {!canEdit ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          当前角色不可编辑客户主数据。
        </div>
      ) : loading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          加载中...
        </div>
      ) : (
        <form
          onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }}
          className="space-y-4"
        >
          <div className="border-b pb-2 mb-2">
            <h4 className="text-sm font-medium text-muted-foreground">客户主数据</h4>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>客户姓名 *</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>电话/手机号</Label>
              <Input
                value={form.principal}
                onChange={(e) =>
                  setForm({ ...form, principal: e.target.value })
                }
                placeholder="订单自动代入使用客户主数据电话和微信"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              <p className="text-xs text-warning">
                未在单位主数据中精确匹配，请从列表选择或创建单位，禁止保存漂移文本。
              </p>
            )}
            {orgSitesError instanceof Error && (
              <p className="text-xs text-destructive">{orgSitesError.message}</p>
            )}
            {(form.organizationRawInput || form.organization) && (
              <div className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
                <span className="font-medium">原始输入/历史文本：</span>
                {form.organizationRawInput || form.organization}
              </div>
            )}
          </div>
          {form.organizationId && orgSites.length > 0 && (
            <div className="space-y-2">
              <Label>院区/学院/大楼</Label>
              <Select value={form.organizationSiteId || "__none__"} onValueChange={(v) => setForm({ ...form, organizationSiteId: (v === "__none__" || v === null) ? "" : v })}>
                <SelectTrigger>
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
          <div className="space-y-2">
            <Label>通讯地址</Label>
            <Input
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>小程序 ID</Label>
            <Input
              value={form.miniProgramId}
              onChange={(e) =>
                setForm({ ...form, miniProgramId: e.target.value })
              }
            />
          </div>
          <div className="space-y-2">
            <Label>课题组/实验室</Label>
            <Input
              placeholder="例如：朱雪琼课题 507"
              value={form.labOrGroup}
              onChange={(e) => setForm({ ...form, labOrGroup: e.target.value })}
            />
          </div>
          <div className="border-b pb-2 mb-2 mt-4">
            <h4 className="text-sm font-medium text-muted-foreground">CRM 补充信息</h4>
          </div>
          <div className="space-y-2">
            <Label>人员分类</Label>
            <Select value={form.personCategory || "__none__"} onValueChange={(v) => { if (v) setForm({ ...form, personCategory: v === "__none__" ? "" : v }); }}>
              <SelectTrigger>
                <SelectValue placeholder="选择人员分类（可选）">
                  {form.personCategory ? PERSON_CATEGORY_LABELS[form.personCategory] || form.personCategory : "选择人员分类（可选）"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">不设置</SelectItem>
                {CRM_PERSON_CATEGORIES.map((pc) => (
                  <SelectItem key={pc} value={pc}>{PERSON_CATEGORY_LABELS[pc]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>职务/身份</Label>
            <Input
              placeholder="例如：教授、博士生、实验员"
              value={form.jobTitle}
              onChange={(e) => setForm({ ...form, jobTitle: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>毕业日期提醒</Label>
            <Input
              type="date"
              value={form.graduationDate}
              onChange={(e) => setForm({ ...form, graduationDate: e.target.value })}
            />
          </div>
          <Button
            type="submit"
            className="w-full"
            disabled={mutation.isPending}
          >
            <Pencil className="mr-2 h-4 w-4" />
            {mutation.isPending ? "保存中..." : "保存修改"}
          </Button>
        </form>
      )}
    </FormSheet>
  );
}
