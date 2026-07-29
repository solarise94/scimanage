"use client";

import { Archive, Trash2, MoreHorizontal, ClipboardCopy } from "lucide-react";
import type { ReactNode } from "react";
import type { ProjectItem } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/ui/page-header";
import { ProjectDetailPermissions, STATUS_CONFIG } from "@/components/projects/project-detail-shared";

/**
 * 项目详情 Header（PageHeader + 状态徽章 + 操作按钮组）。
 *
 * 纯结构搬迁自 `src/app/projects/[id]/page.tsx`（原行 494-976 的非 Dialog 部分）。
 * 编辑 / 删除 Dialog 已拆分为独立组件，由父组件渲染，因此本组件不渲染 Dialog。
 */
export interface ProjectDetailHeaderProps {
  project: ProjectItem;
  permissions: ProjectDetailPermissions | undefined;
  /** 是否正在归档（archiveMutation.isPending）。 */
  isArchiving: boolean;
  onEdit: () => void;
  onArchiveToggle: () => void;
  onRequestDelete: () => void;
  onCopyFeishuRow: () => void;
  /** 返回链接；嵌入 Agent 工作区时传 undefined 隐藏返回箭头。 */
  backHref?: string;
}

export function ProjectDetailHeader({
  project,
  permissions,
  isArchiving,
  onEdit,
  onArchiveToggle,
  onRequestDelete,
  onCopyFeishuRow,
  backHref = "/projects",
}: ProjectDetailHeaderProps) {
  const actions: ReactNode = (
    <div className="flex items-center gap-2 flex-wrap justify-end">
      <Badge className={STATUS_CONFIG[project.status]?.bg + " " + STATUS_CONFIG[project.status]?.color}>
        {STATUS_CONFIG[project.status]?.label || project.status}
      </Badge>
      {project.archived && (
        <Badge variant="secondary">
          <Archive className="h-3 w-3 mr-0.5" />
          已归档
        </Badge>
      )}
      {project.deleted && (
        <Badge variant="destructive">
          <Trash2 className="h-3 w-3 mr-0.5" />
          已删除
        </Badge>
      )}
      {!project.deleted && permissions?.canManage && (
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <Button variant="outline" size="sm" onClick={onEdit}>
            编辑项目
          </Button>
          {/* 次级操作（归档/删除/复制飞书）全断点收敛进「更多」菜单 */}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
              <MoreHorizontal className="h-3.5 w-3.5 mr-1" />更多
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onArchiveToggle} disabled={isArchiving}>
                <Archive className="mr-2 h-4 w-4" />
                {project.archived ? "取消归档" : "归档"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onCopyFeishuRow}>
                <ClipboardCopy className="mr-2 h-4 w-4" />
                复制到飞书
              </DropdownMenuItem>
              <DropdownMenuItem className="text-destructive" onClick={onRequestDelete}>
                <Trash2 className="mr-2 h-4 w-4" />
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );

  return (
    <PageHeader
      title={project.name}
      description={project.description || "暂无描述"}
      backHref={backHref}
      backLabel="返回项目列表"
      actions={actions}
    />
  );
}
