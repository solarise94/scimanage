"use client";

import { Archive } from "lucide-react";
import type { ProjectItem } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ProjectDetailPermissions } from "@/components/projects/project-detail-shared";

/**
 * 项目概览区：进度 Slider + 元信息行 + 成员头像 + 可归档提示横幅。
 *
 * 纯结构搬迁自 `src/app/projects/[id]/page.tsx`（原行 996-1081）。
 * 本地拖拽进度值由父组件（page.tsx）持有并通过 props 注入，
 * 以保持 useEffect 同步服务器进度的逻辑不变。
 */
export interface ProjectOverviewProps {
  project: ProjectItem;
  permissions: ProjectDetailPermissions | undefined;
  /** 本地拖拽的临时进度值（undefined 时回退到 project.progress）。 */
  sliderValue: number | undefined;
  onSliderValueChange: (value: number) => void;
  onSliderCommit: (value: number) => void;
  /** 可归档提示横幅中「归档项目」按钮。 */
  onArchive: () => void;
  isArchiving: boolean;
}

export function ProjectOverview({
  project,
  permissions,
  sliderValue,
  onSliderValueChange,
  onSliderCommit,
  onArchive,
  isArchiving,
}: ProjectOverviewProps) {
  return (
    <>
      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span>项目进度</span>
          <span className="font-medium">{project.progress}%</span>
        </div>
        {permissions?.canManage && !project.deleted ? (
          <Slider
            value={[sliderValue !== undefined ? sliderValue : project.progress]}
            max={100}
            step={1}
            onValueChange={(val) => {
              const arr = Array.isArray(val) ? val : [val];
              onSliderValueChange(arr[0]);
            }}
            onValueCommitted={(val) => {
              const arr = Array.isArray(val) ? val : [val];
              onSliderCommit(arr[0]);
            }}
          />
        ) : (
          <Progress value={project.progress} className="h-2" />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
        <span className="bg-muted px-2 py-0.5 rounded text-xs font-medium">项目号: {project.projectNo || "未生成"}</span>
        {project.orderNumber && (
          <span className="bg-muted px-2 py-0.5 rounded text-xs font-medium">订单: {project.orderNumber}</span>
        )}
        {project.organization && <span className="hidden sm:inline">{project.organization}</span>}
        {(project.cust?.name || project.client) && <span>客户: {project.cust?.name ?? project.client}</span>}
        {(project.rep?.name || project.representative) && <span className="hidden sm:inline">代表: {project.rep?.name ?? project.representative}</span>}
        {project.startDate && (
          <span className="hidden sm:inline">开始: {new Date(project.startDate).toLocaleDateString("zh-CN")}</span>
        )}
        {project.endDate && (
          <span className="hidden sm:inline">截止: {new Date(project.endDate).toLocaleDateString("zh-CN")}</span>
        )}
        <span>{project._count?.tickets ?? 0} 工单</span>
        <span>{project._count?.comments ?? 0} 评论</span>
        <span>{project._count?.attachments ?? 0} 文件</span>
      </div>

      <div className="flex sm:hidden flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {project.organization && <span>{project.organization}</span>}
        {(project.rep?.name || project.representative) && <span>代表: {project.rep?.name ?? project.representative}</span>}
        {project.startDate && project.endDate && (
          <span>{new Date(project.startDate).toLocaleDateString("zh-CN")} ~ {new Date(project.endDate).toLocaleDateString("zh-CN")}</span>
        )}
      </div>

      {project.members && project.members.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">成员:</span>
          <div className="flex -space-x-2">
            {project.members.map((m) => (
              <Avatar key={m.user.id} className="h-7 w-7 ring-2 ring-background">
                <AvatarFallback className="bg-primary text-primary-foreground text-[10px]">
                  {m.user.name?.slice(0, 2)?.toUpperCase()}
                </AvatarFallback>
              </Avatar>
            ))}
          </div>
        </div>
      )}

      {/* 可归档提示横幅：三态全齐且尚未归档 */}
      {!project.deleted && !project.archived && project.archiveNotice && !project.archiveNotice.archivedAt && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/40">
          <div className="flex items-center gap-2 text-emerald-800 dark:text-emerald-300">
            <Archive className="h-4 w-4 shrink-0" />
            <span>该项目的合同 / 发票 / 订单三态已全齐，可以归档。</span>
          </div>
          {permissions?.canManage && (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 border-emerald-300 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:text-emerald-300"
              onClick={onArchive}
              disabled={isArchiving}
            >
              <Archive className="mr-1 h-3 w-3" /> 归档项目
            </Button>
          )}
        </div>
      )}
    </>
  );
}
