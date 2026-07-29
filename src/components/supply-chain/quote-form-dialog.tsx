"use client";

import { useState, useEffect, useMemo } from "react";
import { FormSheet } from "@/components/ui/form-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Pencil } from "lucide-react";
import { QUOTE_STATUS, QUOTE_SOURCE } from "@/lib/supply-chain/constants";

interface QuoteFormDialogProps {
  startOpen?: boolean;
  onClose?: () => void;
  editing?: {
    id: string;
    supplierId: string;
    supplierName?: string;
    productSkuId?: string | null;
    skuDisplay?: string | null;
    serviceKey?: string | null;
    itemName: string;
    spec: string | null;
    unit: string | null;
    listPrice: number;
    quotedPrice: number;
    negotiatedPrice: number | null;
    floorPriceHint: number | null;
    leadDays: number | null;
    validFrom: string | null;
    validTo: string | null;
    updateCycleDays: number | null;
    status: string;
    remark: string | null;
  };
}

interface SupplierItem {
  id: string;
  name: string;
}
interface PurchasableSkuOption {
  productSkuId: string;
  displayName: string;
  skuCode: string;
  skuName: string;
  productCode: string;
  productName: string;
}

// 失效必须覆盖列表页订阅 key `["supply", "quotes", ...]`，否则保存后列表不刷新。
const QUOTE_QUERY_KEY = ["supply", "quotes"] as const;

