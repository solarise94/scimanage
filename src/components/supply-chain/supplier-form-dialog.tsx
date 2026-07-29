"use client";

import { FormSheet } from "@/components/ui/form-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Pencil, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { SUPPLIER_STATUS, SUPPLIER_CATEGORY, PAYMENT_CYCLE } from "@/lib/supply-chain/constants";

interface EditingSupplier {
  id: string;
  name: string;
  shortName: string | null;
  status: string;
  category: string | null;
  region: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  wechat: string | null;
  address: string | null;
  paymentCycle: string | null;
  defaultLeadDays: number | null;
  quoteUpdateCycleDays: number | null;
  rating: number | null;
  qualityScore: number | null;
  deliveryScore: number | null;
  priceScore: number | null;
  preferenceNote: string | null;
  riskNote: string | null;
}

interface SupplierFormDialogProps {
  startOpen?: boolean;
  onClose?: () => void;
  editing?: EditingSupplier;
  /**
   * 编辑模式下：是否存在主联系人。
   * 存在主联系人时，SupplierContact 是联系方式事实源，主表 contactName/phone/email/wechat
   * 是缓存快照。此时表单中这些字段改为只读，避免在主表直接改导致缓存与主联系人记录分叉。
   * 新建模式或无主联系人时这些字段可写（作为初始缓存）。
   */
  hasPrimaryContact?: boolean;
}

const SUPPLIER_STATUS_VALUES = Object.values(SUPPLIER_STATUS);
const SUPPLIER_CATEGORY_VALUES = Object.values(SUPPLIER_CATEGORY);
const PAYMENT_CYCLE_VALUES = Object.values(PAYMENT_CYCLE);

const SUPPLY_QUERY_KEY = ["supply-suppliers"] as const;

