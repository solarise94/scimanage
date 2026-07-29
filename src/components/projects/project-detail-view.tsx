"use client";

/**
 * ProjectDetailView — shared project detail surface.
 *
 * Extracted from `src/app/projects/[id]/page.tsx` so the same data loading,
 * mutations, dialogs and inline Tabs can render either as the standalone page
 * (`mode="page"`) or embedded inside the Agent workspace Resource Panel /
 * Sheet (`mode="panel" | "sheet"`).
 *
 * Cache: shares every project queryKey (`["project", projectId]`,
 * `["timeline", projectId]`, `["tickets", projectId]`, `["procurement-channels"]`)
 * with the standalone page, so opening the embedded view after viewing the page
 * is instant and mutations on either side refresh both.
 *
 * Navigation differences by mode:
 *   - PageShell / PageHeader back arrow (`/projects`): only rendered in `page`
 *     mode. panel/sheet mode renders a compact container without PageShell.
 *   - Ticket links (`/tickets/{id}`): `page` mode keeps the router push;
 *     panel/sheet mode goes through `useResourceNavigation().onNavigateResource`
 *     ("ticket", id) so it pushes onto the Agent resource history.
 *   - Order links (`/orders?focus=...`): `page` mode keeps the Next `<Link>`;
 *     panel/sheet mode uses `onNavigateResource("order", id)`. The empty-state
 *     "去订单管理" href uses `onNavigateHref`.
 *   - Delete success: `page` mode uses `router.push("/projects")`; panel/sheet
 *     mode delegates to `useResourceNavigation().onNavigateHref?.("/projects")`.
 *
 * All API, permissions and mutation logic is unchanged from the original page.
 */

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Clock,
  CheckCircle2,
  Circle,
  MessageSquare,
  Paperclip,
  Ticket,
  Send,
  Upload,
  MoreHorizontal,
  Loader2,
  Activity,
  Plus,
  AlertTriangle,
  Archive,
  Sparkles,
  Receipt,
  Banknote,
  Package,
  Flag,
} from "lucide-react";
import { ProjectItem, TimelineItem, TicketItem } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { AnimatedTabPanel } from "@/components/ui/animated-tab-panel";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { MilestonePanel } from "@/components/milestone-panel";

import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PushToFollowUpButton } from "@/components/crm/push-to-follow-up-button";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { zhCN } from "date-fns/locale";
import { DraftInputPanel } from "@/components/draft-input-panel";
import { projectToFeishuRow } from "@/lib/feishu-export";
import { normalizeProjectType } from "@/lib/project-type";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ProjectDetailHeader,
} from "@/components/projects/project-detail-header";
import { ProjectOverview } from "@/components/projects/project-overview";
import { ProjectEditDialog } from "@/components/projects/project-edit-dialog";
import { ProjectDeleteDialog } from "@/components/projects/project-delete-dialog";
import { AttachmentCard } from "@/components/projects/attachment-card";
import {
  ProjectDetailPermissions,
  ProjectEditForm,
  ProjectEditMember,
  ProjectMemberSearchResult,
} from "@/components/projects/project-detail-shared";
import {
  useResourceNavigation,
  type ResourceViewMode,
} from "@/components/agent/resource-navigation-context";

const TREATMENT_LABELS: Record<string, string> = { AUTO: "自动", STANDALONE: "独立计入", PROJECT_INCLUDED: "并入项目", EXCLUDED: "排除" };

const ACTIVITY_ICONS: Record<string, React.ElementType> = {
  PROJECT_CREATED: Activity,
  PROJECT_UPDATED: Activity,
  STATUS_CHANGED: Clock,
  PROGRESS_UPDATED: CheckCircle2,
  COMMENT_ADDED: MessageSquare,
  FILE_UPLOADED: Paperclip,
  TICKET_CREATED: Ticket,
  TICKET_UPDATED: Ticket,
  MEMBER_ADDED: Circle,
  PLUGIN_MESSAGE: Sparkles,
  INVOICE_CREATED: Receipt,
  INVOICE_UPDATED: Receipt,
};

function safeParseMetadata(metadata: string | null): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed;
  } catch (err) {
    console.warn("[PROJECT] metadata JSON parse failed:", err);
    return {};
  }
}

function metaStr(m: Record<string, unknown>, key: string, fallback = ""): string {
  const v = m[key];
  return typeof v === "string" ? v : fallback;
}

function getTimelineWeight(item: TimelineItem): "high" | "medium" | "low" {
  const high = new Set(["COMMENT_ADDED", "FILE_UPLOADED", "TICKET_CREATED", "TICKET_UPDATED", "INVOICE_CREATED", "INVOICE_UPDATED", "STATUS_CHANGED"]);
  const medium = new Set(["PROJECT_CREATED", "PROJECT_UPDATED", "REPRESENTATIVE_CHANGED", "PROJECT_ARCHIVED", "PROJECT_UNARCHIVED", "MEMBER_ADDED"]);
  if (high.has(item.type)) return "high";
  if (medium.has(item.type)) return "medium";
  if (item.type === "PROGRESS_UPDATED") return "low";
  if (item.kind === "plugin") return "high";
  return "medium";
}

export interface ProjectDetailViewProps {
  projectId: string;
  /** Standalone page vs. embedded Agent workspace. */
  mode: ResourceViewMode;
  /** Page-mode only: initial active tab from `?tab=` search param. Ignored in
   *  panel/sheet mode (defaults to "timeline"). */
  initialTab?: string;
}

