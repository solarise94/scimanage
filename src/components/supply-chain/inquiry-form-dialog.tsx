"use client";

import { useState, useEffect } from "react";
import { FormSheet } from "@/components/ui/form-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Pencil } from "lucide-react";
import { INQUIRY_STATUS } from "@/lib/supply-chain/constants";

interface InquiryFormDialogProps {
  startOpen?: boolean;
  onClose?: () => void;
  editing?: {
    id: string;
    supplierId: string;
    supplierName?: string;
    requestedItem: string;
    status: string;
    finalPrice: number | null;
    respondedLeadDays: number | null;
    note: string | null;
  };
}

interface SupplierItem {
  id: string;
  name: string;
}

// 失效必须覆盖列表页订阅 key `["supply", "inquiries", ...]`，否则保存后列表不刷新。
const INQUIRY_QUERY_KEY = ["supply", "inquiries"] as const;

export function InquiryFormDialog({ startOpen, onClose, editing }: InquiryFormDialogProps) {
  const [open, setOpen] = useState(startOpen || false);
  const [supplierId, setSupplierId] = useState(editing?.supplierId || "");
  const [requestedItem, setRequestedItem] = useState(editing?.requestedItem || "");
  const [spec, setSpec] = useState("");
  const [quantity, setQuantity] = useState("");
  const [targetPrice, setTargetPrice] = useState("");
  const [finalPrice, setFinalPrice] = useState(editing?.finalPrice ? String(editing.finalPrice) : "");
  const [respondedLeadDays, setRespondedLeadDays] = useState(
    editing?.respondedLeadDays ? String(editing.respondedLeadDays) : "",
  );
  const [status, setStatus] = useState(editing?.status || "OPEN");
  const [note, setNote] = useState(editing?.note || "");
  const [suppliers, setSuppliers] = useState<SupplierItem[]>([]);
  const queryClient = useQueryClient();

  const isEditing = !!editing;

  useEffect(() => {
    if (open && !isEditing) {
      fetch("/api/supply/suppliers?pageSize=100")
        .then((r) => r.json())
        .then((d) => setSuppliers(d.suppliers || []));
    }
  }, [open, isEditing]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (isEditing) {
        // 反馈模式：只更新 finalPrice/respondedLeadDays/status/note
        const res = await fetch(`/api/supply/inquiries/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            finalPrice: finalPrice ? Number(finalPrice) : null,
            responseLeadDays: respondedLeadDays ? Number(respondedLeadDays) : null,
            status,
            note: note.trim() || null,
          }),
        });
        if (!res.ok) {
          const d = await res.json();
          throw new Error(d.error || "更新失败");
        }
        return res.json();
      }

      // 创建模式
      const res = await fetch("/api/supply/inquiries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplierId,
          requestedItem: requestedItem.trim(),
          requestedSpec: spec.trim() || null,
          quantity: quantity ? Number(quantity) : null,
          targetPrice: targetPrice ? Number(targetPrice) : null,
          note: note.trim() || null,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "创建失败");
      }
      return res.json();
    },
    onSuccess: async () => {
      toast.success(isEditing ? "询价反馈已保存" : "询价已创建");
      await queryClient.invalidateQueries({ queryKey: INQUIRY_QUERY_KEY });
      // 走统一关闭函数，触发 onClose 清理父级 editingInquiry。
      handleOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v && onClose) onClose();
  };

  return (
    <>
      {!isEditing && (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />新建询价
        </Button>
      )}
      {isEditing && (
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          <Pencil className="h-3.5 w-3.5 mr-1" />反馈
        </Button>
      )}
      <FormSheet
        open={open}
        onOpenChange={handleOpenChange}
        title={isEditing ? "录入询价反馈" : "新建询价"}
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
          {!isEditing && (
            <>
              <div>
                <label className="text-sm font-medium">供应商 *</label>
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
              </div>
              <div>
                <label className="text-sm font-medium">询价项目 *</label>
                <Input
                  value={requestedItem}
                  onChange={(e) => setRequestedItem(e.target.value)}
                  required
                  placeholder="例如：单细胞 RNA-seq 测序服务"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium">规格</label>
                  <Input value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="规格要求" />
                </div>
                <div>
                  <label className="text-sm font-medium">数量</label>
                  <Input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="样本数" />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium">目标价（元）</label>
                <Input type="number" step="0.01" value={targetPrice} onChange={(e) => setTargetPrice(e.target.value)} />
              </div>
            </>
          )}

          {isEditing && (
            <>
              <div>
                <label className="text-sm font-medium">状态</label>
                <Select value={status} onValueChange={(v) => v && setStatus(v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(INQUIRY_STATUS).map((s) => (
                      <SelectItem key={s} value={s}>
                        {s === "OPEN" ? "待回复" : s === "RESPONDED" ? "已回复" : s === "CLOSED" ? "已关闭" : "已流失"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium">最终报价（元）</label>
                  <Input type="number" step="0.01" value={finalPrice} onChange={(e) => setFinalPrice(e.target.value)} />
                </div>
                <div>
                  <label className="text-sm font-medium">回复货期（天）</label>
                  <Input type="number" value={respondedLeadDays} onChange={(e) => setRespondedLeadDays(e.target.value)} />
                </div>
              </div>
            </>
          )}

          <div>
            <label className="text-sm font-medium">备注</label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </div>
          <Button
            type="submit"
            disabled={mutation.isPending || (!isEditing && (!supplierId || !requestedItem.trim()))}
            className="w-full"
          >
            {mutation.isPending ? "保存中..." : isEditing ? "保存反馈" : "创建询价"}
          </Button>
        </form>
      </FormSheet>
    </>
  );
}
