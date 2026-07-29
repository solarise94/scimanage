"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Plus, Loader2, Copy, Trash2, FileDown, Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { OrganizationSelect } from "@/components/organization-select";
import { toast } from "sonner";
import { TaxIdLookupInput } from "@/components/tax-id-lookup-input";
import { InvoicePreviewCard } from "@/components/finance/invoice-preview-card";
import { sheetDataFromForm, type InvoiceSheetData } from "@/lib/invoice-sheet";
import { exportInvoiceSheetToPdf } from "@/lib/export-invoice-pdf";
import { yuanToCents, bankerRound } from "@/lib/finance/money";
import { useMediaQuery } from "@/hooks/use-media-query";

export interface InvoiceItem {
  id?: string;
  itemName: string;
  spec: string;
  unit: string;
  quantity: string;
  amount: string;
}

export interface InvoiceRecord {
  id: string;
  contactName: string | null;
  projectCode: string | null;
  sellerProfileId: string | null;
  sellerName: string | null;
  sellerTaxId: string | null;
  sellerBankName: string | null;
  sellerBankAccount: string | null;
  sellerAddress: string | null;
  sellerPhone: string | null;
  buyerOrganizationId: string | null;
  buyerOrganizationName: string;
  buyerTaxId: string | null;
  buyerTaxIdFromLookup: boolean;
  invoiceType: string;
  contentSummary: string | null;
  totalAmount: number;
  status: string;
  remark: string | null;
  createdAt: string;
  createdBy: { id: string; name: string };
  items: Array<{
    id: string;
    itemName: string;
    spec: string | null;
    unit: string | null;
    quantity: number | null;
    amount: number;
  }>;
}

interface BillingProfile {
  id: string;
  name: string;
  taxId: string | null;
  bankName: string | null;
  bankAccount: string | null;
  address: string | null;
  phone: string | null;
  isDefault: boolean;
  archived?: boolean;
}

export interface InvoiceFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingInvoice: InvoiceRecord | null;
  editingInvoiceId?: string | null;
  mode?: "create" | "edit";
  createUrl: string;
  patchUrlPrefix: string;
  onSuccess: () => void;
  defaultValues?: Partial<{
    contactName: string;
    projectCode: string;
    buyerOrgId: string;
    buyerOrgName: string;
    buyerTaxId: string;
    invoiceType: string;
    contentSummary: string;
    remark: string;
    items: InvoiceItem[];
  }>;
  showProjectCode?: boolean;
  aiDraftUrl?: string | null;
  extraPayload?: Record<string, unknown>;
  reissueFromInvoiceId?: string | null;
  reissueReason?: string | null;
}

const emptyItem = (): InvoiceItem => ({
  itemName: "", spec: "", unit: "", quantity: "", amount: "",
});