export function SupplierFormDialog({ startOpen, onClose, editing, hasPrimaryContact }: SupplierFormDialogProps) {
  const [open, setOpen] = useState(startOpen || false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [name, setName] = useState(editing?.name || "");
  const [shortName, setShortName] = useState(editing?.shortName || "");
  const [status, setStatus] = useState(editing?.status || "ACTIVE");
  const [category, setCategory] = useState(editing?.category || "");
  const [region, setRegion] = useState(editing?.region || "");
  const [contactName, setContactName] = useState(editing?.contactName || "");
  const [phone, setPhone] = useState(editing?.phone || "");
  const [email, setEmail] = useState(editing?.email || "");
  const [wechat, setWechat] = useState(editing?.wechat || "");
  const [address, setAddress] = useState(editing?.address || "");
  const [paymentCycle, setPaymentCycle] = useState(editing?.paymentCycle || "");
  const [defaultLeadDays, setDefaultLeadDays] = useState(
    editing?.defaultLeadDays != null ? String(editing.defaultLeadDays) : "",
  );
  const [quoteUpdateCycleDays, setQuoteUpdateCycleDays] = useState(
    editing?.quoteUpdateCycleDays != null ? String(editing.quoteUpdateCycleDays) : "",
  );
  // 高级字段
  const [rating, setRating] = useState(editing?.rating != null ? String(editing.rating) : "");
  const [qualityScore, setQualityScore] = useState(
    editing?.qualityScore != null ? String(editing.qualityScore) : "",
  );
  const [deliveryScore, setDeliveryScore] = useState(
    editing?.deliveryScore != null ? String(editing.deliveryScore) : "",
  );
  const [priceScore, setPriceScore] = useState(
    editing?.priceScore != null ? String(editing.priceScore) : "",
  );
  const [preferenceNote, setPreferenceNote] = useState(editing?.preferenceNote || "");
  const [riskNote, setRiskNote] = useState(editing?.riskNote || "");

  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: name.trim(),
        shortName: shortName.trim() || null,
        status,
        category: category || null,
        region: region.trim() || null,
        contactName: contactName.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        wechat: wechat.trim() || null,
        address: address.trim() || null,
        paymentCycle: paymentCycle || null,
        defaultLeadDays: defaultLeadDays === "" ? null : Number(defaultLeadDays),
        quoteUpdateCycleDays: quoteUpdateCycleDays === "" ? null : Number(quoteUpdateCycleDays),
        rating: rating === "" ? null : Number(rating),
        qualityScore: qualityScore === "" ? null : Number(qualityScore),
        deliveryScore: deliveryScore === "" ? null : Number(deliveryScore),
        priceScore: priceScore === "" ? null : Number(priceScore),
        preferenceNote: preferenceNote.trim() || null,
        riskNote: riskNote.trim() || null,
      };

      if (editing) {
        const res = await fetch(`/api/supply/suppliers/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const d = await res.json();
          throw new Error(d.error || "更新失败");
        }
        return res.json();
      }

      const res = await fetch("/api/supply/suppliers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "创建失败");
      }
      return res.json();
    },
    onSuccess: async () => {
      toast.success(editing ? "供应商已更新" : "供应商已创建");
      // 同时失效列表页 (["supply","suppliers",...]) 与详情页缓存
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: SUPPLY_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ["supply", "suppliers"] }),
        queryClient.invalidateQueries({ queryKey: ["supply-supplier-detail"] }),
      ]);
      // 编辑模式走统一关闭函数，触发父级清理；创建模式重置字段。
      if (editing) {
        handleOpenChange(false);
      } else {
        setOpen(false);
        setName("");
        setShortName("");
        setRegion("");
        setContactName("");
        setPhone("");
        setEmail("");
        setWechat("");
        setAddress("");
        setDefaultLeadDays("");
        setQuoteUpdateCycleDays("");
        setRating("");
        setQualityScore("");
        setDeliveryScore("");
        setPriceScore("");
        setPreferenceNote("");
        setRiskNote("");
      }
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v && onClose) onClose();
  };

  const isEditing = !!editing;
  // 编辑模式下若存在主联系人，联系方式事实源是 SupplierContact，主表字段为缓存，
  // 表单中改为只读防止分叉。提示用户去联系人区块编辑主联系人。
  const lockContactFields = isEditing && !!hasPrimaryContact;

  const trigger = editing ? (
    <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
      <Pencil className="h-4 w-4 mr-1" />
      编辑
    </Button>
  ) : (
    <Button size="sm" onClick={() => setOpen(true)}>
      <Plus className="h-4 w-4 mr-1" />
      新增供应商
    </Button>
  );

  return (
    <>
      {trigger}
      <FormSheet
        open={open}
        onOpenChange={handleOpenChange}
        title={editing ? "编辑供应商" : "新增供应商"}
        desktopVariant="scrollable"
        desktopMaxW="sm:max-w-md"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
          className="space-y-4"
        >
          <div>
            <label className="text-sm font-medium">名称 *</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="例如：某某生物科技" />
          </div>
          <div>
            <label className="text-sm font-medium">简称</label>
            <Input value={shortName} onChange={(e) => setShortName(e.target.value)} placeholder="可选" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">状态</label>
              <Select value={status} onValueChange={(v) => v && setStatus(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPLIER_STATUS_VALUES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">类别</label>
              <Select value={category} onValueChange={(v) => v && setCategory(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">不指定</SelectItem>
                  {SUPPLIER_CATEGORY_VALUES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium">地区</label>
            <Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="例如：上海" />
          </div>

          <div className="border-t pt-3">
            <h4 className="mb-2 text-xs font-medium text-muted-foreground">联系方式</h4>
            {lockContactFields && (
              <p className="mb-2 text-xs text-muted-foreground">
                当前存在主联系人，联系方式以主联系人记录为准。如需修改请编辑主联系人。
              </p>
            )}
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium">联系人</label>
                  <Input value={contactName} onChange={(e) => setContactName(e.target.value)} disabled={lockContactFields} />
                </div>
                <div>
                  <label className="text-sm font-medium">电话</label>
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} disabled={lockContactFields} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium">邮箱</label>
                  <Input value={email} onChange={(e) => setEmail(e.target.value)} disabled={lockContactFields} />
                </div>
                <div>
                  <label className="text-sm font-medium">微信</label>
                  <Input value={wechat} onChange={(e) => setWechat(e.target.value)} disabled={lockContactFields} />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium">地址</label>
                <Input value={address} onChange={(e) => setAddress(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="border-t pt-3">
            <h4 className="mb-2 text-xs font-medium text-muted-foreground">商务条款</h4>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium">付款周期</label>
                <Select value={paymentCycle} onValueChange={(v) => v && setPaymentCycle(v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">不指定</SelectItem>
                    {PAYMENT_CYCLE_VALUES.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium">默认货期(天)</label>
                <Input
                  type="number"
                  value={defaultLeadDays}
                  onChange={(e) => setDefaultLeadDays(e.target.value)}
                  placeholder="可选"
                />
              </div>
            </div>
            <div className="mt-3">
              <label className="text-sm font-medium">报价更新周期(天)</label>
              <Input
                type="number"
                value={quoteUpdateCycleDays}
                onChange={(e) => setQuoteUpdateCycleDays(e.target.value)}
                placeholder="可选"
              />
            </div>
          </div>

          <div className="border-t pt-3">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              {showAdvanced ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              高级字段
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-3">
                <div>
                  <label className="text-sm font-medium">评分 (1-5)</label>
                  <Input
                    type="number"
                    min={1}
                    max={5}
                    step={1}
                    value={rating}
                    onChange={(e) => setRating(e.target.value)}
                    placeholder="可选"
                  />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-sm font-medium">质量分</label>
                    <Input type="number" step="0.1" value={qualityScore} onChange={(e) => setQualityScore(e.target.value)} />
                  </div>
                  <div>
                    <label className="text-sm font-medium">交付分</label>
                    <Input type="number" step="0.1" value={deliveryScore} onChange={(e) => setDeliveryScore(e.target.value)} />
                  </div>
                  <div>
                    <label className="text-sm font-medium">价格分</label>
                    <Input type="number" step="0.1" value={priceScore} onChange={(e) => setPriceScore(e.target.value)} />
                  </div>
                </div>
                <div>
                  <label className="text-sm font-medium">偏好备注</label>
                  <Textarea value={preferenceNote} onChange={(e) => setPreferenceNote(e.target.value)} rows={2} />
                </div>
                <div>
                  <label className="text-sm font-medium">风险备注</label>
                  <Textarea value={riskNote} onChange={(e) => setRiskNote(e.target.value)} rows={2} />
                </div>
              </div>
            )}
          </div>

          <Button type="submit" disabled={mutation.isPending || !name.trim()} className="w-full">
            {mutation.isPending ? "保存中..." : editing ? "保存" : "创建"}
          </Button>
        </form>
      </FormSheet>
    </>
  );
}