export function ProjectDetailView({ projectId, mode, initialTab = "timeline" }: ProjectDetailViewProps) {
  const router = useRouter();
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const { confirm } = useConfirm();
  const { onNavigateResource, onNavigateHref } = useResourceNavigation();

  const isEmbedded = mode !== "page";

  const [activeTab, setActiveTab] = useState(initialTab || "timeline");

  const [comment, setComment] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<ProjectEditForm>({});
  const [editOrgId, setEditOrgId] = useState("");
  const [editCustomerOrgId, setEditCustomerOrgId] = useState<string | null>(null);
  const [repTouched, setRepTouched] = useState(false);
  const [customerTouched, setCustomerTouched] = useState(false);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [ticketForm, setTicketForm] = useState({ title: "", description: "", priority: "MEDIUM", reminderDate: "" });
  const [isDraggingTimeline, setIsDraggingTimeline] = useState(false);
  const [isDraggingTickets, setIsDraggingTickets] = useState(false);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [isArchivedExpanded, setIsArchivedExpanded] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [sliderValue, setSliderValue] = useState<number | undefined>(undefined);
  const [showLowWeight, setShowLowWeight] = useState(false);
  const [pluginRunning, setPluginRunning] = useState(false);
  const [editMembers, setEditMembers] = useState<ProjectEditMember[]>([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [memberSearchResults, setMemberSearchResults] = useState<ProjectMemberSearchResult[]>([]);
  const [memberSearching, setMemberSearching] = useState(false);
  const commentFileInputRef = useRef<HTMLInputElement>(null);

  const openEditDialog = () => {
    if (!project) return;
    setEditForm({
      ...project,
      projectType: normalizeProjectType(project.projectType) || project.projectType,
    });
    setEditOrgId("");
    setEditCustomerOrgId(project.cust?.organizationId || null);
    setRepTouched(false);
    setCustomerTouched(false);
    const ms = (project.members || []).map((m: Record<string, unknown>) => ({
      userId: (m.userId || (m.user as Record<string, unknown>)?.id) as string,
      role: m.role as string,
      user: m.user as { id: string; name: string; email: string },
    }));
    setEditMembers(ms);
    setEditOpen(true);
  };

  const copyFeishuRow = () => {
    if (!project) return;
    const text = projectToFeishuRow(project);
    navigator.clipboard.writeText(text).then(
      () => toast.success("已复制到剪贴板，可直接粘贴到飞书"),
      () => toast.error("复制失败"),
    );
  };

  const { data: projectData, isLoading: projectLoading } = useQuery<{ project: ProjectItem; permissions?: { canRead: boolean; canContribute: boolean; canManage: boolean; canViewInvoices: boolean; canUploadFiles: boolean } }>({
    queryKey: ["project", projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}`);
      if (!res.ok) throw new Error("Failed to load project");
      return res.json();
    },
  });

  const { data: timelineData, isLoading: timelineLoading } = useQuery<{ timeline: TimelineItem[] }>({
    queryKey: ["timeline", projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/timeline`);
      if (!res.ok) throw new Error("Failed to load timeline");
      return res.json();
    },
  });

  // 已归档 + 迁移中间态 MIGRATING（仅 canManage 可见；打开时服务端机会式 resume）。
  const { data: archivedData } = useQuery<{
    attachments: Array<{ id: string; filename: string; url: string; size: number; mimeType: string; archivedAt: string; createdAt: string }>;
    pendingMigrations: Array<{
      id: string;
      filename: string;
      url: string;
      size: number;
      mimeType: string;
      status: "MIGRATING" | string;
      createdAt: string;
    }>;
  }>({
    queryKey: ["archived-attachments", projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/attachments/archived`);
      if (!res.ok) throw new Error("Failed to load archived attachments");
      return res.json();
    },
    enabled: !!projectData?.permissions?.canManage,
  });

  const { data: ticketsData } = useQuery<{ tickets: TicketItem[] }>({
    queryKey: ["tickets", projectId],
    queryFn: async () => {
      const res = await fetch(`/api/tickets?projectId=${projectId}`);
      if (!res.ok) throw new Error("Failed to load tickets");
      return res.json();
    },
  });

  const { data: channelsData } = useQuery<{ channels: { id: string; name: string }[] }>({
    queryKey: ["procurement-channels"],
    queryFn: async () => {
      const res = await fetch("/api/procurement-channels");
      if (!res.ok) throw new Error("Failed to load channels");
      return res.json();
    },
  });
  const channels = channelsData?.channels || [];

  const updateMutation = useMutation({
    mutationFn: async (payload: Partial<ProjectItem & { startDate?: string | null; endDate?: string | null }>) => {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let detail = "更新失败";
        try {
          const body = await res.json();
          if (body?.error) detail = body.error;
        } catch { /* keep default */ }
        throw new Error(detail);
      }
      return res.json() as Promise<{ project: ProjectItem }>;
    },
    onError: (err) => {
      toast.error(err.message || "更新失败");
      setSliderValue(undefined);
    },
    onSuccess: (data) => {
      if (data?.project) {
        queryClient.setQueryData(
          ["project", projectId],
          (old: { project: ProjectItem; permissions?: ProjectDetailPermissions } | undefined) =>
            old
              ? { ...old, project: { ...old.project, ...data.project } }
              : { project: data.project },
        );
      }
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["timeline", projectId] });
      setSliderValue(undefined);
      toast.success("项目更新成功");
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async (archived: boolean) => {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived }),
      });
      if (!res.ok) throw new Error("Failed to archive");
      return res.json();
    },
    onSuccess: (_, archived) => {
      toast.success(archived ? "项目已归档" : "项目已取消归档");
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: () => toast.error("操作失败"),
  });

  const deleteMutation = useMutation({
    mutationFn: async (reason: string) => {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) throw new Error("Failed to delete");
      return res.json();
    },
    onSuccess: () => {
      toast.success("项目已删除");
      setDeleteOpen(false);
      setDeleteReason("");
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
      // page mode: stay in the router; embedded mode: hand off to the Agent
      // resource navigator so it leaves the workspace to the list.
      if (isEmbedded) {
        onNavigateHref?.("/projects");
      } else {
        router.push("/projects");
      }
    },
    onError: (err: Error) => toast.error(err.message || "删除失败"),
  });

  const commentMutation = useMutation({
    mutationFn: async (content: string) => {
      const res = await fetch(`/api/projects/${projectId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error("Failed to post comment");
      return res.json();
    },
    onSuccess: () => {
      setComment("");
      queryClient.invalidateQueries({ queryKey: ["timeline", projectId] });
    },
    onError: () => toast.error("评论失败"),
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/projects/${projectId}/attachments`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        let detail = "上传失败";
        try {
          const body = await res.json();
          if (body?.error) detail = body.error;
        } catch { /* keep default */ }
        throw new Error(detail);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("上传成功");
      queryClient.invalidateQueries({ queryKey: ["timeline", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (err: Error) => toast.error(err.message || "上传失败"),
  });

  const commentUploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/projects/${projectId}/attachments`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        let detail = "附件上传失败";
        try {
          const body = await res.json();
          if (body?.error) detail = body.error;
        } catch { /* keep default */ }
        throw new Error(detail);
      }
      return res.json();
    },
    onSuccess: (data) => {
      const url = data?.attachment?.url || "";
      const name = data?.attachment?.filename || "文件";
      const isImage = data?.attachment?.mimeType?.startsWith("image/");
      const markdown = isImage
        ? `![${name}](${url})`
        : `[${name}](${url})`;
      setComment((prev) => prev + (prev ? "\n" : "") + markdown);
      toast.success(isImage ? "图片已添加" : "附件已添加");
    },
    onError: (err: Error) => toast.error(err.message || "附件上传失败"),
  });

  const ticketMutation = useMutation({
    mutationFn: async (payload: { title: string; description: string; priority: string; reminderDate: string }) => {
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, projectId }),
      });
      if (!res.ok) throw new Error("Failed to create ticket");
      return res.json();
    },
    onSuccess: () => {
      toast.success("工单创建成功");
      setTicketOpen(false);
      setTicketForm({ title: "", description: "", priority: "MEDIUM", reminderDate: "" });
      queryClient.invalidateQueries({ queryKey: ["tickets", projectId] });
      queryClient.invalidateQueries({ queryKey: ["timeline", projectId] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
    },
    onError: () => toast.error("创建工单失败"),
  });

  const updateTicketMutation = useMutation({
    mutationFn: async ({ ticketId, status }: { ticketId: string; status: string }) => {
      const res = await fetch(`/api/tickets/${ticketId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error("Failed to update ticket");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tickets", projectId] });
      queryClient.invalidateQueries({ queryKey: ["timeline", projectId] });
    },
  });

  const deleteTicketMutation = useMutation({
    mutationFn: async (ticketId: string) => {
      const res = await fetch(`/api/tickets/${ticketId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete ticket");
      return res.json();
    },
    onSuccess: () => {
      toast.success("工单已删除");
      queryClient.invalidateQueries({ queryKey: ["tickets", projectId] });
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
      queryClient.invalidateQueries({ queryKey: ["timeline", projectId] });
    },
    onError: () => toast.error("删除工单失败"),
  });

  // When server progress catches up to the locally-dragged value, clear the override
  useEffect(() => {
    const progress = projectData?.project?.progress;
    if (sliderValue !== undefined && progress !== undefined && sliderValue === progress) {
      const timer = setTimeout(() => setSliderValue(undefined), 0);
      return () => clearTimeout(timer);
    }
  }, [projectData?.project?.progress, sliderValue]);

  // ── Loading / empty states differ by mode ─────────────────────────────
  if (projectLoading) {
    if (isEmbedded) {
      return (
        <div className="space-y-3 p-4">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-32" />
        </div>
      );
    }
    return (
      <PageShell>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32" />
      </PageShell>
    );
  }

  const project = projectData?.project;
  if (!project) {
    if (isEmbedded) {
      return (
        <div className="p-4">
          <div className="rounded-lg border p-6 text-center">
            <h2 className="text-base font-medium">项目不存在</h2>
          </div>
        </div>
      );
    }
    return <div>项目不存在</div>;
  }

  const timeline = timelineData?.timeline || [];
  const tickets = ticketsData?.tickets || [];
  const attachments = timeline.filter((t) => t.kind === "attachment");
  const permissions = projectData?.permissions as ProjectDetailPermissions | undefined;
  const isAdmin = session?.user?.role === "ADMIN";
  const isInternal = session?.user?.role === "ADMIN" || session?.user?.role === "USER";
  const canManageTicket = isInternal || (project.members?.some((m: { user: { id: string }; role: string }) => m.user.id === session?.user?.id && m.role === "OWNER") ?? false);

  // ── Internal navigation helpers (mode-aware) ──────────────────────────
  // page mode: keep original router push / next/link behaviour.
  // panel/sheet mode: route through useResourceNavigation so the target
  // pushes onto the Agent resource history instead of leaving the workspace.
  const navigateTicket = (ticketId: string) => {
    if (isEmbedded && onNavigateResource) {
      onNavigateResource("ticket", ticketId);
    } else {
      router.push(`/tickets/${ticketId}`);
    }
  };

  const navigateOrder = (orderId: string) => {
    if (isEmbedded && onNavigateResource) {
      onNavigateResource("order", orderId);
    }
    // page mode uses next/link <Link href={`/orders?focus=${o.id}`}> below,
    // so no router fallback is needed here.
  };

  async function runTimelinePlugin(pluginKey: string) {
    setPluginRunning(true);
    try {
      const res = await fetch("/api/plugins/timeline/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginKey, projectId }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "插件执行失败");
        return;
      }
      if (data.published) {
        toast.success(data.result?.summary || "插件消息已发布");
        queryClient.invalidateQueries({ queryKey: ["timeline", projectId] });
      }
    } catch {
      toast.error("网络错误");
    } finally {
      setPluginRunning(false);
    }
  }

  /**
   * 编辑表单保存处理：先更新项目，再按需保存协作者，最后可选地同步客户主数据到所选单位。
   * 原内联于编辑 Dialog 的 form onSubmit 中，搬迁为独立函数以便抽出的 ProjectEditDialog 复用。
   */
  async function handleEditSubmit() {
    if (!project) return;
    const payload: Partial<ProjectItem & { startDate?: string | null; endDate?: string | null }> = {
      name: editForm.name,
      description: editForm.description,
      projectNo: editForm.projectNo,
      organization: editForm.organization,
      client: editForm.client,
      status: editForm.status,
      progress: editForm.progress,
      startDate: editForm.startDate,
      endDate: editForm.endDate,
      projectType: editForm.projectType,
      projectContent: editForm.projectContent,
      quantity: editForm.quantity,
      procurementSource: editForm.procurementSource,
      brand: editForm.brand,
      techSupport: editForm.techSupport,
    };
    if (customerTouched) {
      payload.profileId = editForm.profileId;
    }
    if (repTouched) {
      payload.representative = editForm.representative;
      payload.representativeId = editForm.representativeId;
    }

    // Step 1: update project
    try {
      await updateMutation.mutateAsync(payload);
    } catch {
      return; // onError already shows toast
    }

    // Step 2: save collaborators if changed
    const membersChanged = (() => {
      const origMemberIds = (project.members || []).map((m) => m.user.id).sort().join(",");
      const newMemberIds = editMembers.map((m) => m.userId).sort().join(",");
      if (origMemberIds !== newMemberIds) return true;
      return editMembers.some((m) => {
        const orig = (project.members || []).find((om) => om.user.id === m.userId);
        return orig && orig.role !== m.role;
      });
    })();

    if (membersChanged) {
      try {
        const collabRes = await fetch(`/api/projects/${projectId}/collaborators`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ members: editMembers.map((m) => ({ userId: m.userId, role: m.role })) }),
        });
        if (!collabRes.ok) {
          toast.error("协作者保存失败");
          return;
        }
      } catch {
        toast.error("协作者保存失败");
        return;
      }
    }

    // Both succeeded
    toast.success("更新成功");
    setEditOpen(false);
    queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    queryClient.invalidateQueries({ queryKey: ["timeline", projectId] });
    queryClient.invalidateQueries({ queryKey: ["projects"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });

    // Post-save: offer to link customer to selected organization
    const profileIdForLink = editForm.profileId;
    const orgId = editOrgId;
    const orgName = editForm.organization;
    const custHadOrg = !!editCustomerOrgId;
    if (profileIdForLink && orgId && orgName && !custHadOrg) {
      const confirmed = await confirm({
        title: "同步关联单位",
        description: `是否将单位「${orgName}」同步关联到客户主数据？`,
      });
      if (confirmed) {
        try {
          const linkRes = await fetch(`/api/customers/${profileIdForLink}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", "x-customer-api-caller": "projects-detail" },
            body: JSON.stringify({ organizationId: orgId, organization: orgName }),
          });
          if (linkRes.ok) {
            toast.success("客户已关联到该单位");
            queryClient.invalidateQueries({ queryKey: ["customers-list"] });
          } else {
            toast.warning("客户关联单位失败，项目已保存成功");
          }
        } catch {
          toast.warning("客户关联单位失败，项目已保存成功");
        }
      }
    }
  }

  function renderCommentContent(content: string) {
    const images: string[] = [];
    const files: { name: string; url: string }[] = [];
    const imgRegex = /!\[(.*?)\]\((.*?)\)/g;
    const linkRegex = /\[(.*?)\]\((.*?)\)/g;
    let m;
    while ((m = imgRegex.exec(content)) !== null) {
      images.push(m[2]);
    }
    let plainContent = content.replace(imgRegex, "").trim();
    while ((m = linkRegex.exec(content)) !== null) {
      if (!images.includes(m[2])) {
        files.push({ name: m[1], url: m[2] });
      }
    }
    plainContent = plainContent.replace(linkRegex, "").trim();

    return (
      <>
        {plainContent && <div className="text-sm whitespace-pre-wrap">{plainContent}</div>}
        {images.length > 0 && (
          <div className="flex gap-2 flex-wrap mt-2">
            {images.map((url, i) => (
              <img
                key={i}
                src={url}
                alt="attachment"
                className="h-20 w-20 object-cover rounded cursor-pointer"
                onClick={() => setPreviewImage(url)}
              />
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="flex flex-col gap-1 mt-2">
            {files.map((f, i) => (
              <a key={i} href={f.url} download className="text-sm text-primary hover:underline flex items-center gap-1">
                <Paperclip className="h-3 w-3" />
                {f.name}
              </a>
            ))}
          </div>
        )}
      </>
    );
  }

  // ── Body (Header + Overview + Tabs + Image Preview Dialog) ────────────
  // Rendered identically for both modes; only the outer container differs.
  const body = (
    <>
      <ProjectDetailHeader
        project={project}
        permissions={permissions}
        isArchiving={archiveMutation.isPending}
        onEdit={openEditDialog}
        onArchiveToggle={() => archiveMutation.mutate(!project.archived)}
        onRequestDelete={() => setDeleteOpen(true)}
        onCopyFeishuRow={copyFeishuRow}
        backHref={mode === "page" ? "/projects" : undefined}
      />

      <ProjectEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        projectId={projectId}
        editForm={editForm}
        onEditFormChange={setEditForm}
        editOrgId={editOrgId}
        onEditOrgIdChange={setEditOrgId}
        editCustomerOrgId={editCustomerOrgId}
        onEditCustomerOrgIdChange={setEditCustomerOrgId}
        onRepTouchedChange={setRepTouched}
        onCustomerTouchedChange={setCustomerTouched}
        editMembers={editMembers}
        onEditMembersChange={setEditMembers}
        memberSearch={memberSearch}
        onMemberSearchChange={setMemberSearch}
        memberSearchResults={memberSearchResults}
        onMemberSearchResultsChange={setMemberSearchResults}
        memberSearching={memberSearching}
        onMemberSearchingChange={setMemberSearching}
        channels={channels}
        onSubmit={handleEditSubmit}
        isSaving={updateMutation.isPending}
      />

      <ProjectDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        projectName={project.name}
        reason={deleteReason}
        onReasonChange={setDeleteReason}
        onConfirm={() => deleteMutation.mutate(deleteReason.trim())}
        onCancel={() => { setDeleteOpen(false); setDeleteReason(""); }}
        isPending={deleteMutation.isPending}
      />

      {/* Deleted warning banner */}
      {project.deleted && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-red-800">此项目已被删除</p>
            <p className="text-sm text-red-700 mt-1">
        删除原因：{project.deletedReason || "未记录"}
            </p>
            {project.deletedAt && (
              <p className="text-xs text-red-600 mt-1">
          删除时间：{new Date(project.deletedAt).toLocaleString("zh-CN")}
              </p>
            )}
          </div>
        </div>
      )}

      <ProjectOverview
        project={project}
        permissions={permissions}
        sliderValue={sliderValue}
        onSliderValueChange={(v: number) => setSliderValue(v)}
        onSliderCommit={(v: number) => updateMutation.mutate({ progress: v })}
        onArchive={() => archiveMutation.mutate(true)}
        isArchiving={archiveMutation.isPending}
      />

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="w-full" variant="line">
          <TabsTrigger value="timeline" className="flex-1 sm:flex-initial">
            <Activity className="mr-2 h-4 w-4" />
            时间流
          </TabsTrigger>
          <TabsTrigger value="tickets" className="flex-1 sm:flex-initial">
            <Ticket className="mr-2 h-4 w-4" />
            工单
          </TabsTrigger>
          <TabsTrigger value="files" className="flex-1 sm:flex-initial">
            <Paperclip className="mr-2 h-4 w-4" />
            文件
          </TabsTrigger>
          <TabsTrigger value="orders" className="flex-1 sm:flex-initial">
            <Package className="mr-2 h-4 w-4" />
            关联订单
          </TabsTrigger>
          <TabsTrigger value="milestones" className="flex-1 sm:flex-initial">
            <Flag className="mr-2 h-4 w-4" />
            周期节点
          </TabsTrigger>
        </TabsList>

        {/* Timeline Tab */}
        <AnimatedTabPanel activeValue={activeTab} value="timeline" className="space-y-4">
          <Card
            className={!project.deleted && permissions?.canUploadFiles && isDraggingTimeline ? "border-primary border-2 border-dashed" : ""}
            onDragOver={(e) => { e.preventDefault(); if (permissions?.canUploadFiles && !project.deleted) setIsDraggingTimeline(true); else setIsDraggingTimeline(false); }}
            onDragLeave={() => setIsDraggingTimeline(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDraggingTimeline(false);
              if (project.deleted || !permissions?.canUploadFiles) return;
              const file = e.dataTransfer.files?.[0];
              if (file) uploadMutation.mutate(file);
            }}
          >
            <CardContent className="p-4 space-y-4">
              {timelineLoading ? (
                <div className="space-y-4">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-16" />
                  ))}
                </div>
              ) : timeline.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">暂无动态</div>
              ) : (
                (() => {
                  const importantItems = timeline.filter((item) => getTimelineWeight(item) !== "low");
                  const lowItems = timeline.filter((item) => getTimelineWeight(item) === "low");
                  const visibleItems = showLowWeight ? timeline : importantItems;
                  const HiddenTimelineItem = ({ item, isLast }: { item: TimelineItem; isLast: boolean }) => {
                    const Icon = ACTIVITY_ICONS[item.type] || Activity;
                    const isComment = item.kind === "comment";
                    const isPlugin = item.kind === "plugin";
                    const isTicketEvent = item.type === "TICKET_CREATED" || item.type === "TICKET_UPDATED";
                    const meta = safeParseMetadata(item.metadata);
                    const ticketId = metaStr(meta, "ticketId") || metaStr(meta.ticket as Record<string, unknown> | undefined ?? {}, "id");
                    const ticket = ticketId ? tickets.find((t) => t.id === ticketId) : null;
                    const mPluginName = metaStr(meta, "pluginName") || "插件";
                    const mFormat = metaStr(meta, "format");

                    return (
                      <div className="relative pl-8 pb-6 last:pb-0">
                        {!isLast && (
                          <div className="absolute left-[11px] top-6 bottom-0 w-px bg-border" />
                        )}
                        <div className="absolute left-0 top-0 h-6 w-6 rounded-full bg-muted flex items-center justify-center">
                          <Icon className="h-3 w-3 text-muted-foreground" />
                        </div>
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            {isPlugin ? (
                              <span className="font-medium text-sm text-muted-foreground">{mPluginName}</span>
                            ) : item.user ? (
                              <span className="font-medium text-sm">{item.user.name}</span>
                            ) : null}
                            {!isPlugin && <span className="text-sm text-muted-foreground">{item.content}</span>}
                            {isTicketEvent && ticket && (
                              project.deleted ? (
                                <Badge variant="secondary" className="text-xs">
                                  {ticket.status === "OPEN" ? "打开" : ticket.status === "IN_PROGRESS" ? "处理中" : "已关闭"}
                                </Badge>
                              ) : (
                                <Select
                                  value={ticket.status}
                                  onValueChange={(newStatus) => { if (newStatus) updateTicketMutation.mutate({ ticketId: ticket.id, status: newStatus }); }}
                                >
                                  <SelectTrigger className="h-7 text-xs w-auto min-w-[80px]">
                                    <span>{ticket.status === "OPEN" ? "打开" : ticket.status === "IN_PROGRESS" ? "处理中" : ticket.status === "CLOSED" ? "已关闭" : ticket.status}</span>
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="OPEN">打开</SelectItem>
                                    <SelectItem value="IN_PROGRESS">处理中</SelectItem>
                                    <SelectItem value="CLOSED">已关闭</SelectItem>
                                  </SelectContent>
                                </Select>
                              )
                            )}
                          </div>
                          {isComment && (
                            <div className="bg-muted rounded-lg p-3">
                              {renderCommentContent(item.content)}
                            </div>
                          )}
                          {item.kind === "plugin" && (
                            <div className="bg-muted rounded-lg p-3 space-y-1">
                              <Badge variant="secondary" className="text-[10px] gap-1">
                                <Sparkles className="h-2.5 w-2.5" />
                                {mPluginName}
                              </Badge>
                              <div className="text-sm space-y-1">
                                {mFormat === "markdown"
                                  ? item.content.split("\n").map((line: string, li: number) => {
                                      if (line.trim() === "") return <div key={li} className="h-1" />;
                                      const isList = line.startsWith("- ");
                                      const text = isList ? line.slice(2) : line;
                                      const parts = text.split(/(\*\*.+?\*\*)/g).map((seg, si) => {
                                        if (seg.startsWith("**") && seg.endsWith("**")) {
                                          return <strong key={si}>{seg.slice(2, -2)}</strong>;
                                        }
                                        return <span key={si}>{seg}</span>;
                                      });
                                      return <div key={li} className={isList ? "pl-3" : ""}>{isList && "• "}{parts}</div>;
                                    })
                                  : <div className="whitespace-pre-wrap">{renderCommentContent(item.content)}</div>
                                }
                              </div>
                            </div>
                          )}
                          {item.kind === "attachment" && item.metadata && (() => {
                            const attMeta = safeParseMetadata(item.metadata);
                            const attachmentId = (attMeta.attachmentId as string | undefined) ?? item.id;
                            return (
                              <AttachmentCard
                                projectId={projectId}
                                attachmentId={attachmentId}
                                filename={metaStr(attMeta, "filename")}
                                url={metaStr(attMeta, "url")}
                                size={(attMeta.size as number | undefined) ?? 0}
                                mimeType={metaStr(attMeta, "mimeType")}
                                canManage={!!permissions?.canManage}
                                canDelete={isAdmin}
                                compact
                                onChanged={() => {
                                  queryClient.invalidateQueries({ queryKey: ["timeline", projectId] });
                                  queryClient.invalidateQueries({ queryKey: ["project", projectId] });
                                  queryClient.invalidateQueries({ queryKey: ["archived-attachments", projectId] });
                                }}
                              />
                            );
                          })()}
                          <span className="text-xs text-muted-foreground">
                            {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true, locale: zhCN })}
                          </span>
                          {isComment && isInternal && (
                            <PushToFollowUpButton
                              sourceType="PROJECT_COMMENT"
                              sourceId={item.id}
                              disabled={!project.representativeId}
                              disabledReason={!project.representativeId ? "请先在项目设置中绑定代表" : undefined}
                            />
                          )}
                        </div>
                      </div>
                    );
                  };
                  return (
                    <>
                      <div className="max-h-[520px] overflow-y-auto pr-2 space-y-0">
                        {visibleItems.map((item, index) => (
                          <HiddenTimelineItem key={item.id} item={item} isLast={index === visibleItems.length - 1} />
                        ))}
                      </div>
                      {lowItems.length > 0 && (
                        <div className="pt-3 text-center">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-xs text-muted-foreground"
                            onClick={() => setShowLowWeight(!showLowWeight)}
                          >
                            {showLowWeight ? "折叠进度/系统动态" : `显示 ${lowItems.length} 条进度/系统动态`}
                          </Button>
                        </div>
                      )}
                    </>
                  );
                })()
              )}
            </CardContent>
          </Card>

          {/* Comment Input */}
          {!project.deleted && permissions?.canContribute && (
            <div className="flex gap-2">
              <Textarea
                placeholder="发表评论..."
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                className="min-h-[60px] resize-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    if (comment.trim()) commentMutation.mutate(comment);
                  }
                }}
              />
              <div className="flex flex-col gap-1 shrink-0">
                <input
                  type="file"
                  ref={commentFileInputRef}
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) commentUploadMutation.mutate(file);
                    e.target.value = "";
                  }}
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => commentFileInputRef.current?.click()}
                  disabled={commentUploadMutation.isPending || !permissions?.canUploadFiles || !!project.deleted}
                >
                  {commentUploadMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  title="项目快照"
                  disabled={pluginRunning}
                  onClick={() => runTimelinePlugin("project.digest")}
                >
                  {pluginRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                </Button>
                <Button
                  size="icon"
                  className="shrink-0 h-10 w-10"
                  disabled={!comment.trim() || commentMutation.isPending}
                  onClick={() => commentMutation.mutate(comment)}
                  aria-label="发送评论"
                >
                  {commentMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          )}
        </AnimatedTabPanel>

        {/* Tickets Tab */}
        <AnimatedTabPanel activeValue={activeTab} value="tickets" className="space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="font-medium">项目工单</h3>
            {!project.deleted && (
              <Dialog open={ticketOpen} onOpenChange={setTicketOpen}>
                <DialogTrigger render={<Button size="sm" />}>
                  <Plus className="mr-1 h-3 w-3" />
                  新建工单
                </DialogTrigger>
              <DialogContent className="sm:max-w-lg max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
                <DialogHeader><DialogTitle>新建工单</DialogTitle></DialogHeader>
                <form onSubmit={(e) => { e.preventDefault(); ticketMutation.mutate(ticketForm); }} className="contents">
                  <div className="-mx-4 min-h-0 overflow-y-auto overscroll-contain px-4 pb-1" style={{ WebkitOverflowScrolling: "touch" }}>
                    <div className="space-y-4">
                      <DraftInputPanel
                        formKey="ticket.create"
                        projectId={projectId}
                        fieldLabels={{
                          title: "标题",
                          description: "描述",
                          priority: "优先级",
                        }}
                        onApply={(fields) => {
                          setTicketForm((prev) => ({
                            ...prev,
                            ...(typeof fields.title === "string" && fields.title.trim() ? { title: fields.title.trim() } : {}),
                            ...(typeof fields.description === "string" ? { description: fields.description.trim() } : {}),
                            ...(typeof fields.priority === "string" && ["LOW", "MEDIUM", "HIGH", "URGENT"].includes(fields.priority) ? { priority: fields.priority } : {}),
                          }));
                        }}
                      />
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <label className="text-sm font-medium">标题</label>
                          <Input value={ticketForm.title} onChange={(e) => setTicketForm({ ...ticketForm, title: e.target.value })} required />
                        </div>
                        <div className="space-y-2">
                          <label className="text-sm font-medium">描述</label>
                          <Textarea value={ticketForm.description} onChange={(e) => setTicketForm({ ...ticketForm, description: e.target.value })} rows={3} />
                        </div>
                        <div className="space-y-2">
                          <label className="text-sm font-medium">优先级</label>
                          <Select value={ticketForm.priority} onValueChange={(v) => setTicketForm({ ...ticketForm, priority: v || "MEDIUM" })}>
                            <SelectTrigger><span>{ticketForm.priority === "LOW" ? "低" : ticketForm.priority === "MEDIUM" ? "中" : ticketForm.priority === "HIGH" ? "高" : ticketForm.priority === "URGENT" ? "紧急" : "中"}</span></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="LOW">低</SelectItem>
                              <SelectItem value="MEDIUM">中</SelectItem>
                              <SelectItem value="HIGH">高</SelectItem>
                              <SelectItem value="URGENT">紧急</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <label className="text-sm font-medium">提醒时间（可选）</label>
                          <Input
                            type="datetime-local"
                            value={ticketForm.reminderDate}
                            onChange={(e) => setTicketForm({ ...ticketForm, reminderDate: e.target.value })}
                          />
                          <p className="text-xs text-muted-foreground">到达提醒时间后会同时发送邮件和站内通知给工单创建者</p>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="-mx-4 -mb-4 border-t bg-popover/95 px-4 py-3">
                    <Button type="submit" className="w-full" disabled={ticketMutation.isPending}>
                      {ticketMutation.isPending ? "创建中..." : "创建工单"}
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
            )}
          </div>

          <div
            className={!project.deleted && permissions?.canUploadFiles && isDraggingTickets ? "border-primary border-2 border-dashed rounded-lg p-2" : ""}
            onDragOver={(e) => { e.preventDefault(); if (permissions?.canUploadFiles && !project.deleted) setIsDraggingTickets(true); else setIsDraggingTickets(false); }}
            onDragLeave={() => setIsDraggingTickets(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDraggingTickets(false);
              if (project.deleted || !permissions?.canUploadFiles) return;
              const file = e.dataTransfer.files?.[0];
              if (file) uploadMutation.mutate(file);
            }}
          >
            {tickets.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm border rounded-lg">暂无工单</div>
            ) : (
              <div className="space-y-3">
                {tickets.map((ticket) => (
                  <Card key={ticket.id} className="cursor-pointer hover:shadow-sm transition-shadow" onClick={() => navigateTicket(ticket.id)}>
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h4 className="font-medium">{ticket.title}</h4>
                            <Badge variant={ticket.priority === "URGENT" ? "destructive" : ticket.priority === "HIGH" ? "default" : "secondary"}>
                              {ticket.priority === "LOW" ? "低" : ticket.priority === "MEDIUM" ? "中" : ticket.priority === "HIGH" ? "高" : "紧急"}
                            </Badge>
                            <Badge variant={ticket.status === "CLOSED" ? "outline" : "secondary"}>
                              {ticket.status === "OPEN" ? "打开" : ticket.status === "IN_PROGRESS" ? "处理中" : "已关闭"}
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground mt-1">{ticket.description || "无描述"}</p>
                          {ticket.reminderDate && (
                            <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              提醒: {new Date(ticket.reminderDate).toLocaleString("zh-CN")}
                              {ticket.reminderSent && " (已发送)"}
                            </p>
                          )}
                        </div>
                        {!project.deleted && canManageTicket && (
                          <div onClick={(e) => e.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="shrink-0 h-11 w-11" />}>
                              <MoreHorizontal className="h-4 w-4" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {ticket.status !== "IN_PROGRESS" && (
                                <DropdownMenuItem onClick={() => updateTicketMutation.mutate({ ticketId: ticket.id, status: "IN_PROGRESS" })}>
                                  标记为处理中
                                </DropdownMenuItem>
                              )}
                              {ticket.status !== "CLOSED" && (
                                <DropdownMenuItem onClick={() => updateTicketMutation.mutate({ ticketId: ticket.id, status: "CLOSED" })}>
                                  标记为已关闭
                                </DropdownMenuItem>
                              )}
                              {ticket.status !== "OPEN" && (
                                <DropdownMenuItem onClick={() => updateTicketMutation.mutate({ ticketId: ticket.id, status: "OPEN" })}>
                                  重新打开
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                className="text-red-600"
                                onClick={async () => {
                                  const ok = await confirm({
                                    title: "删除工单",
                                    description: `确认删除工单 "${ticket.title}"？此操作不可撤销。`,
                                    variant: "destructive",
                                  });
                                  if (ok) {
                                    deleteTicketMutation.mutate(ticket.id);
                                  }
                                }}
                              >
                                删除工单
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2 mt-2">
                        {!project.deleted && isInternal && (
                          <PushToFollowUpButton
                            sourceType="PROJECT_TICKET"
                            sourceId={ticket.id}
                            disabled={!project.representativeId}
                            disabledReason={!project.representativeId ? "请先在项目设置中绑定代表" : undefined}
                          />
                        )}

                        {!project.deleted && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigateTicket(ticket.id);
                            }}
                          >
                            打开详情
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </AnimatedTabPanel>

        {/* Files Tab */}
        <AnimatedTabPanel activeValue={activeTab} value="files" className="space-y-4">
          <div
            className={`space-y-4 ${isDraggingFiles && permissions?.canUploadFiles && !project.deleted ? "border-primary border-2 border-dashed rounded-lg p-4" : ""}`}
            onDragOver={(e) => { e.preventDefault(); if (permissions?.canUploadFiles && !project.deleted) setIsDraggingFiles(true); else setIsDraggingFiles(false); }}
            onDragLeave={() => setIsDraggingFiles(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDraggingFiles(false);
              if (project.deleted || !permissions?.canUploadFiles) return;
              const file = e.dataTransfer.files?.[0];
              if (file) uploadMutation.mutate(file);
            }}
          >
            <div className="flex justify-between items-center">
              <h3 className="font-medium">项目文件</h3>
              {!project.deleted && permissions?.canUploadFiles && (
                <label className="cursor-pointer inline-flex">
                  <input
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) uploadMutation.mutate(file);
                      e.target.value = "";
                    }}
                  />
                  <span className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-8 px-3">
                    <Upload className="mr-1 h-3 w-3" />上传文件
                  </span>
                </label>
              )}
            </div>

            {isDraggingFiles ? (
              <div className="text-center py-8 text-primary text-sm font-medium">拖放文件到此处上传</div>
            ) : attachments.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm border rounded-lg">暂无文件</div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {attachments.map((item) => {
                  const meta = safeParseMetadata(item.metadata);
                  const attachmentId = (meta.attachmentId as string | undefined) ?? item.id;
                  return (
                    <AttachmentCard
                      key={item.id}
                      projectId={projectId}
                      attachmentId={attachmentId}
                      filename={metaStr(meta, "filename")}
                      url={metaStr(meta, "url")}
                      size={(meta.size as number | undefined) ?? 0}
                      mimeType={metaStr(meta, "mimeType")}
                      canManage={!!permissions?.canManage}
                      canDelete={isAdmin}
                      onChanged={() => {
                        queryClient.invalidateQueries({ queryKey: ["timeline", projectId] });
                        queryClient.invalidateQueries({ queryKey: ["project", projectId] });
                        queryClient.invalidateQueries({ queryKey: ["archived-attachments", projectId] });
                      }}
                    />
                  );
                })}
              </div>
            )}

            {/* 迁移中间态 MIGRATING（仅管理者可见；普通 FAILED 不混入） */}
            {permissions?.canManage && (archivedData?.pendingMigrations?.length ?? 0) > 0 ? (
              <div className="mb-4 space-y-2">
                <p className="text-xs text-amber-800">有附件处于迁移恢复中，可点重试续接</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {(archivedData?.pendingMigrations ?? []).map((item) => (
                    <AttachmentCard
                      key={item.id}
                      projectId={projectId}
                      attachmentId={item.id}
                      filename={item.filename}
                      url={item.url}
                      size={item.size}
                      mimeType={item.mimeType}
                      canManage
                      canDelete={isAdmin}
                      pendingStatus="MIGRATING"
                      onChanged={() => {
                        queryClient.invalidateQueries({ queryKey: ["timeline", projectId] });
                        queryClient.invalidateQueries({ queryKey: ["project", projectId] });
                        queryClient.invalidateQueries({ queryKey: ["archived-attachments", projectId] });
                      }}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {/* 已归档附件折叠区（仅管理者可见；恢复/永久删除入口） */}
            {permissions?.canManage && (archivedData?.attachments?.length ?? 0) > 0 ? (
              <div className="mt-4">
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setIsArchivedExpanded((v) => !v)}
                >
                  <Archive className="h-3 w-3" />
                  {isArchivedExpanded ? "收起" : "展开"}已归档（{archivedData?.attachments?.length ?? 0}）
                </button>
                {isArchivedExpanded ? (
                  <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {(archivedData?.attachments ?? []).map((item) => (
                      <AttachmentCard
                        key={item.id}
                        projectId={projectId}
                        attachmentId={item.id}
                        filename={item.filename}
                        url={item.url}
                        size={item.size}
                        mimeType={item.mimeType}
                        canManage
                        canDelete={isAdmin}
                        archived
                        onChanged={() => {
                          queryClient.invalidateQueries({ queryKey: ["timeline", projectId] });
                          queryClient.invalidateQueries({ queryKey: ["project", projectId] });
                          queryClient.invalidateQueries({ queryKey: ["archived-attachments", projectId] });
                        }}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </AnimatedTabPanel>

        {/* Orders Tab */}
          <AnimatedTabPanel activeValue={activeTab} value="orders" className="space-y-4">
            {project.orderLinks && project.orderLinks.length > 0 ? (
              project.orderLinks.map((link) => {
                const o = link.order;
                const invoiceCount = (o._count?.invoiceRequests || 0) as number;
                const costCount = (o._count?.financeCosts || 0) as number;
                const effectiveAmount = (o.financeAmountOverride ?? o.totalAmount) as number;
                // 整卡点击打开订单；开票/成本等次级入口收敛进「⋯」菜单，消除三按钮并列。
                const openOrder = () => {
                  if (isEmbedded) {
                    navigateOrder(o.id);
                  } else {
                    router.push(`/orders?focus=${o.id}`);
                  }
                };
                const orderMenuItems = [
                  { key: "open", label: "打开订单", icon: Package, href: `/orders?focus=${o.id}` },
                  { key: "invoice", label: "订单开票", icon: Receipt, href: `/orders?focus=${o.id}&action=invoice` },
                  { key: "cost", label: "新增成本", icon: Banknote, href: `/orders?focus=${o.id}&action=cost` },
                ];
                return (
                <Card
                  key={link.id}
                  variant="interactive"
                  className="p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  role="link"
                  tabIndex={0}
                  aria-label={`打开订单 ${o.orderNo}`}
                  onClick={openOrder}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openOrder();
                    }
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium">{o.orderNo}</div>
                      <div className="text-sm text-muted-foreground truncate">{o.title}</div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      <Badge variant="outline">{link.treatment}</Badge>
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="h-8 w-8" />}>
                          <MoreHorizontal className="h-4 w-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {orderMenuItems.map((item) => {
                            const ItemIcon = item.icon;
                            return isEmbedded ? (
                              <DropdownMenuItem key={item.key} onClick={() => navigateOrder(o.id)}>
                                <ItemIcon className="h-3.5 w-3.5 mr-2" />{item.label}
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem key={item.key} render={<Link href={item.href} />}>
                                <ItemIcon className="h-3.5 w-3.5 mr-2" />{item.label}
                              </DropdownMenuItem>
                            );
                          })}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-2 text-xs text-muted-foreground flex-wrap">
                    <span>来源: {o.source}</span>
                    <span>分类: {o.category}</span>
                    <span>状态: {({ DRAFT: "草稿", CONFIRMED: "已确认", DELIVERED: "已交付", CLOSED: "已关闭" } as Record<string, string>)[o.status as string] || (o.status as string)}</span>
                    <span>口径: {TREATMENT_LABELS[o.financeTreatment as string] || (o.financeTreatment as string)}</span>
                    <span className="font-medium">¥{effectiveAmount.toLocaleString()}</span>
                    {link.allocatedAmount != null && <span>分摊: ¥{link.allocatedAmount.toLocaleString()}</span>}
                    <span>发票: {invoiceCount}</span>
                    <span>成本: {costCount}</span>
                  </div>
                </Card>
              );
              })
            ) : (
              <div className="text-sm text-muted-foreground py-8 text-center space-y-3">
                <p>暂无关联订单</p>
                <div className="flex items-center justify-center gap-3">
                  {isEmbedded ? (
                    <Button variant="outline" size="sm" onClick={() => onNavigateHref?.("/orders")}>
                      去订单管理查看/绑定
                    </Button>
                  ) : (
                    <Link href="/orders">
                      <Button variant="outline" size="sm">去订单管理查看/绑定</Button>
                    </Link>
                  )}
                </div>
              </div>
            )}
          </AnimatedTabPanel>

        {/* Milestones Tab */}
          <AnimatedTabPanel activeValue={activeTab} value="milestones" className="space-y-4">
            <MilestonePanel
              projectId={project.id}
              canManage={!!permissions?.canManage}
              readOnly={!!project.deleted}
            />
          </AnimatedTabPanel>
      </Tabs>

      {/* Image Preview Dialog */}
      <Dialog open={!!previewImage} onOpenChange={(open) => !open && setPreviewImage(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>图片预览</DialogTitle>
          </DialogHeader>
          {previewImage && (
            <img src={previewImage} alt="preview" className="w-full h-auto rounded" />
          )}
        </DialogContent>
      </Dialog>
    </>
  );

  // ── Render by mode ────────────────────────────────────────────────────
  if (isEmbedded) {
    // Compact container suitable for Panel/Sheet — no PageShell, no back arrow
    // (back is provided by the workspace header).
    return <div className="flex flex-col gap-6 p-3">{body}</div>;
  }

  return <PageShell>{body}</PageShell>;
}
