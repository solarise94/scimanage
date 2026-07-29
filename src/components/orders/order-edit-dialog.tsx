"use client";

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectDisplay } from "@/components/ui/select";
import { CustomerSelect } from "@/components/customer-select";
import { DraftInputPanel } from "@/components/draft-input-panel";
import { TechSupportSelect } from "@/components/tech-support-select";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { ORDER_STATUS_TRANSITIONS } from "@/lib/orders/constants";

const CATEGORY_LABELS: Record<string, string> = { UNKNOWN: "未分类", SERVICE: "服务", PRODUCT: "商品", MIXED: "混合" };
const EDITABLE_CATEGORY_OPTIONS = [
  { value: "SERVICE", label: "服务" },
  { value: "PRODUCT", label: "商品" },
];
const STATUS_LABELS: Record<string, string> = { DRAFT: "草稿", CONFIRMED: "已确认", DELIVERED: "已交付", CLOSED: "已关闭" };
const TREATMENT_LABELS: Record<string, string> = { AUTO: "自动", STANDALONE: "独立计入", PROJECT_INCLUDED: "并入项目", EXCLUDED: "排除" };
const MATCH_LABELS: Record<string, string> = { UNMATCHED: "未匹配", AUTO_MATCHED: "自动匹配", MANUAL_MATCHED: "人工匹配", CONFLICT: "冲突" };

/**
 * 状态/交付 Select 的合法选项 = 当前值 + transition map 可达值。
 * 必须含当前值，否则 Select 默认值不在选项里会触发「已变更」并把状态改成列表首项；
 * 同时杜绝「选了非法状态、提交才被 API 400 拒绝」的糟糕体验。
 */
function allowedTransitionKeys(current: string, transitions: Record<string, string[]>): string[] {
  const next = transitions[current] || [];
  return [current, ...next.filter((k) => k !== current)];
}

interface OrderEditDialogProps {
  orderId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => void;
}