export function QuoteFormDialog({ startOpen, onClose, editing }: QuoteFormDialogProps) {
  const [open, setOpen] = useState(startOpen || false);
  const [supplierId, setSupplierId] = useState(editing?.supplierId || "");
  const [productSkuId, setProductSkuId] = useState(editing?.productSkuId || "");
  const [supplierSkuCode, setSupplierSkuCode] = useState("");
  const [itemName, setItemName] = useState(editing?.itemName || "");
  const [spec, setSpec] = useState(editing?.spec || "");
  const [unit, setUnit] = useState(editing?.unit || "");
  const [listPrice, setListPrice] = useState(editing ? String(editing.listPrice) : "");
  const [quotedPrice, setQuotedPrice] = useState(editing ? String(editing.quotedPrice) : "");
  const [negotiatedPrice, setNegotiatedPrice] = useState(editing?.negotiatedPrice ? String(editing.negotiatedPrice) : "");
  const [floorPriceHint, setFloorPriceHint] = useState(editing?.floorPriceHint ? String(editing.floorPriceHint) : "");
  const [leadDays, setLeadDays] = useState(editing?.leadDays ? String(editing.leadDays) : "");
  const [validFrom, setValidFrom] = useState(editing?.validFrom?.split("T")[0] || "");
  const [validTo, setValidTo] = useState(editing?.validTo?.split("T")[0] || "");
  const [updateCycleDays, setUpdateCycleDays] = useState(editing?.updateCycleDays ? String(editing.updateCycleDays) : "");
  const [status, setStatus] = useState(editing?.status || "ACTIVE");
  const [source, setSource] = useState("MANUAL");
  const [remark, setRemark] = useState(editing?.remark || "");
  const queryClient = useQueryClient();

  // 查供应商和可采购 SKU 列表用于 Select
  const [suppliers, setSuppliers] = useState<SupplierItem[]>([]);
  const [purchasableSkus, setPurchasableSkus] = useState<PurchasableSkuOption[]>([]);

  useEffect(() => {
    if (open && !editing) {
      Promise.all([
        fetch("/api/supply/suppliers?pageSize=100").then((r) => r.json()),
        // review #4：报价表单需要 purchasable 而非 sellable
        fetch("/api/products?options=purchasable").then((r) => r.json()),
      ]).then(([sData, skuData]) => {
        setSuppliers(sData.suppliers || []);
        const opts: PurchasableSkuOption[] = skuData.options || [];
        setPurchasableSkus(opts);
      });
    }
  }, [open, editing]);

  // 选择 SKU 时自动填充 itemName/spec/unit
  const skuMap = useMemo(() => {
    const m = new Map<string, PurchasableSkuOption>();
    for (const s of purchasableSkus) m.set(s.productSkuId, s);
    return m;
  }, [purchasableSkus]);

  const handleSelectSku = (id: string) => {
    setProductSkuId(id);
    const sku = id ? skuMap.get(id) : undefined;
    if (sku) {
      setItemName(sku.skuName);
    }
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const payload = {
        listPrice: Number(listPrice),
        quotedPrice: Number(quotedPrice),
        negotiatedPrice: negotiatedPrice ? Number(negotiatedPrice) : null,
        floorPriceHint: floorPriceHint ? Number(floorPriceHint) : null,
        leadDays: leadDays ? Number(leadDays) : null,
        validFrom: validFrom || null,
        validTo: validTo || null,
        updateCycleDays: updateCycleDays ? Number(updateCycleDays) : null,
        status,
        remark: remark.trim() || null,
      };

      if (editing) {
        const res = await fetch(`/api/supply/quotes/${editing.id}`, {
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

      const res = await fetch("/api/supply/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          supplierId,
          productSkuId: productSkuId || null,
          supplierSkuCode: supplierSkuCode.trim() || null,
          itemName: itemName.trim(),
          spec: spec.trim() || null,
          unit: unit.trim() || null,
          source,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "创建失败");
      }
      return res.json();
    },
    onSuccess: async () => {
      toast.success(editing ? "报价已更新" : "报价已创建");
      await queryClient.invalidateQueries({ queryKey: QUOTE_QUERY_KEY });
      handleOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v && onClose) onClose();
  };

  const isEditing = !!editing;

  return (
    <>
      {!isEditing && (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />新增报价
        </Button>
      )}
      {isEditing && (
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          <Pencil className="h-3.5 w-3.5 mr-1" />编辑
        </Button>
      )}
      <FormSheet
        open={open}
        onOpenChange={handleOpenChange}
        title={isEditing ? "编辑报价" : "新增报价"}
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
          {/* 识别字段——创建时可编辑，编辑时只读 */}
          <div>
            <label className="text-sm font-medium">供应商 *</label>
            {isEditing ? (
              <Input value={editing?.supplierName || supplierId} disabled />
            ) : (
              <Select value={supplierId} onValueChange={(v) => v && setSupplierId(v)}>
                <SelectTrigger>
                  <SelectValue placeholder="选择供应商" />
                </SelectTrigger>
                <SelectContent>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {/* Phase 2 review #2：产品 SKU 选择器（新事实源），替代旧 ServiceCatalog */}
          <div>
            <label className="text-sm font-medium">产品 SKU *</label>
            {isEditing ? (
              <Input value={editing?.skuDisplay || productSkuId || "（未绑定 SKU）"} disabled />
            ) : (
              <Select value={productSkuId} onValueChange={(v) => v && handleSelectSku(v)}>
                <SelectTrigger>
                  <SelectValue placeholder="选择产品 SKU" />
                </SelectTrigger>
                <SelectContent>
                  {purchasableSkus.length === 0 ? (
                    <SelectItem value="__none" disabled>暂无可采购 SKU，请先在产品目录创建</SelectItem>
                  ) : (
                    purchasableSkus.map((s) => (
                      <SelectItem key={s.productSkuId} value={s.productSkuId}>
                        {s.displayName}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            )}
          </div>
          {!isEditing && (
            <div>
              <label className="text-sm font-medium">供应商货号（可选）</label>
              <Input value={supplierSkuCode} onChange={(e) => setSupplierSkuCode(e.target.value)} placeholder="供应商自己的货号" />
            </div>
          )}
          <div>
            <label className="text-sm font-medium">项目名称 *</label>
            <Input
              value={itemName}
              onChange={(e) => setItemName(e.target.value)}
              required
              disabled={isEditing}
              placeholder="例如：10x Genomics 单细胞 RNA-seq"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">规格</label>
              <Input value={spec} onChange={(e) => setSpec(e.target.value)} disabled={isEditing} placeholder="规格" />
            </div>
            <div>
              <label className="text-sm font-medium">单位</label>
              <Input value={unit} onChange={(e) => setUnit(e.target.value)} disabled={isEditing} placeholder="样本/批次" />
            </div>
          </div>

          {/* 价格字段——始终可编辑 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">目录价（元）*</label>
              <Input type="number" step="0.01" value={listPrice} onChange={(e) => setListPrice(e.target.value)} required />
            </div>
            <div>
              <label className="text-sm font-medium">报价（元）*</label>
              <Input type="number" step="0.01" value={quotedPrice} onChange={(e) => setQuotedPrice(e.target.value)} required />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">成交价（元）</label>
              <Input type="number" step="0.01" value={negotiatedPrice} onChange={(e) => setNegotiatedPrice(e.target.value)} />
            </div>
            <div>
              <label className="text-sm font-medium">底价提示（元）</label>
              <Input type="number" step="0.01" value={floorPriceHint} onChange={(e) => setFloorPriceHint(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">货期（天）</label>
              <Input type="number" value={leadDays} onChange={(e) => setLeadDays(e.target.value)} />
            </div>
            <div>
              <label className="text-sm font-medium">刷新周期（天）</label>
              <Input type="number" value={updateCycleDays} onChange={(e) => setUpdateCycleDays(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">生效日期</label>
              <Input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
            </div>
            <div>
              <label className="text-sm font-medium">失效日期</label>
              <Input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">状态</label>
              <Select value={status} onValueChange={(v) => v && setStatus(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(QUOTE_STATUS).map((s) => (
                    <SelectItem key={s} value={s}>
                      {s === "ACTIVE" ? "有效" : s === "EXPIRED" ? "已过期" : "已归档"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!isEditing && (
              <div>
                <label className="text-sm font-medium">来源</label>
                <Select value={source} onValueChange={(v) => v && setSource(v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(QUOTE_SOURCE).map((s) => (
                      <SelectItem key={s} value={s}>
                        {s === "MANUAL" ? "手工" : s === "IMPORT" ? "导入" : s === "NEGOTIATION" ? "谈判" : "历史订单"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div>
            <label className="text-sm font-medium">备注</label>
            <Textarea value={remark} onChange={(e) => setRemark(e.target.value)} rows={2} />
          </div>
          <Button
            type="submit"
            disabled={mutation.isPending || (!isEditing && (!supplierId || !productSkuId || !itemName.trim() || !listPrice || !quotedPrice))}
            className="w-full"
          >
            {mutation.isPending ? "保存中..." : isEditing ? "保存" : "创建"}
          </Button>
        </form>
      </FormSheet>
    </>
  );
}