function formatAmount(n: number): string {
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface CoverageAllocation {
  orderId: string;
  amountCents: number;
}

/**
 * 同步 basket 带来的 coverageAllocations 与当前发票明细总额。
 *
 * 用户在弹窗内编辑明细后，发票总额可能变化。若直接提交原 coverageAllocations，
 * 后端会因 "coverage 合计 != 发票金额" 拒绝。这里按原各订单占比重新分摊当前总额，
 * 并保证每项为正、合计严格等于 totalAmountCents。
 */
function normalizeCoverageAllocations(
  allocations: CoverageAllocation[],
  totalAmountCents: number,
): CoverageAllocation[] | undefined {
  if (!allocations || allocations.length === 0) return undefined;
  if (totalAmountCents <= 0) return undefined;

  const currentSum = allocations.reduce((s, a) => s + (Number(a.amountCents) || 0), 0);
  if (currentSum === totalAmountCents) return allocations;
  if (currentSum <= 0) {
    // 退化情况：把全部金额归属到第一个订单，后端会再次校验其剩余额度。
    return [{ ...allocations[0], amountCents: totalAmountCents }];
  }

  // 按当前占比缩放并取整，然后吸收尾差。
  let scaled = allocations.map((a) => ({
    orderId: a.orderId,
    amountCents: Math.max(1, bankerRound((Number(a.amountCents) || 0) * totalAmountCents / currentSum)),
  }));

  const scaledSum = scaled.reduce((s, a) => s + a.amountCents, 0);
  let diff = totalAmountCents - scaledSum;
  if (diff !== 0) {
    // 从最后一项开始逐块调整，优先保持正值。
    scaled = [...scaled];
    for (let i = scaled.length - 1; i >= 0 && diff !== 0; i--) {
      const delta = diff > 0 ? 1 : -1;
      if (diff < 0 && scaled[i].amountCents <= 1) continue;
      scaled[i] = { ...scaled[i], amountCents: scaled[i].amountCents + delta };
      diff -= delta;
    }
  }

  return scaled;
}

/** 将外部传入的 extraPayload 中的 coverageAllocations 同步到当前发票总额。 */
function buildNormalizedExtraPayload(
  extraPayload: Record<string, unknown> | undefined,
  totalAmountCents: number,
): Record<string, unknown> {
  const base = extraPayload || {};
  const allocs = Array.isArray(base.coverageAllocations)
    ? (base.coverageAllocations as CoverageAllocation[])
    : null;
  if (!allocs || allocs.length === 0) return base;
  const normalized = normalizeCoverageAllocations(allocs, totalAmountCents);
  if (!normalized) {
    return Object.fromEntries(Object.entries(base).filter(([k]) => k !== "coverageAllocations"));
  }
  return { ...base, coverageAllocations: normalized };
}

export function buildPreviewText(form: {
  contactName: string;
  projectCode: string;
  sellerName: string;
  sellerTaxId: string;
  sellerBankInfo: string;
  buyerOrgName: string;
  buyerTaxId: string;
  invoiceType: string;
  contentSummary: string;
  remark: string;
  items: InvoiceItem[];
}): string {
  const lines: string[] = [];
  if (form.contactName) lines.push(form.contactName);
  if (form.projectCode) lines.push(`项目编号：${form.projectCode}`);
  if (form.sellerName) lines.push(`开票方：${form.sellerName}`);
  if (form.sellerTaxId) lines.push(`开票方税号：${form.sellerTaxId}`);
  if (form.sellerBankInfo) lines.push(`开票方开户行及账号：${form.sellerBankInfo}`);
  if (form.buyerOrgName) lines.push(`对方公司名称：${form.buyerOrgName}`);
  if (form.buyerTaxId) lines.push(`统一社会信用代码/纳税人识别号：${form.buyerTaxId}`);
  if (form.contentSummary) lines.push(`开票内容：${form.contentSummary}`);
  const total = form.items.reduce((s, it) => s + (parseFloat(it.amount) || 0), 0);
  if (total > 0) lines.push(`金额：${formatAmount(total)}`);
  lines.push(`普票/专票：${form.invoiceType === "SPECIAL" ? "专票" : "普票"}`);
  for (const it of form.items) {
    if (!it.itemName.trim()) continue;
    const parts: string[] = [`项目名称：${it.itemName}`];
    if (it.spec) parts.push(`规格：${it.spec}`);
    if (it.unit) parts.push(`单位：${it.unit}`);
    if (it.quantity) parts.push(`数量：${it.quantity}`);
    if (it.amount) parts.push(`金额：${it.amount}`);
    lines.push(parts.join("；"));
  }
  if (form.remark) lines.push(`备注：${form.remark}`);
  return lines.join("\n");
}

export function InvoiceFormDialog({
  open, onOpenChange, editingInvoice, editingInvoiceId, mode = "create",
  createUrl, patchUrlPrefix, onSuccess, defaultValues, showProjectCode = true,
  aiDraftUrl, extraPayload, projectName, projectContent,
  reissueFromInvoiceId, reissueReason,
}: InvoiceFormDialogProps & { projectName?: string; projectContent?: string }) {
  const isLoadingEdit = mode === "edit" && !editingInvoice;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <>
          {isLoadingEdit ? (
            <DialogContent className="sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>加载发票详情…</DialogTitle>
              </DialogHeader>
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            </DialogContent>
          ) : (
            <InvoiceFormContent
              key={editingInvoice?.id || editingInvoiceId || "create"}
              mode={mode}
              editingInvoice={editingInvoice}
              createUrl={createUrl}
              patchUrlPrefix={patchUrlPrefix}
              onSuccess={onSuccess}
              onClose={() => onOpenChange(false)}
              defaultValues={defaultValues}
              showProjectCode={showProjectCode}
              aiDraftUrl={aiDraftUrl}
              extraPayload={extraPayload}
              projectName={projectName}
              projectContent={projectContent}
              reissueFromInvoiceId={reissueFromInvoiceId}
              reissueReason={reissueReason}
            />
          )}
        </>
      )}
    </Dialog>
  );
}

interface ContentProps {
  mode: "create" | "edit";
  editingInvoice: InvoiceRecord | null;
  createUrl: string;
  patchUrlPrefix: string;
  onSuccess: () => void;
  onClose: () => void;
  defaultValues?: InvoiceFormDialogProps["defaultValues"];
  showProjectCode: boolean;
  aiDraftUrl?: string | null;
  extraPayload?: Record<string, unknown>;
  reissueFromInvoiceId?: string | null;
  reissueReason?: string | null;
}