interface LineItem {
  itemName: string;
  spec: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export function OrderEditDialog({ orderId, open, onOpenChange, onUpdated }: OrderEditDialogProps) {
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [original, setOriginal] = useState<Record<string, unknown>>({});
  const [editLines, setEditLines] = useState<LineItem[]>([]);
  const [originalLines, setOriginalLines] = useState<LineItem[]>([]);
  const [hasFinancialRecords, setHasFinancialRecords] = useState(false);

  const reset = () => {
    setForm({});
    setOriginal({});
    setEditLines([]);
    setOriginalLines([]);
    setHasFinancialRecords(false);
  };

  useEffect(() => {
    if (!open || !orderId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);

    (async () => {
      try {
        const res = await fetch(`/api/orders/${orderId}`);
        if (cancelled) return;
        const d = await res.json();
        const o = d?.order;
        if (!o) { toast.error("无法加载订单"); setLoading(false); return; }

        const f: Record<string, unknown> = {
          title: o.title || "",
          description: o.description || "",
          category: o.category || "UNKNOWN",
          status: o.status || "DRAFT",
          orderedAt: o.orderedAt?.slice(0, 10) || "",
          confirmedAt: o.confirmedAt?.slice(0, 10) || "",
          deliveredAt: o.deliveredAt?.slice(0, 10) || "",
          profileId: o.profileId || o.customer?.id || "",
          customerName: o.customer?.name || "",
          customerCode: o.customer?.customerCode || "",
          customerMatchStatus: o.customerMatchStatus || "UNMATCHED",
          customerMatchScore: o.customerMatchScore ?? null,
          customerMatchReason: o.customerMatchReason || "",
          buyerNameSnapshot: o.buyerNameSnapshot || "",
          buyerPhoneSnapshot: o.buyerPhoneSnapshot || "",
          buyerWechatSnapshot: o.buyerWechatSnapshot || "",
          buyerOrgNameSnapshot: o.buyerOrgNameSnapshot || "",
          buyerAddressSnapshot: o.buyerAddressSnapshot || "",
          techSupport: o.techSupport || "",
          financeTreatment: o.financeTreatment || "AUTO",
          financeAmountOverride: o.financeAmountOverride ?? null,
          financeNote: o.financeNote || "",
          source: o.source || "MANUAL",
          representativeId: o.representative?.id || o.representativeId || "",
          representativeName: o.representative?.name || "",
          totalAmount: o.totalAmount || 0,
          _count: o._count || {},
        };

        const rawLines = (o.lines || []) as Array<Record<string, unknown>>;
        const ls: LineItem[] = rawLines.map((l) => ({
          itemName: (l.itemName as string) || "",
          spec: (l.spec as string) || "",
          unit: (l.unit as string) || "",
          quantity: (l.quantity as number) || 1,
          unitPrice: (l.unitPrice as number) || 0,
          amount: (l.amount as number) || 0,
        }));

        const counts = o._count as Record<string, number> | null;
        const nonCancelledInvoices = (o.invoiceRequests as Array<Record<string, unknown>>)?.filter((inv) => inv.status !== "CANCELLED").length || 0;
        const nonCancelledCoverage = (o.invoiceCoverage as Array<Record<string, unknown>>)?.filter(
          (cov) => (cov.invoiceRequest as Record<string, unknown>)?.status !== "CANCELLED"
        ).length || 0;
        const hasFin = !!(
          (counts && counts.receipts > 0) ||
          nonCancelledInvoices > 0 ||
          nonCancelledCoverage > 0 ||
          (o.financeCosts as Array<unknown>)?.length > 0
        );

        setForm(f);
        setOriginal({ ...f });
        setEditLines(ls);
        setOriginalLines(ls.map((l) => ({ ...l })));
        setHasFinancialRecords(hasFin);
        setLoading(false);
      } catch {
        if (!cancelled) { toast.error("加载订单失败"); setLoading(false); }
      }
    })();

    return () => { cancelled = true; };
  }, [open, orderId]);

  const updateForm = (key: string, value: unknown) => setForm((p) => ({ ...p, [key]: value }));

  const updateLine = (i: number, field: string, value: unknown) => {
    const updated = [...editLines];
    updated[i] = { ...updated[i], [field]: value };
    if (field === "quantity" || field === "unitPrice") {
      updated[i].amount = (updated[i].quantity || 0) * (updated[i].unitPrice || 0);
    }
    setEditLines(updated);
  };

  const addLine = () => setEditLines([...editLines, { itemName: "", spec: "", unit: "", quantity: 1, unitPrice: 0, amount: 0 }]);
  const removeLine = (i: number) => setEditLines(editLines.filter((_, idx) => idx !== i));
  const lineTotal = editLines.reduce((s, l) => s + l.amount, 0);

  // 按 transition map 过滤状态选项（以加载时的原始状态为基准，保证当前值始终可选）
  const statusOptionKeys = allowedTransitionKeys(
    (original.status as string) || (form.status as string) || "DRAFT",
    ORDER_STATUS_TRANSITIONS,
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      const diff: Record<string, unknown> = {};

      // Scalar field diff
      const scalarKeys = [
        "title", "description", "category", "status",
        "orderedAt", "confirmedAt", "deliveredAt",
        "customerMatchStatus", "customerMatchScore", "customerMatchReason",
        "buyerNameSnapshot", "buyerPhoneSnapshot", "buyerWechatSnapshot",
        "buyerOrgNameSnapshot", "buyerAddressSnapshot",
        "techSupport",
        "financeTreatment", "financeAmountOverride", "financeNote",
      ];
      for (const k of scalarKeys) {
        if (form[k] !== original[k]) {
          diff[k] = form[k] === "" ? null : form[k];
        }
      }

      // Customer diff — send profileId for rep auto-derive
      if (form.profileId !== original.profileId) {
        // U3：已有客户的订单禁止清空 profileId（后端也会 400 拒绝）。
        if (original.profileId && !form.profileId) {
          throw new Error("订单必须保留客户，不能清空");
        }
        diff.profileId = (form.profileId as string) || null;
      }

      // Lines diff
      const linesChanged =
        editLines.length !== originalLines.length ||
        editLines.some((l, i) => {
          const ol = originalLines[i];
          if (!ol) return true;
          return l.itemName !== ol.itemName || l.spec !== ol.spec || l.unit !== ol.unit ||
            l.quantity !== ol.quantity || l.unitPrice !== ol.unitPrice || l.amount !== ol.amount;
        });

      if (linesChanged) {
        diff.lines = editLines.map((l, i) => ({
          itemName: l.itemName,
          spec: l.spec || null,
          unit: l.unit || null,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          amount: l.amount,
          sortOrder: i,
        }));
      }

      if (Object.keys(diff).length === 0) return null;

      const res = await fetch(`/api/orders/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(diff),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "保存失败");
      }
      return res.json();
    },
    onSuccess: (data) => {
      if (data === null) { onOpenChange(false); return; }
      toast.success("订单已更新");
      onUpdated();
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="sm:max-w-4xl max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle>编辑订单</DialogTitle>
        </DialogHeader>

        <div className="-mx-4 min-h-0 overflow-y-auto overscroll-contain px-4 pb-1" style={{ WebkitOverflowScrolling: "touch" }}>
        {loading ? (
          <div className="py-8 text-center text-muted-foreground">加载中...</div>
        ) : (
          <>
            <DraftInputPanel
              formKey="order.create"
              fieldLabels={{
                title: "订单标题",
                description: "描述",
                category: "分类",
                customer: "客户",
                buyerNameSnapshot: "收件人",
                buyerPhoneSnapshot: "电话",
                buyerWechatSnapshot: "微信",
                buyerOrgNameSnapshot: "单位",
                buyerAddressSnapshot: "地址",
                orderedAt: "下单日期",
                lines: "明细项",
                quantity: "数量/例数",
                unitPrice: "单价",
                sampleType: "样本类型",
                totalAmount: "总金额",
                projectType: "项目类型",
                procurementSource: "采购渠道",
                brand: "品牌",
                techSupport: "技术支持",
                budgetCost: "项目成本",
                initialCost: "订单成本",
                initialCostType: "成本类型",
                initialCostRemark: "成本备注",
              }}
              onApply={(fields) => {
                setForm((prev) => ({ ...prev, ...fields }));
                if (Array.isArray(fields.lines)) {
                  const newLines = (fields.lines as Array<Record<string, unknown>>).map((l) => ({
                    itemName: String(l.itemName || ""),
                    spec: String(l.spec || ""),
                    unit: String(l.unit || ""),
                    quantity: Number(l.quantity) || 1,
                    unitPrice: Number(l.unitPrice) || 0,
                    amount: (Number(l.quantity) || 1) * (Number(l.unitPrice) || 0),
                  }));
                  setEditLines(newLines);
                }
              }}
              fallbackPlugin="order.smart-fill"
            />
            <Tabs defaultValue="basic" className="mt-2">
            <TabsList className="w-full overflow-x-auto">
              <TabsTrigger value="basic">基本信息</TabsTrigger>
              <TabsTrigger value="customer">客户</TabsTrigger>
              <TabsTrigger value="buyer">买方快照</TabsTrigger>
              <TabsTrigger value="finance">财务</TabsTrigger>
              {form.source === "MANUAL" && <TabsTrigger value="lines">明细行 ({editLines.length})</TabsTrigger>}
            </TabsList>

            {/* Basic Info */}
            <TabsContent value="basic" className="space-y-3 mt-3">
              <div className="space-y-2">
                <Label>订单标题 *</Label>
                <Input value={(form.title as string) || ""} onChange={(e) => updateForm("title", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>描述</Label>
                <Input value={(form.description as string) || ""} onChange={(e) => updateForm("description", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>技术支持 *</Label>
                <TechSupportSelect
                  value={(form.techSupport as string) || ""}
                  onChange={(name) => updateForm("techSupport", name)}
                  placeholder="搜索内部员工或输入姓名"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>分类</Label>
                  <Select value={(form.category as string) || "UNKNOWN"} onValueChange={(v) => { if (v) updateForm("category", v); }}>
                    <SelectTrigger size="default"><SelectDisplay label="分类" valueLabel={CATEGORY_LABELS[(form.category as string)] || (form.category as string)} /></SelectTrigger>
                    <SelectContent>
                      {EDITABLE_CATEGORY_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                      ))}
                      {(form.category as string) === "MIXED" && (
                        <SelectItem value="MIXED" disabled>混合</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>状态</Label>
                  <Select value={(form.status as string) || "DRAFT"} onValueChange={(v) => { if (v) updateForm("status", v); }}>
                    <SelectTrigger size="default"><SelectDisplay label="状态" valueLabel={STATUS_LABELS[(form.status as string)] || (form.status as string)} /></SelectTrigger>
                    <SelectContent>
                      {statusOptionKeys.map((k) => <SelectItem key={k} value={k}>{STATUS_LABELS[k] || k}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-2">
                  <Label>下单日期</Label>
                  <Input type="date" value={(form.orderedAt as string) || ""} onChange={(e) => updateForm("orderedAt", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>确认日期</Label>
                  <Input type="date" value={(form.confirmedAt as string) || ""} onChange={(e) => updateForm("confirmedAt", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>交付日期</Label>
                  <Input type="date" value={(form.deliveredAt as string) || ""} onChange={(e) => updateForm("deliveredAt", e.target.value)} />
                </div>
              </div>
              <div className="text-sm text-muted-foreground">来源: <span className="font-medium">{form.source as string}</span></div>
            </TabsContent>

            {/* Customer */}
            <TabsContent value="customer" className="space-y-3 mt-3">
              <div className="space-y-2">
                <Label>客户</Label>
                <CustomerSelect
                  value={(form.profileId as string) || ""}
                  displayValue={
                    (form.profileId as string)
                      ? `${form.customerName as string || ""}${form.customerCode as string ? ` (${form.customerCode as string})` : ""}`
                      : undefined
                  }
                  onChange={(id, name, org, organizationId, customer) => {
                    // U3：订单必须有客户。已有客户的订单禁止清空 profileId——
                    // 后端 PATCH 也会拒绝清空非空 profileId，这里提前给出反馈。
                    // 允许改选其他客户；仅当原本就有客户、现在被清空时拦截。
                    if (!id && original.profileId) {
                      toast.warning("订单必须保留客户，不能清空（可改选其他客户）");
                      return;
                    }
                    updateForm("profileId", id || "");
                    updateForm("customerName", customer?.name || "");
                    updateForm("customerCode", customer?.customerCode || "");
                    if (id && customer) {
                      updateForm("buyerNameSnapshot", customer.name || "");
                      updateForm("buyerPhoneSnapshot", customer.principal || "");
                      updateForm("buyerWechatSnapshot", customer.wechat || "");
                      updateForm("buyerAddressSnapshot", customer.address || "");
                      updateForm("buyerOrgNameSnapshot", customer.organization || "");
                      updateForm("representativeId", customer.representativeId || "");
                      updateForm("representativeName", customer.representativeName || "");
                      updateForm("customerMatchStatus", "MANUAL_MATCHED");
                    } else {
                      // Customer cleared — clear rep and reset match status
                      updateForm("customerName", "");
                      updateForm("customerCode", "");
                      updateForm("representativeId", "");
                      updateForm("representativeName", "");
                      updateForm("customerMatchStatus", "UNMATCHED");
                    }
                  }}
                />
                {original.profileId ? (
                  <p className="text-xs text-muted-foreground">订单必须绑定客户，可改选其他客户但不能清空。</p>
                ) : null}
              </div>
              <div className="space-y-2">
                <Label>代表</Label>
                <Input
                  value={(form.profileId as string)
                    ? ((form.representativeName as string) || (form.representativeId as string) || "由客户 CRM 负责人同步")
                    : ((form.representativeName as string) || (form.representativeId as string) || "（保存后自动同步）")}
                  disabled
                />
                {(form.profileId as string) && !(form.representativeId as string) && !(form.representativeName as string) && (
                  <p className="text-xs text-muted-foreground mt-1">无匹配代表</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>匹配状态</Label>
                  <Select value={(form.customerMatchStatus as string) || "UNMATCHED"} onValueChange={(v) => { if (v) updateForm("customerMatchStatus", v); }}>
                    <SelectTrigger size="default"><SelectDisplay label="匹配" valueLabel={MATCH_LABELS[(form.customerMatchStatus as string)] || (form.customerMatchStatus as string)} /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(MATCH_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>匹配分数</Label>
                  <Input type="number" value={(form.customerMatchScore as number) ?? ""} onChange={(e) => updateForm("customerMatchScore", e.target.value ? Number(e.target.value) : null)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>匹配原因</Label>
                <Input value={(form.customerMatchReason as string) || ""} onChange={(e) => updateForm("customerMatchReason", e.target.value)} />
              </div>
            </TabsContent>

            {/* Buyer Snapshot */}
            <TabsContent value="buyer" className="space-y-3 mt-3">
              <div className="space-y-2">
                <Label>收件人</Label>
                <Input value={(form.buyerNameSnapshot as string) || ""} onChange={(e) => updateForm("buyerNameSnapshot", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>电话</Label>
                <Input value={(form.buyerPhoneSnapshot as string) || ""} onChange={(e) => updateForm("buyerPhoneSnapshot", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>微信</Label>
                <Input value={(form.buyerWechatSnapshot as string) || ""} onChange={(e) => updateForm("buyerWechatSnapshot", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>单位</Label>
                <Input value={(form.buyerOrgNameSnapshot as string) || ""} onChange={(e) => updateForm("buyerOrgNameSnapshot", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>地址</Label>
                <Input value={(form.buyerAddressSnapshot as string) || ""} onChange={(e) => updateForm("buyerAddressSnapshot", e.target.value)} />
              </div>
            </TabsContent>

            {/* Finance */}
            <TabsContent value="finance" className="space-y-3 mt-3">
              <div className="space-y-2">
                <Label>计入口径</Label>
                <Select value={(form.financeTreatment as string) || "AUTO"} onValueChange={(v) => { if (v) updateForm("financeTreatment", v); }}>
                  <SelectTrigger size="default"><SelectDisplay label="口径" valueLabel={TREATMENT_LABELS[(form.financeTreatment as string)] || (form.financeTreatment as string)} /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(TREATMENT_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>金额覆盖</Label>
                <Input
                  type="number"
                  disabled={hasFinancialRecords}
                  value={(form.financeAmountOverride as number) ?? ""}
                  onChange={(e) => updateForm("financeAmountOverride", e.target.value ? Number(e.target.value) : null)}
                  placeholder={String(form.totalAmount || 0)}
                />
                {hasFinancialRecords && <p className="text-xs text-muted-foreground">已有回款/发票/成本记录，金额字段已锁定</p>}
              </div>
              <div className="space-y-2">
                <Label>财务备注</Label>
                <Input value={(form.financeNote as string) || ""} onChange={(e) => updateForm("financeNote", e.target.value)} />
              </div>
            </TabsContent>

            {/* Lines — only for MANUAL orders */}
            {form.source === "MANUAL" && (
              <TabsContent value="lines" className="space-y-3 mt-3">
                {hasFinancialRecords && (
                  <p className="text-xs text-amber-600">该订单已有回款/发票/成本记录，保存时无法修改明细行</p>
                )}
                <div className="flex justify-between items-center">
                  <h3 className="font-medium text-sm">订单明细</h3>
                  <Button variant="outline" size="sm" onClick={addLine}>+ 添加行</Button>
                </div>
                {editLines.map((l, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-1 gap-2 border-b pb-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_5rem_5rem_5rem_auto] sm:items-end"
                  >
                    <div>
                      <label className="text-xs text-muted-foreground">名称</label>
                      <Input value={l.itemName} onChange={(e) => updateLine(i, "itemName", e.target.value)} placeholder="服务名称" />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">规格</label>
                      <Input value={l.spec} onChange={(e) => updateLine(i, "spec", e.target.value)} placeholder="规格" />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">数量</label>
                      <Input type="number" value={l.quantity || ""} onChange={(e) => updateLine(i, "quantity", Number(e.target.value))} />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">单价</label>
                      <Input type="number" value={l.unitPrice || ""} onChange={(e) => updateLine(i, "unitPrice", Number(e.target.value))} />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">金额</label>
                      <div className="text-sm py-1.5 font-medium">¥{l.amount.toLocaleString()}</div>
                    </div>
                    <div className="flex items-end">
                      <Button variant="outline" size="sm" onClick={() => removeLine(i)} disabled={editLines.length <= 1}>×</Button>
                    </div>
                  </div>
                ))}
                <div className="text-right font-medium text-sm">合计: ¥{lineTotal.toLocaleString()}</div>
              </TabsContent>
            )}
          </Tabs>
          </>
        )}
        </div>

        <div className="-mx-4 -mb-4 border-t bg-popover/95 px-4 py-3 flex justify-end gap-3">
          <Button variant="outline" onClick={() => { reset(); onOpenChange(false); }}>取消</Button>
          <Button disabled={loading || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            {saveMutation.isPending ? "保存中..." : "保存"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
