"use client";

import { useState, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Loader2, AlertTriangle } from "lucide-react";

interface ProjectLinkInfo {
  projectId: string;
  projectName: string;
  allocatedAmount: number | null;
  isPrimary: boolean;
}

interface OrderRevisionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  orderId: string;
  currentTotalAmount: number;
  financeAmountOverride: number | null;
  category: string;
  financeTreatment: string;
  issuedInvoiceAmount: number;
  receivedAmount: number;
  projectLinks: ProjectLinkInfo[];
}

export function OrderRevisionDialog({
  open,
  onOpenChange,
  onSuccess,
  orderId,
  currentTotalAmount,
  financeAmountOverride,
  category,
  financeTreatment,
  issuedInvoiceAmount,
  receivedAmount,
  projectLinks,
}: OrderRevisionDialogProps) {
  const queryClient = useQueryClient();
  const [newTotalAmount, setNewTotalAmount] = useState(currentTotalAmount);
  const [reason, setReason] = useState("");
  const [syncProjectBudget, setSyncProjectBudget] = useState(false);
  const [allocations, setAllocations] = useState<Record<string, number>>({});

  const oldFinanceAmount = financeAmountOverride ?? currentTotalAmount;
  const delta = newTotalAmount - oldFinanceAmount;
  const overReceived = newTotalAmount < receivedAmount;

  const singleProject = projectLinks.length === 1 ? projectLinks[0] : null;

  // Reset state on open
  const handleOpenChange = (open: boolean) => {
    if (open) {
      setNewTotalAmount(currentTotalAmount);
      setReason("");
      setSyncProjectBudget(false);
      setAllocations({});
    }
    onOpenChange(open);
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        newTotalAmount,
        reason: reason.trim(),
        syncProjectBudget: projectLinks.length > 0 ? syncProjectBudget : undefined,
      };
      if (projectLinks.length > 1) {
        body.allocations = projectLinks.map((l) => ({
          projectId: l.projectId,
          allocatedAmount: allocations[l.projectId] ?? (l.allocatedAmount ?? 0),
        }));
      }
      const res = await fetch(`/api/orders/${orderId}/revisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "修订失败" }));
        throw new Error(err.error || "修订失败");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["order", orderId] });
      queryClient.invalidateQueries({ queryKey: ["order", orderId, "revisions"] });
      queryClient.invalidateQueries({ queryKey: ["finance", "summary"] });
      queryClient.invalidateQueries({ queryKey: ["finance", "progress-receivables"] });
      onSuccess?.();
      onOpenChange(false);
    },
  });

  const previewAdj = useMemo(() => {
    if (Math.abs(delta) < 0.001) return 0;
    if (category === "PRODUCT" || category === "UNKNOWN") return delta;
    if (financeTreatment === "STANDALONE" || projectLinks.length === 0) return delta * 0.3;
    // PROJECT_INCLUDED — depends on project status, show max possible
    return delta;
  }, [delta, category, financeTreatment, projectLinks.length]);

  const allocationSum = projectLinks.length > 1
    ? projectLinks.reduce((s, l) => s + (allocations[l.projectId] ?? l.allocatedAmount ?? 0), 0)
    : 0;
  const allocationValid = projectLinks.length <= 1 || Math.abs(allocationSum - newTotalAmount) < 0.01;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle>修订订单金额</DialogTitle>
          <DialogDescription>
            修订后订单金额会立即更新，进度款调整将计入当前月份。
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-4 min-h-0 overflow-y-auto overscroll-contain px-4 pb-1" style={{ WebkitOverflowScrolling: "touch" }}>
        <div className="space-y-4 py-2">
          {/* Current amount */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <Label>当前订单金额</Label>
              <p className="font-medium mt-1">¥{currentTotalAmount.toLocaleString()}</p>
            </div>
            <div>
              <Label>有效财务金额</Label>
              <p className="font-medium mt-1">¥{oldFinanceAmount.toLocaleString()}</p>
            </div>
          </div>

          {/* New amount */}
          <div className="space-y-1">
            <Label htmlFor="newAmount">新订单金额</Label>
            <Input
              id="newAmount"
              type="number"
              step="0.01"
              min={0}
              value={newTotalAmount}
              onChange={(e) => setNewTotalAmount(parseFloat(e.target.value) || 0)}
            />
          </div>

          {/* Delta */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">差额：</span>
            <Badge variant={delta >= 0 ? "default" : "destructive"}>
              {delta >= 0 ? "+" : ""}¥{delta.toLocaleString()}
            </Badge>
          </div>

          {/* Boundaries */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-muted-foreground">已开票金额</span>
              <p className="font-medium">¥{issuedInvoiceAmount.toLocaleString()}</p>
            </div>
            <div>
              <span className="text-muted-foreground">已到款金额</span>
              <p className="font-medium">¥{receivedAmount.toLocaleString()}</p>
            </div>
          </div>

          {newTotalAmount < issuedInvoiceAmount && (
            <p className="text-red-500 text-sm flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" />
              新金额小于已开票金额，请先冲红或重开发票
            </p>
          )}
          {overReceived && (
            <p className="text-amber-500 text-sm flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" />
              新金额小于已到款金额，订单将显示为超收状态
            </p>
          )}

          {/* Project allocations */}
          {projectLinks.length === 1 && singleProject && (
            <div className="text-sm space-y-1 border rounded-md p-3">
              <p className="font-medium">关联项目：{singleProject.projectName}</p>
              <p className="text-muted-foreground">
                当前分摊：¥{(singleProject.allocatedAmount ?? oldFinanceAmount).toLocaleString()}
                {" → "}¥{newTotalAmount.toLocaleString()}
              </p>
              <label className="flex items-center gap-2 mt-2">
                <input
                  type="checkbox"
                  checked={syncProjectBudget}
                  onChange={(e) => setSyncProjectBudget(e.target.checked)}
                  className="rounded"
                />
                <span className="text-xs text-muted-foreground">同步更新项目预算</span>
              </label>
            </div>
          )}

          {projectLinks.length > 1 && (
            <div className="space-y-2 border rounded-md p-3">
              <p className="text-sm font-medium">多项目分摊</p>
              {projectLinks.map((l) => (
                <div key={l.projectId} className="flex items-center gap-2 text-sm">
                  <span className="w-32 truncate">{l.projectName}</span>
                  <Input
                    type="number"
                    step="0.01"
                    className="w-28 h-7 text-xs"
                    value={allocations[l.projectId] ?? l.allocatedAmount ?? 0}
                    onChange={(e) =>
                      setAllocations((prev) => ({ ...prev, [l.projectId]: parseFloat(e.target.value) || 0 }))
                    }
                  />
                </div>
              ))}
              <p className={`text-xs ${allocationValid ? "text-muted-foreground" : "text-red-500"}`}>
                分摊合计：¥{allocationSum.toLocaleString()}
                {!allocationValid && ` (需要等于 ¥${newTotalAmount.toLocaleString()})`}
              </p>
            </div>
          )}

          {/* Preview adjustment */}
          <div className="text-sm space-y-1 border rounded-md p-3 bg-muted/30">
            <p className="font-medium">预计进度款调整</p>
            <p className="text-muted-foreground">
              影响月份：{new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long" })}
            </p>
            <Badge variant={previewAdj >= 0 ? "default" : "destructive"}>
              {previewAdj >= 0 ? "+" : ""}¥{previewAdj.toLocaleString()}
            </Badge>
            <p className="text-xs text-muted-foreground mt-1">
              {category === "PRODUCT" ? "商品类订单按100%确认" :
               financeTreatment === "STANDALONE" ? "独立服务订单按30%确认" :
               "项目关联服务订单按项目交付状态决定比例"}
            </p>
          </div>

          {/* Reason */}
          <div className="space-y-1">
            <Label htmlFor="revisionReason">修订原因 *</Label>
            <Textarea
              id="revisionReason"
              placeholder="请填写修订原因"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
            />
          </div>
        </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={
              !reason.trim() ||
              Math.abs(delta) < 0.001 ||
              newTotalAmount < issuedInvoiceAmount ||
              !allocationValid ||
              mutation.isPending
            }
          >
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            确认修订
          </Button>
        </DialogFooter>

        {mutation.isError && (
          <p className="text-red-500 text-sm">{(mutation.error as Error).message}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