function InvoiceFormContent({
  mode, editingInvoice, createUrl, patchUrlPrefix,
  onSuccess, onClose, defaultValues, showProjectCode, aiDraftUrl,
  extraPayload, projectName, projectContent,
  reissueFromInvoiceId, reissueReason,
}: ContentProps & { projectName?: string; projectContent?: string }) {
  const inv = editingInvoice;
  const [contactName, setContactName] = useState(inv?.contactName || defaultValues?.contactName || "");
  const [formProjectCode, setFormProjectCode] = useState(inv?.projectCode || defaultValues?.projectCode || "");
  const [sellerProfileId, setSellerProfileId] = useState(inv?.sellerProfileId || "");
  const [sellerName, setSellerName] = useState(inv?.sellerName || "");
  const [sellerTaxId, setSellerTaxId] = useState(inv?.sellerTaxId || "");
  const [sellerBankName, setSellerBankName] = useState(inv?.sellerBankName || "");
  const [sellerBankAccount, setSellerBankAccount] = useState(inv?.sellerBankAccount || "");
  const [buyerOrgId, setBuyerOrgId] = useState(inv?.buyerOrganizationId || defaultValues?.buyerOrgId || "");
  const [buyerOrgName, setBuyerOrgName] = useState(inv?.buyerOrganizationName || defaultValues?.buyerOrgName || "");
  const [buyerTaxId, setBuyerTaxId] = useState(inv?.buyerTaxId || defaultValues?.buyerTaxId || "");
  const [invoiceType, setInvoiceType] = useState(inv?.invoiceType || defaultValues?.invoiceType || "NORMAL");
  const initialContentSummary = inv?.contentSummary || defaultValues?.contentSummary || projectName || "";
  const initialContentMode: "PROJECT_NAME" | "PROJECT_CONTENT" | "MANUAL" =
    inv?.contentSummary || defaultValues?.contentSummary
      ? "MANUAL"
      : projectName
        ? "PROJECT_NAME"
        : "MANUAL";
  const [contentSummary, setContentSummary] = useState(initialContentSummary);
  const [contentMode, setContentMode] = useState<"PROJECT_NAME" | "PROJECT_CONTENT" | "MANUAL">(initialContentMode);
  const [remark, setRemark] = useState(inv?.remark || defaultValues?.remark || "");
  const [items, setItems] = useState<InvoiceItem[]>(
    inv && inv.items.length > 0
      ? inv.items.map((it) => ({
          itemName: it.itemName, spec: it.spec || "", unit: it.unit || "",
          quantity: it.quantity != null ? String(it.quantity) : "",
          amount: it.amount != null ? String(it.amount) : "",
        }))
      : defaultValues?.items && defaultValues.items.length > 0
        ? defaultValues.items
        : [emptyItem()],
  );
  const [archivedProfile, setArchivedProfile] = useState<BillingProfile | null>(null);
  const [taxIdFromLookup, setTaxIdFromLookup] = useState(inv?.buyerTaxIdFromLookup || false);
  const [aiDraftLoading, setAiDraftLoading] = useState(false);
  const [aiDraftResult, setAiDraftResult] = useState<{ draft: Record<string, unknown>; summary: string } | null>(null);

  const { data: profilesData } = useQuery<{ profiles: BillingProfile[] }>({
    queryKey: ["billing-profiles"],
    queryFn: async () => {
      const res = await fetch("/api/billing-profiles");
      if (!res.ok) return { profiles: [] };
      return res.json();
    },
  });
  const profiles = useMemo(() => profilesData?.profiles || [], [profilesData]);

  const sellerOptions = useMemo(() => {
    if (!archivedProfile || profiles.some((p) => p.id === archivedProfile.id)) return profiles;
    return [...profiles, archivedProfile];
  }, [profiles, archivedProfile]);

  const selectedSellerProfile = useMemo(
    () => sellerOptions.find((profile) => profile.id === sellerProfileId) || null,
    [sellerOptions, sellerProfileId],
  );

  const applySellerProfile = useCallback((profileId: string) => {
    const p = sellerOptions.find((pr) => pr.id === profileId);
    if (p) {
      setSellerProfileId(p.id);
      setSellerName(p.name);
      setSellerTaxId(p.taxId || "");
      setSellerBankName(p.bankName || "");
      setSellerBankAccount(p.bankAccount || "");
    }
  }, [sellerOptions]);

  // On mount: apply default seller profile (create mode) or load fresh org/profile data (edit mode)
  useEffect(() => {
    if (!inv) {
      if (profiles.length > 0) {
        const dp = profiles.find((p) => p.isDefault);
        if (dp) {
          Promise.resolve().then(() => {
            setSellerProfileId(dp.id);
            setSellerName(dp.name);
            setSellerTaxId(dp.taxId || "");
            setSellerBankName(dp.bankName || "");
            setSellerBankAccount(dp.bankAccount || "");
          });
        }
      }
      if (defaultValues?.buyerOrgId) {
        fetch(`/api/organizations/${defaultValues.buyerOrgId}`)
          .then((r) => r.ok ? r.json() : null)
          .then((d) => { if (d?.organization?.taxId) setBuyerTaxId(d.organization.taxId); })
          .catch(() => {});
      }
      return;
    }
    if (inv.buyerOrganizationId) {
      fetch(`/api/organizations/${inv.buyerOrganizationId}`)
        .then((r) => r.ok ? r.json() : null)
        .then((d) => {
          if (d?.organization) {
            setBuyerOrgName(d.organization.canonicalName || inv.buyerOrganizationName);
            setBuyerTaxId(d.organization.taxId || inv.buyerTaxId || "");
          }
        })
        .catch(() => {});
    }
    if (inv.sellerProfileId) {
      fetch(`/api/billing-profiles/${inv.sellerProfileId}`)
        .then((r) => r.ok ? r.json() : null)
        .then((d) => {
          if (d?.profile) {
            const p = d.profile;
            setSellerName(p.name);
            setSellerTaxId(p.taxId || "");
            setSellerBankName(p.bankName || "");
            setSellerBankAccount(p.bankAccount || "");
            if (!profiles.some((pr: BillingProfile) => pr.id === p.id)) setArchivedProfile(p);
          }
        })
        .catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (mode === "edit" && !inv && !reissueFromInvoiceId) {
        throw new Error("发票详情尚未加载完成，不能保存");
      }
      const payload = {
        contactName, projectCode: formProjectCode,
        sellerProfileId: sellerProfileId || null, sellerName,
        sellerTaxId: sellerProfileId ? undefined : sellerTaxId,
        sellerBankName: sellerProfileId ? undefined : sellerBankName,
        sellerBankAccount: sellerProfileId ? undefined : sellerBankAccount,
        buyerOrganizationId: buyerOrgId || null, buyerOrganizationName: buyerOrgName,
        buyerTaxId, taxIdFromLookup, invoiceType, contentSummary, remark,
        items: items.filter((it) => it.itemName.trim()).map((it) => ({
          itemName: it.itemName, spec: it.spec || null, unit: it.unit || null,
          quantity: it.quantity ? parseFloat(it.quantity) : null,
          amount: parseFloat(it.amount) || 0,
        })),
      };
      let url: string;
      let method: string;
      let body: Record<string, unknown>;
      if (reissueFromInvoiceId) {
        url = `/api/finance/order-invoices/${reissueFromInvoiceId}/reissue`;
        method = "POST";
        body = { ...payload, ...buildNormalizedExtraPayload(extraPayload, totalAmountCents), reason: reissueReason };
      } else if (inv) {
        url = `${patchUrlPrefix}/${inv.id}`;
        method = "PATCH";
        body = { ...payload, ...buildNormalizedExtraPayload(extraPayload, totalAmountCents) };
      } else {
        url = createUrl;
        method = "POST";
        body = { ...payload, ...buildNormalizedExtraPayload(extraPayload, totalAmountCents) };
      }
      const res = await fetch(url, {
        method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "保存失败");
      return data;
    },
    onSuccess: () => {
      toast.success(inv && !reissueFromInvoiceId ? "已更新" : "开票申请已保存");
      onClose();
      onSuccess();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleOrgChange = useCallback(
    (_id: string | null, name: string, _address?: string | null, taxId?: string | null) => {
      setBuyerOrgId(_id || "");
      setBuyerOrgName(name);
      setBuyerTaxId(taxId || "");
      setTaxIdFromLookup(false);
    }, [],
  );

  const updateItem = useCallback((idx: number, field: keyof InvoiceItem, val: string) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, [field]: val } : it)));
  }, []);
  const addItem = useCallback(() => setItems((prev) => [...prev, emptyItem()]), []);
  const removeItem = useCallback(
    (idx: number) => setItems((prev) => prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)), [],
  );

  const totalAmount = items.reduce((s, it) => s + (parseFloat(it.amount) || 0), 0);
  const totalAmountCents = yuanToCents(totalAmount);

  const taxIdMissing = !!buyerOrgId && !buyerTaxId.trim();
  const sellerMissing = !sellerProfileId && !sellerName.trim();
  const canSubmit = !!buyerOrgName.trim() && !taxIdMissing && !sellerMissing && !saveMutation.isPending;

  const sellerBankInfo = [sellerBankName, sellerBankAccount].filter(Boolean).join(" ");
  const previewText = buildPreviewText({
    contactName, projectCode: formProjectCode, sellerName, sellerTaxId,
    sellerBankInfo, buyerOrgName, buyerTaxId, invoiceType, contentSummary, remark, items,
  });
  const formSheetData = useMemo(() => sheetDataFromForm({
    contactName, projectCode: formProjectCode, sellerName, sellerTaxId,
    sellerBankName, sellerBankAccount,
    sellerAddress: selectedSellerProfile?.address || "",
    sellerPhone: selectedSellerProfile?.phone || "",
    buyerOrgName, buyerTaxId,
    invoiceType, contentSummary, remark, items,
  }), [contactName, formProjectCode, sellerName, sellerTaxId, sellerBankName, sellerBankAccount, selectedSellerProfile, buyerOrgName, buyerTaxId, invoiceType, contentSummary, remark, items]);

  const copyText = useCallback(async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.success("已复制到剪贴板"); }
    catch { toast.error("复制失败"); }
  }, []);

  const exportPdf = useCallback(async (data: InvoiceSheetData) => {
    try {
      await exportInvoiceSheetToPdf(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "PDF 导出失败");
    }
  }, []);

  const handleAiDraft = useCallback(async () => {
    if (!aiDraftUrl) return;
    setAiDraftLoading(true);
    try {
      const res = await fetch(aiDraftUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "AI 生成失败");
      setAiDraftResult(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "AI 生成失败");
    } finally {
      setAiDraftLoading(false);
    }
  }, [aiDraftUrl]);

  const applyAiDraft = useCallback(() => {
    if (!aiDraftResult?.draft) return;
    const d = aiDraftResult.draft;
    if (typeof d.contactName === "string" && !contactName.trim()) setContactName(d.contactName);
    if ((d.invoiceType === "NORMAL" || d.invoiceType === "SPECIAL") && invoiceType === "NORMAL") setInvoiceType(d.invoiceType);
    if (typeof d.contentSummary === "string" && !contentSummary.trim()) setContentSummary(d.contentSummary);
    if (typeof d.remark === "string" && !remark.trim()) setRemark(d.remark);
    const itemsEmpty = items.length <= 1 && items.every((it) => !it.itemName.trim() && !it.amount.trim());
    if (Array.isArray(d.items) && d.items.length > 0 && itemsEmpty) {
      setItems(d.items.map((it: Record<string, unknown>) => ({
        itemName: String(it.itemName || ""),
        spec: String(it.spec || ""),
        unit: String(it.unit || ""),
        quantity: it.quantity != null ? String(it.quantity) : "",
        amount: it.amount != null ? String(it.amount) : "",
      })));
    }
    setAiDraftResult(null);
    toast.success("AI 草稿已应用（仅填充了空字段）");
  }, [aiDraftResult, contactName, invoiceType, contentSummary, remark, items]);

  const isNarrow = useMediaQuery("(max-width: 1023px)");

  const previewToolbar = (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-6 text-xs"
        disabled={!previewText.trim()}
        onClick={() => copyText(previewText)}
      >
        <Copy className="mr-1 h-3 w-3" /> 复制文本
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-6 text-xs"
        disabled={!previewText.trim()}
        onClick={() => void exportPdf(formSheetData)}
      >
        <FileDown className="mr-1 h-3 w-3" /> 导出 PDF
      </Button>
    </div>
  );

  return (
    <>
      <DialogContent className="sm:max-w-2xl lg:max-w-6xl max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle>{reissueFromInvoiceId ? "重开发票" : inv ? "编辑开票申请" : "新建开票申请"}</DialogTitle>
            {aiDraftUrl && (
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={aiDraftLoading} onClick={handleAiDraft}>
                {aiDraftLoading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Wand2 className="mr-1 h-3 w-3" />}
                AI 填写
              </Button>
            )}
          </div>
        </DialogHeader>
        {/* Body：桌面左右分栏各自滚动；窄屏单栏滚动 */}
        <div className="-mx-4 min-h-0 overflow-hidden px-4 pb-1">
          {isNarrow ? (
            <div className="h-full min-h-0 overflow-y-auto overscroll-contain space-y-4" style={{ WebkitOverflowScrolling: "touch" }}>
              <FormBody
                showProjectCode={showProjectCode}
                contactName={contactName} setContactName={setContactName}
                formProjectCode={formProjectCode} setFormProjectCode={setFormProjectCode}
                sellerProfileId={sellerProfileId} setSellerProfileId={setSellerProfileId}
                sellerName={sellerName} setSellerName={setSellerName}
                sellerTaxId={sellerTaxId} setSellerTaxId={setSellerTaxId}
                sellerBankName={sellerBankName} setSellerBankName={setSellerBankName}
                sellerBankAccount={sellerBankAccount} setSellerBankAccount={setSellerBankAccount}
                sellerOptions={sellerOptions} selectedSellerProfile={selectedSellerProfile}
                applySellerProfile={applySellerProfile}
                buyerOrgId={buyerOrgId} buyerOrgName={buyerOrgName}
                buyerTaxId={buyerTaxId} setBuyerTaxId={setBuyerTaxId}
                handleOrgChange={handleOrgChange}
                taxIdMissing={taxIdMissing} setTaxIdFromLookup={setTaxIdFromLookup}
                invoiceType={invoiceType} setInvoiceType={setInvoiceType}
                contentSummary={contentSummary} setContentSummary={setContentSummary}
                contentMode={contentMode} setContentMode={setContentMode}
                projectName={projectName} projectContent={projectContent}
                remark={remark} setRemark={setRemark}
                items={items} updateItem={updateItem} addItem={addItem} removeItem={removeItem}
                totalAmount={totalAmount}
              />
              <div className="space-y-2 border-t pt-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-muted-foreground">发票预览</label>
                  {previewToolbar}
                </div>
                <InvoicePreviewCard data={formSheetData} />
              </div>
            </div>
          ) : (
            <div className="grid h-full min-h-0 grid-cols-2 gap-4">
              <div className="min-h-0 overflow-y-auto overscroll-contain pr-1" style={{ WebkitOverflowScrolling: "touch" }}>
                <FormBody
                  showProjectCode={showProjectCode}
                  contactName={contactName} setContactName={setContactName}
                  formProjectCode={formProjectCode} setFormProjectCode={setFormProjectCode}
                  sellerProfileId={sellerProfileId} setSellerProfileId={setSellerProfileId}
                  sellerName={sellerName} setSellerName={setSellerName}
                  sellerTaxId={sellerTaxId} setSellerTaxId={setSellerTaxId}
                  sellerBankName={sellerBankName} setSellerBankName={setSellerBankName}
                  sellerBankAccount={sellerBankAccount} setSellerBankAccount={setSellerBankAccount}
                  sellerOptions={sellerOptions} selectedSellerProfile={selectedSellerProfile}
                  applySellerProfile={applySellerProfile}
                  buyerOrgId={buyerOrgId} buyerOrgName={buyerOrgName}
                  buyerTaxId={buyerTaxId} setBuyerTaxId={setBuyerTaxId}
                  handleOrgChange={handleOrgChange}
                  taxIdMissing={taxIdMissing} setTaxIdFromLookup={setTaxIdFromLookup}
                  invoiceType={invoiceType} setInvoiceType={setInvoiceType}
                  contentSummary={contentSummary} setContentSummary={setContentSummary}
                  contentMode={contentMode} setContentMode={setContentMode}
                  projectName={projectName} projectContent={projectContent}
                  remark={remark} setRemark={setRemark}
                  items={items} updateItem={updateItem} addItem={addItem} removeItem={removeItem}
                  totalAmount={totalAmount}
                />
              </div>
              <div className="min-h-0 overflow-y-auto overscroll-contain pl-1 space-y-2">
                <div className="flex items-center justify-between sticky top-0 z-10 bg-popover/95 py-1">
                  <label className="text-xs text-muted-foreground">发票预览</label>
                  {previewToolbar}
                </div>
                <InvoicePreviewCard data={formSheetData} />
              </div>
            </div>
          )}
        </div>
        <div className="-mx-4 -mb-4 border-t bg-popover/95 px-4 py-3 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" disabled={!canSubmit} onClick={() => saveMutation.mutate()}>
            {saveMutation.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            {!!inv && !reissueFromInvoiceId ? "保存" : "创建"}
          </Button>
        </div>
      </DialogContent>

      {!!aiDraftResult && (
        <Dialog open onOpenChange={(o) => { if (!o) setAiDraftResult(null); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader><DialogTitle>AI 草稿预览</DialogTitle></DialogHeader>
            <AiDraftPreview
              draft={aiDraftResult}
              contactName={contactName} contentSummary={contentSummary}
              remark={remark} items={items}
              onApply={applyAiDraft} onCancel={() => setAiDraftResult(null)}
            />
          </DialogContent>
        </Dialog>
      )}

    </>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function FormBody({
  showProjectCode,
  contactName, setContactName,
  formProjectCode, setFormProjectCode,
  sellerProfileId, setSellerProfileId,
  sellerName, setSellerName,
  sellerTaxId, setSellerTaxId,
  sellerBankName, setSellerBankName,
  sellerBankAccount, setSellerBankAccount,
  sellerOptions, selectedSellerProfile, applySellerProfile,
  buyerOrgId, buyerOrgName, buyerTaxId, setBuyerTaxId,
  handleOrgChange, taxIdMissing, setTaxIdFromLookup,
  invoiceType, setInvoiceType,
  contentSummary, setContentSummary,
  contentMode, setContentMode,
  projectName, projectContent,
  remark, setRemark,
  items, updateItem, addItem, removeItem, totalAmount,
}: any) {
  return (
    <div className="space-y-4">
      <div className={`grid ${showProjectCode ? "grid-cols-2" : "grid-cols-1"} gap-3`}>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">联系人</label>
          <Input value={contactName} onChange={(e: any) => setContactName(e.target.value)} placeholder="联系人姓名" className="h-8 text-sm" />
        </div>
        {showProjectCode && (
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">项目编号</label>
            <Input value={formProjectCode} onChange={(e: any) => setFormProjectCode(e.target.value)} placeholder="项目编号" className="h-8 text-sm" />
          </div>
        )}
      </div>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">开票方 *</label>
        {sellerOptions.length > 0 ? (
          <Select value={sellerProfileId || "__manual__"} onValueChange={(v: string) => {
            if (!v || v === "__manual__") {
              setSellerProfileId(""); setSellerName(""); setSellerTaxId(""); setSellerBankName(""); setSellerBankAccount("");
            } else { applySellerProfile(v); }
          }}>
            <SelectTrigger className="h-8 text-sm">
              {sellerProfileId
                ? (selectedSellerProfile
                  ? `${selectedSellerProfile.name}${selectedSellerProfile.isDefault ? "（默认）" : ""}${selectedSellerProfile.archived ? "（已归档）" : ""}`
                  : (sellerName || "加载中..."))
                : <SelectValue placeholder="选择开票主体" />}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__manual__">手动输入</SelectItem>
              {sellerOptions.map((p: any) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}{p.isDefault ? "（默认）" : ""}{p.archived ? "（已归档）" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input value={sellerName} onChange={(e: any) => setSellerName(e.target.value)} placeholder="开票方公司名称" className="h-8 text-sm" />
        )}
        {!sellerProfileId && sellerOptions.length > 0 && (
          <Input value={sellerName} onChange={(e: any) => setSellerName(e.target.value)} placeholder="手动输入开票方名称" className="h-8 text-sm mt-1.5" />
        )}
        {!sellerProfileId && (
          <div className="grid grid-cols-3 gap-1.5 mt-1.5">
            <Input value={sellerTaxId} onChange={(e: any) => setSellerTaxId(e.target.value)} placeholder="卖方税号" className="h-7 text-xs" />
            <Input value={sellerBankName} onChange={(e: any) => setSellerBankName(e.target.value)} placeholder="开户行" className="h-7 text-xs" />
            <Input value={sellerBankAccount} onChange={(e: any) => setSellerBankAccount(e.target.value)} placeholder="银行账号" className="h-7 text-xs" />
          </div>
        )}
        {sellerProfileId && (
          <div className="text-[10px] text-muted-foreground mt-1">
            {[sellerTaxId && `税号: ${sellerTaxId}`, sellerBankName && `开户行: ${sellerBankName}`, sellerBankAccount && `账号: ${sellerBankAccount}`].filter(Boolean).join(" | ") || "无详细信息"}
          </div>
        )}
      </div>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">对方公司名称 *</label>
        <OrganizationSelect value={buyerOrgId} displayValue={buyerOrgName} onChange={handleOrgChange} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            统一社会信用代码/纳税人识别号{buyerOrgId ? " *" : ""}
          </label>
          <TaxIdLookupInput
            value={buyerTaxId} onChange={setBuyerTaxId} orgName={buyerOrgName}
            placeholder="税号" errorMessage={taxIdMissing ? "已选择单位，请补填税号" : undefined}
            onFromLookupChange={setTaxIdFromLookup}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">发票类型</label>
          <Select value={invoiceType} onValueChange={(v: string) => v && setInvoiceType(v)}>
            <SelectTrigger className="h-8 text-sm">
              <SelectValue>{invoiceType === "SPECIAL" ? "专票" : "普票"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="NORMAL">普票</SelectItem>
              <SelectItem value="SPECIAL">专票</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">开票内容</label>
        <div className="flex gap-2 mb-1">
          {(["PROJECT_NAME", "PROJECT_CONTENT", "MANUAL"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`text-xs px-2 py-0.5 rounded border ${contentMode === mode ? "bg-primary text-primary-foreground border-primary" : "bg-background border-input text-muted-foreground"}`}
              onClick={() => {
                if (mode === "PROJECT_NAME" && !projectName) { toast.error("没有项目名称"); return; }
                if (mode === "PROJECT_CONTENT" && !projectContent) { toast.error("项目没有填写项目内容"); return; }
                setContentMode(mode);
                if (mode === "PROJECT_NAME") setContentSummary(projectName!);
                else if (mode === "PROJECT_CONTENT") setContentSummary(projectContent!);
              }}
            >
              {mode === "PROJECT_NAME" ? "项目名" : mode === "PROJECT_CONTENT" ? "项目内容" : "手写"}
            </button>
          ))}
        </div>
        <Input value={contentSummary} onChange={(e: any) => { setContentMode("MANUAL"); setContentSummary(e.target.value); }} placeholder="如：小鼠售卖" className="h-8 text-sm" disabled={contentMode !== "MANUAL"} />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">明细行</label>
          <Button type="button" size="sm" variant="ghost" className="h-6 text-xs" onClick={addItem}>
            <Plus className="mr-1 h-3 w-3" /> 添加行
          </Button>
        </div>
        {items.map((it: InvoiceItem, idx: number) => (
          <div key={idx} className="flex items-start gap-1.5">
            <div className="grid grid-cols-5 gap-1.5 flex-1">
              <Input value={it.itemName} onChange={(e: any) => updateItem(idx, "itemName", e.target.value)} placeholder="项目名称" className="h-7 text-xs" />
              <Input value={it.spec} onChange={(e: any) => updateItem(idx, "spec", e.target.value)} placeholder="规格" className="h-7 text-xs" />
              <Input value={it.unit} onChange={(e: any) => updateItem(idx, "unit", e.target.value)} placeholder="单位" className="h-7 text-xs" />
              <Input value={it.quantity} onChange={(e: any) => updateItem(idx, "quantity", e.target.value)} placeholder="数量" className="h-7 text-xs" type="number" />
              <Input value={it.amount} onChange={(e: any) => updateItem(idx, "amount", e.target.value)} placeholder="金额" className="h-7 text-xs" type="number" />
            </div>
            <Button type="button" size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => removeItem(idx)} disabled={items.length <= 1}>
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        ))}
        {totalAmount > 0 && <div className="text-right text-sm font-medium">合计：{formatAmount(totalAmount)}</div>}
      </div>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">备注</label>
        <Textarea value={remark} onChange={(e: any) => setRemark(e.target.value)} placeholder="备注信息" rows={2} className="text-sm resize-none" />
      </div>

    </div>
  );
}

function AiDraftPreview({ draft, contactName, contentSummary, remark, items, onApply, onCancel }: {
  draft: { draft: Record<string, unknown>; summary: string };
  contactName: string; contentSummary: string; remark: string; items: InvoiceItem[];
  onApply: () => void; onCancel: () => void;
}) {
  const d = draft.draft;
  const itemsEmpty = items.length <= 1 && items.every((it) => !it.itemName.trim() && !it.amount.trim());
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{draft.summary}</p>
      <p className="text-[10px] text-muted-foreground">仅填充当前为空的字段，<span className="line-through">划线</span>表示已有值将保留</p>
      <div className="space-y-2 text-sm">
        {typeof d.contactName === "string" && (
          <div className={contactName.trim() ? "line-through opacity-50" : ""}>
            <span className="text-muted-foreground">联系人：</span>{d.contactName as string}
            {contactName.trim() && <span className="text-[10px] ml-1">（已有值）</span>}
          </div>
        )}
        {(d.invoiceType === "NORMAL" || d.invoiceType === "SPECIAL") && (
          <div><span className="text-muted-foreground">发票类型：</span>{d.invoiceType === "SPECIAL" ? "专票" : "普票"}</div>
        )}
        {typeof d.contentSummary === "string" && (
          <div className={contentSummary.trim() ? "line-through opacity-50" : ""}>
            <span className="text-muted-foreground">开票内容：</span>{d.contentSummary as string}
            {contentSummary.trim() && <span className="text-[10px] ml-1">（已有值）</span>}
          </div>
        )}
        {typeof d.remark === "string" && (
          <div className={remark.trim() ? "line-through opacity-50" : ""}>
            <span className="text-muted-foreground">备注：</span>{d.remark as string}
            {remark.trim() && <span className="text-[10px] ml-1">（已有值）</span>}
          </div>
        )}
        {Array.isArray(d.items) && d.items.length > 0 && (
          <div className={!itemsEmpty ? "line-through opacity-50" : ""}>
            <span className="text-muted-foreground">明细行：</span>
            {!itemsEmpty && <span className="text-[10px] ml-1">（已有明细）</span>}
            <ul className="mt-1 space-y-0.5 text-xs">
              {(d.items as Array<Record<string, unknown>>).map((it, i) => (
                <li key={i} className="pl-2 border-l-2 border-muted">
                  {String(it.itemName)}{it.spec ? ` (${it.spec})` : ""}{it.quantity != null ? ` ×${it.quantity}` : ""}{it.unit ? ` ${it.unit}` : ""}{it.amount ? ` ¥${it.amount}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" size="sm" onClick={onCancel}>取消</Button>
        <Button size="sm" onClick={onApply}>应用到表单</Button>
      </div>
    </div>
  );
}
