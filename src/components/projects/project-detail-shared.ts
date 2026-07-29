import type { ProjectItem } from "@/lib/types";

/**
 * 项目详情页共享常量与类型 —— 由 page.tsx 及其子组件（header/overview/edit-dialog 等）复用。
 * 纯结构搬迁，无逻辑变更。
 */

export const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  NOT_STARTED: { label: "未开始", color: "text-slate-600", bg: "bg-slate-100" },
  IN_PROGRESS: { label: "进行中", color: "text-blue-600", bg: "bg-blue-100" },
  COMPLETED: { label: "已完成", color: "text-green-600", bg: "bg-green-100" },
  ON_HOLD: { label: "暂停", color: "text-amber-600", bg: "bg-amber-100" },
  TERMINATED: { label: "终止", color: "text-rose-600", bg: "bg-rose-100" },
};

export interface ProjectDetailPermissions {
  canRead: boolean;
  canContribute: boolean;
  canManage: boolean;
  canViewInvoices: boolean;
  canUploadFiles: boolean;
}

/** 编辑表单使用的字段类型（与 page.tsx 中 editForm 一致）。 */
export type ProjectEditForm = Partial<
  ProjectItem & { startDate?: string | null; endDate?: string | null }
>;

/** 编辑 Dialog 内协作者管理使用的成员结构。 */
export interface ProjectEditMember {
  userId: string;
  role: string;
  user: { id: string; name: string; email: string };
}

/** 用户搜索返回项结构。 */
export interface ProjectMemberSearchResult {
  id: string;
  name: string;
  email: string;
  role: string;
}
