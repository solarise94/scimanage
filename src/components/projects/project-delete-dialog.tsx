"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

/**
 * 项目删除确认 Dialog。
 *
 * 纯结构搬迁自 `src/app/projects/[id]/page.tsx`（原 Delete Confirmation Dialog）。
 * 受控状态由父组件持有，本组件不维护任何业务数据。
 */
export interface ProjectDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
  reason: string;
  onReasonChange: (reason: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  isPending: boolean;
}

export function ProjectDeleteDialog({
  open,
  onOpenChange,
  projectName,
  reason,
  onReasonChange,
  onConfirm,
  onCancel,
  isPending,
}: ProjectDeleteDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-600">
            <AlertTriangle className="h-5 w-5" />
            确认删除项目
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            此操作将软删除项目 &quot;{projectName}&quot;。项目数据将被保留，但不再显示在常规列表中。
          </p>
          <div className="space-y-2">
            <label className="text-sm font-medium">删除原因 <span className="text-red-500">*</span></label>
            <Textarea
              value={reason}
              onChange={(e) => onReasonChange(e.target.value)}
              placeholder="请填写删除原因..."
              rows={3}
            />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={onCancel}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={!reason.trim() || isPending}
              onClick={onConfirm}
            >
              {isPending ? "删除中..." : "确认删除"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
