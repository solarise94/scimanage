"use client";

import { useState } from "react";
import {
  Download,
  MoreHorizontal,
  Archive,
  ArchiveRestore,
  Trash2,
  FileText,
  ImageIcon,
  Loader2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";

/**
 * 项目附件卡片（Files Tab、Timeline Tab、已归档折叠区、迁移中间态共用）。
 *
 * 管理操作可见性：
 *  - 归档/恢复：canManage（ADMIN 或项目 OWNER）。
 *  - 永久删除：canDelete（仅 ADMIN），且后端要求附件必须先归档（两阶段）。
 *  - 下载：活跃态可见；归档/迁移中间态不提供下载。
 *  - pendingStatus：仅 MIGRATING（迁移恢复中）+「重试恢复」（触发 archived GET 机会式 resume）。
 *    普通上传 FAILED 不走此入口。
 */
interface ReferencingNote {
  noteId: string;
  preview: string;
  createdAt: string;
}

export function AttachmentCard({
  projectId,
  attachmentId,
  filename,
  url,
  size,
  mimeType,
  canManage,
  canDelete,
  archived = false,
  pendingStatus,
  compact,
  onChanged,
}: {
  projectId: string;
  attachmentId: string;
  filename: string;
  url: string;
  size: number;
  mimeType: string;
  canManage: boolean;
  /** 永久删除权限（仅 ADMIN）。 */
  canDelete?: boolean;
  /** 已归档态：菜单显示「恢复」而非「归档」，且不显示下载。 */
  archived?: boolean;
  /** 迁移中间态：仅 MIGRATING（恢复中，不可下载；重试会触发 resume）。 */
  pendingStatus?: "MIGRATING";
  /** Timeline Tab 用紧凑横排布局（无 Card 外壳）；Files Tab 用完整 Card。 */
  compact?: boolean;
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    referencingNotes: ReferencingNote[];
    force: boolean;
    initFetch: boolean;
  }>({ open: false, referencingNotes: [], force: false, initFetch: false });

  const isImage = mimeType.startsWith("image/");
  const Icon = isImage ? ImageIcon : FileText;
  const isPending = pendingStatus === "MIGRATING";
  const statusLabel = isPending ? "迁移恢复中" : archived ? "已归档" : null;

  async function patchArchived(nextArchived: boolean) {
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/attachments/${attachmentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: nextArchived }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "操作失败");
        return;
      }
      toast.success(nextArchived ? "已归档" : "已恢复");
      onChanged?.();
    } catch {
      toast.error("操作失败");
    } finally {
      setBusy(false);
    }
  }

  /** 触发服务端机会式恢复（archived GET 会跑 resume），再刷新列表。 */
  async function retryPendingRecovery() {
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/attachments/archived`);
      if (!res.ok) {
        toast.error("重试失败");
        return;
      }
      toast.success("已尝试续接迁移");
      onChanged?.();
    } catch {
      toast.error("重试失败");
    } finally {
      setBusy(false);
    }
  }

  function requestDelete() {
    setDeleteDialog({ open: true, referencingNotes: [], force: false, initFetch: false });
  }

  async function doDelete(force: boolean) {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/attachments/${attachmentId}${force ? "?force=true" : ""}`,
        { method: "DELETE" },
      );
      const data = await res.json().catch(() => ({}));

      if (res.status === 409 && data.code === "ATTACHMENT_REFERENCED_BY_NOTES") {
        setDeleteDialog({
          open: true,
          referencingNotes: (data.referencingNotes as ReferencingNote[]) ?? [],
          force: false,
          initFetch: true,
        });
        return;
      }
      if (!res.ok) {
        toast.error(data.error ?? "删除失败");
        return;
      }
      toast.success("已永久删除");
      setDeleteDialog({ open: false, referencingNotes: [], force: false, initFetch: false });
      onChanged?.();
    } catch {
      toast.error("删除失败");
    } finally {
      setBusy(false);
    }
  }

  function renderMenu() {
    if (!canManage) return null;
    if (isPending) {
      return (
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 h-8 text-xs"
          disabled={busy}
          onClick={() => void retryPendingRecovery()}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "重试恢复"}
        </Button>
      );
    }
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className={compact ? "shrink-0 h-7 w-7" : "shrink-0 h-8 w-8"}
              disabled={busy}
            />
          }
        >
          {busy ? (
            <Loader2 className={compact ? "h-3.5 w-3.5 animate-spin" : "h-4 w-4 animate-spin"} />
          ) : (
            <MoreHorizontal className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {archived ? (
            <DropdownMenuItem onClick={() => patchArchived(false)}>
              <ArchiveRestore className="mr-2 h-3.5 w-3.5" /> 恢复
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => patchArchived(true)}>
              <Archive className="mr-2 h-3.5 w-3.5" /> 归档
            </DropdownMenuItem>
          )}
          {canDelete && archived ? (
            <DropdownMenuItem variant="destructive" onClick={requestDelete}>
              <Trash2 className="mr-2 h-3.5 w-3.5" /> 永久删除
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (compact) {
    return (
      <>
        <div className="flex items-center gap-2 bg-muted rounded-lg p-3">
          <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm truncate flex-1 min-w-0">{filename}</span>
          {statusLabel ? (
            <span className="text-[10px] text-muted-foreground shrink-0">{statusLabel}</span>
          ) : null}
          {!archived && !isPending ? (
            <a href={url} download className="shrink-0">
              <Download className="h-4 w-4 text-muted-foreground hover:text-foreground" />
            </a>
          ) : null}
          {renderMenu()}
        </div>
        <DeleteConfirmDialog
          state={deleteDialog}
          onOpenChange={(open) => setDeleteDialog((s) => ({ ...s, open }))}
          onForceChange={(force) => setDeleteDialog((s) => ({ ...s, force }))}
          onConfirm={() => doDelete(deleteDialog.force)}
          busy={busy}
          filename={filename}
        />
      </>
    );
  }

  return (
    <>
      <Card>
        <CardContent className="p-4 flex items-center gap-3">
          <Icon className="h-8 w-8 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{filename}</p>
            <p className="text-xs text-muted-foreground">
              {(size / 1024).toFixed(1)} KB
              {statusLabel ? (
                <span className={isPending ? "ml-2 text-amber-700/90" : "ml-2 text-muted-foreground/70"}>
                  {statusLabel}
                </span>
              ) : null}
            </p>
          </div>
          {!archived && !isPending ? (
            <a href={url} download className="shrink-0">
              <Download className="h-4 w-4 text-muted-foreground hover:text-foreground" />
            </a>
          ) : null}
          {renderMenu()}
        </CardContent>
      </Card>
      <DeleteConfirmDialog
        state={deleteDialog}
        onOpenChange={(open) => setDeleteDialog((s) => ({ ...s, open }))}
        onForceChange={(force) => setDeleteDialog((s) => ({ ...s, force }))}
        onConfirm={() => doDelete(deleteDialog.force)}
        busy={busy}
        filename={filename}
      />
    </>
  );
}

/**
 * 永久删除确认 Dialog。
 * - initFetch=false（首次打开）：简单二次确认（用户需再点「确认删除」）。
 * - initFetch=true（409 后）：展示受影响备注 + 「强制删除」勾选。
 */
function DeleteConfirmDialog({
  state,
  onOpenChange,
  onForceChange,
  onConfirm,
  busy,
  filename,
}: {
  state: { open: boolean; referencingNotes: ReferencingNote[]; force: boolean; initFetch: boolean };
  onOpenChange: (open: boolean) => void;
  onForceChange: (force: boolean) => void;
  onConfirm: () => void;
  busy: boolean;
  filename: string;
}) {
  const hasRefs = state.referencingNotes.length > 0;
  return (
    <Dialog open={state.open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>永久删除文件「{filename}」？</DialogTitle>
          <DialogDescription>
            此操作不可恢复。删除后数据库记录与私有文件都将被清除。
          </DialogDescription>
        </DialogHeader>

        {hasRefs ? (
          <div className="space-y-2">
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              该文件被 {state.referencingNotes.length} 条项目备注引用，直接删除会使备注中的附件链接失效。
            </div>
            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-lg border bg-muted/30 p-2 text-xs">
              {state.referencingNotes.map((n) => (
                <li key={n.noteId} className="truncate text-muted-foreground">
                  · {n.preview || "（空备注）"}
                </li>
              ))}
            </ul>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={state.force}
                onChange={(e) => onForceChange(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-muted-foreground">
                强制删除：接受级联删除备注引用（备注文本保留，但附件链接将失效）
              </span>
            </label>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={busy || (hasRefs && !state.force)}
          >
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {hasRefs ? "强制删除" : "确认删除"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
