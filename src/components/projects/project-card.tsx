"use client";

import * as React from "react";
import { List, MessageSquare, Paperclip, MoreHorizontal } from "lucide-react";
import { ProjectItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

/* ── helpers ─────────────────────────────────────────────── */

function formatDateShort(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function isOverdue(endDate?: string | null, status?: string): boolean {
  if (!endDate || status === "COMPLETED" || status === "TERMINATED") return false;
  return new Date(endDate) < new Date(new Date().toDateString());
}

/**
 * 进度条颜色：参考图中 orange = 进行中, green = 完成, red/pink = 低进度/逾期。
 * 我们映射：COMPLETED → green, TERMINATED → red, ON_HOLD → amber,
 * 其余按进度值：< 30 red, < 70 orange, >= 70 green-ish。
 */
function progressBarColor(status: string, progress: number): string {
  if (status === "COMPLETED") return "bg-green-500";
  if (status === "TERMINATED") return "bg-red-400";
  if (status === "ON_HOLD") return "bg-amber-400";
  if (status === "NOT_STARTED") return "bg-muted-foreground/30";
  // IN_PROGRESS — color by progress level
  if (progress < 30) return "bg-red-400";
  if (progress < 70) return "bg-orange-400";
  return "bg-green-500";
}

/* ── component ───────────────────────────────────────────── */

export interface ProjectCardProps {
  project: ProjectItem;
  onClick?: (project: ProjectItem) => void;
}

/**
 * 项目网格小卡 — 参考 Notion/ClickUp 风格：
 * 白底 + 细边框 + 无左边框色条，状态靠进度条颜色 + 日期药丸传达。
 */
export function ProjectCard({ project, onClick }: ProjectCardProps) {
  const handleClick = () => onClick?.(project);
  const subtitle = project.cust?.name ?? project.client ?? project.organization ?? null;
  const endDateStr = formatDateShort(project.endDate);
  const overdue = isOverdue(project.endDate, project.status);
  const ticketCount = project._count?.tickets ?? 0;
  const commentCount = project._count?.comments ?? 0;
  const barColor = progressBarColor(project.status, project.progress);

  return (
    <Card
      variant="interactive"
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleClick(); } }}
      className={cn(
        "group relative gap-3 p-4",
        project.deleted && "opacity-60",
        project.archived && !project.deleted && "opacity-80",
      )}
    >
      {/* ── Row 1: title + ⋯ ── */}
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold leading-snug line-clamp-1 flex-1">
          {project.name}
        </h3>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 flex items-center justify-center h-7 w-7 rounded-full border bg-background text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity hover:bg-muted"
          aria-label="更多操作"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* ── Row 2: subtitle ── */}
      {subtitle && (
        <p className="-mt-1.5 text-xs text-muted-foreground line-clamp-1">{subtitle}</p>
      )}

      {/* ── Row 3: progress label + fraction ── */}
      <div className="flex items-center justify-between text-xs">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <List className="h-3.5 w-3.5" />
          Progress
        </span>
        <span className="font-medium tabular-nums text-foreground">
          {project.progress}/100
        </span>
      </div>

      {/* ── Row 4: progress bar ── */}
      <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", barColor)}
          style={{ width: `${Math.min(100, Math.max(0, project.progress))}%` }}
        />
      </div>

      {/* ── Row 5: date pill + avatars / counts ── */}
      <div className="flex items-center justify-between">
        {/* date pill */}
        {endDateStr ? (
          <span
            className={cn(
              "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
              overdue
                ? "bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400"
                : "bg-muted text-muted-foreground",
            )}
          >
            {endDateStr}
          </span>
        ) : (
          <span />
        )}

        {/* right side: avatars if members, else comment + ticket counts */}
        {project.members && project.members.length > 0 ? (
          <div className="flex items-center -space-x-1.5">
            {project.members.slice(0, 2).map((m) => (
              <div
                key={m.user.id}
                className="h-6 w-6 rounded-full bg-primary/80 text-primary-foreground text-[10px] flex items-center justify-center ring-2 ring-card"
                title={m.user.name ?? undefined}
              >
                {(m.user.name ?? "?").slice(0, 1).toUpperCase()}
              </div>
            ))}
            {project.members.length > 2 && (
              <div className="h-6 w-6 rounded-full bg-muted text-muted-foreground text-[10px] flex items-center justify-center ring-2 ring-card">
                +{project.members.length - 2}
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2.5 text-muted-foreground">
            {commentCount > 0 && (
              <span className="inline-flex items-center gap-1 text-xs tabular-nums">
                <MessageSquare className="h-3.5 w-3.5" />
                {commentCount}
              </span>
            )}
            {ticketCount > 0 && (
              <span className="inline-flex items-center gap-1 text-xs tabular-nums">
                <Paperclip className="h-3.5 w-3.5" />
                {ticketCount}
              </span>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/** 归档/删除徽章 — 详情页等场景复用 */
export function ProjectBadges({ project }: { project: ProjectItem }) {
  if (!project.archived && !project.deleted) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      {project.archived && "已归档"}
      {project.deleted && "已删除"}
    </span>
  );
}
