"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectDisplay,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";

const COST_TYPES = [
  { value: "PROCUREMENT", label: "采购成本" }, { value: "EXPERIMENT", label: "实验成本" },
  { value: "LABOR", label: "人工成本" }, { value: "LOGISTICS", label: "物流成本" },
  { value: "PLATFORM", label: "平台成本" }, { value: "MARKETING", label: "市场获客成本" },
  { value: "ENTERTAINMENT", label: "招待成本" }, { value: "REFUND", label: "退款/冲减" },
  { value: "OTHER", label: "其他" },
];

export interface CostFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultOrderId?: string;
  defaultProfileId?: string;
  defaultProjectId?: string;
  defaultAmount?: number;
  onCreated?: () => void;
}

export function CostFormDialog({
  open, onOpenChange, defaultOrderId, defaultProfileId,
  defaultProjectId, defaultAmount, onCreated,
}: CostFormDialogProps) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState(defaultAmount && defaultAmount > 0 ? String(defaultAmount) : "");
  const [costType, setCostType] = useState("OTHER");
  const [remark, setRemark] = useState("");

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/finance/costs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: Number(amount),
          costType,
          profileId: defaultProfileId || null,
          orderId: defaultOrderId || null,
          projectId: defaultProjectId || null,
          remark: remark || null,
        }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "创建失败"); }
      return res.json();
    },
    onSuccess: () => {
      toast.success("成本已记录");
      queryClient.invalidateQueries({ queryKey: ["finance-costs"] });
      setAmount("");
      setCostType("OTHER");
      setRemark("");
      onOpenChange(false);
      onCreated?.();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleSubmit = () => {
    if (!amount || Number(amount) <= 0) { toast.error("请输入有效的成本金额"); return; }
    createMutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新增成本</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium">金额 *</label>
            <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </div>
          <div>
            <label className="text-sm font-medium">成本类型</label>
            <Select value={costType} onValueChange={(v) => v && setCostType(v)}>
              <SelectTrigger><SelectDisplay label="其他" valueLabel={COST_TYPES.find(c => c.value === costType)?.label || "其他"} /></SelectTrigger>
              <SelectContent>
                {COST_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-sm font-medium">备注</label>
            <Input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="备注说明" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button onClick={handleSubmit} disabled={createMutation.isPending}>
              {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}确认
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
