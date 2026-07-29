"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useMediaQuery } from "@/hooks/use-media-query";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { CheckCircle, XCircle, User, Building, Mail, MessageCircle, MapPin, FileText, AlertTriangle, Link2, ClipboardCheck } from "lucide-react";
import { CrmEmptyState } from "@/components/crm/empty-state";
import Link from "next/link";
import { CustomerApplicationFormDialog } from "@/components/crm/customer-application-form-dialog";
import { crmKeys } from "@/lib/crm/query-keys";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";

interface ApplicationItem {
  id: string;
  name: string;
  principal: string | null;
  email: string | null;
  wechat: string | null;
  organization: string | null;
  address: string | null;
  miniProgramId: string | null;
  notes: string | null;
  status: string;
  submittedByUserId: string;
  submittedByUser: { id: string; name: string; email: string };
  reviewedByUser: { id: string; name: string } | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdCrmProfile: { id: string; name: string | null; customerCode: string | null } | null;
  createdAt: string;
  autoApproved: boolean;
  adminReviewStatus: string;
  adminReviewedByUser: { id: string; name: string } | null;
  adminReviewedAt: string | null;
  adminReviewNote: string | null;
  supervisorReviewStatus: string;
  supervisorReviewReason: string | null;
  conflictType: string | null;
  duplicateCheckStatus: string;
  supervisorReviewedByUser: { id: string; name: string } | null;
}

interface CandidateCustomer {
  id: string;
  profileId?: string;
  name: string;
  customerCodeLast6: string;
  organization: string | null;
  hasCrmProfile: boolean;
  matchReasons: string[];
}

interface AssigneeOption {
  userId: string;
  name: string;
  kind: "self" | "representative";
}

function StatusBadge({ status }: { status: string }) {
  if (status === "PENDING") return <Badge variant="secondary">待审核</Badge>;
  if (status === "APPROVED") return <Badge variant="secondary" className="border-success-border text-success">已通过</Badge>;
  if (status === "REJECTED") return <Badge variant="destructive">已驳回</Badge>;
  return <Badge>{status}</Badge>;
}

function SupervisorReviewBadge({ app }: { app: ApplicationItem }) {
  const effectiveStatus = app.supervisorReviewStatus !== "NONE"
    ? app.supervisorReviewStatus
    : app.adminReviewStatus;
  if (effectiveStatus === "PENDING") return <Badge variant="secondary" className="border-warning-border text-warning">待复核</Badge>;
  if (effectiveStatus === "CONFIRMED") return <Badge variant="secondary" className="border-success-border text-success">已确认</Badge>;
  if (effectiveStatus === "REJECTED") return <Badge variant="destructive">已拒绝</Badge>;
  return null;
}

const CONFLICT_BADGES: Record<string, { label: string; className: string }> = {
  ORG_CONFLICT: { label: "区域冲突", className: "border-danger-border text-danger" },
  CUSTOMER_CONFLICT: { label: "客户冲突", className: "border-warning-border text-warning" },
  DUPLICATE_OVERRIDE: { label: "重复强制新建", className: "border-info-border text-info" },
  ORG_REQUEST: { label: "单位主数据申请", className: "border-info-border text-info" },
};

export default function CrmCustomerApplicationsPage() {
  return (
    <Suspense fallback={<PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>}>
      <ApplicationPageInner />
    </Suspense>
  );
}

function ApplicationPageInner() {
  const { status } = useSession();
  const router = useRouter();

  if (status === "unauthenticated") { router.push("/login"); return null; }
  if (status === "loading") return <PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>;

  return <ApplicationList />;
}

function ApplicationList() {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { confirm } = useConfirm();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewing, setReviewing] = useState<ApplicationItem | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [bindTargetId, setBindTargetId] = useState("");
  const [actionType, setActionType] = useState<"approve" | "reject" | "bind">("approve");

  // Batch state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchOwnerUserId, setBatchOwnerUserId] = useState("");
  const [batchReviewNote, setBatchReviewNote] = useState("");
  const [batchSheetOpen, setBatchSheetOpen] = useState(false);

  // Batch review dialog
  const [batchReviewDialogOpen, setBatchReviewDialogOpen] = useState(false);

  const isAdmin = session?.user?.role === "ADMIN";
  const isUser = session?.user?.role === "USER";
  const isRegionalManager = session?.user?.role === "REGIONAL_MANAGER";
  const canAdminCreate = isAdmin;
  const canSupervisorReview = isAdmin || isRegionalManager;
  const canBrowseApplications = canSupervisorReview || isUser;
  const isRep = session?.user?.role === "REPRESENTATIVE";
  const isMobile = useMediaQuery("(max-width: 767px)");

  const filterMode = useMemo<"pending" | "review" | "all">(() => {
    if (isRep) return "all";
    if (isUser) {
      const view = searchParams.get("view");
      if (view === "review" || view === "pending" || view === "all") return view;
      return "all";
    }
    const view = searchParams.get("view");
    if (view === "review" || view === "pending" || view === "all") return view;
    if (searchParams.get("review") === "PENDING") return "review";
    // Regional managers default to review view; admins default to pending
    return isRegionalManager ? "review" : "pending";
  }, [searchParams, isRep, isRegionalManager, isUser]);

  const { data, isLoading } = useQuery<{ applications: ApplicationItem[] }>({
    queryKey: ["crm-customer-applications", filterMode],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filterMode !== "all") params.set("view", filterMode);
      return fetch(`/api/crm/customer-applications?${params.toString()}`).then((r) => r.json());
    },
  });

  const applications = useMemo(() => data?.applications || [], [data]);

  // Prune selectedIds to intersection with current application IDs when data changes
  useEffect(() => {
    const currentIds = new Set(applications.map((a) => a.id));
    const hasStale = [...selectedIds].some((id) => !currentIds.has(id));
    if (hasStale) {
      queueMicrotask(() => {
        setSelectedIds((prev) => new Set([...prev].filter((id) => currentIds.has(id))));
      });
    }
  }, [applications, selectedIds]);

  const { data: assigneesData } = useQuery<{ assignees: AssigneeOption[] }>({
    queryKey: ["crm-assignees"],
    queryFn: () => fetch("/api/crm/assignees").then((r) => r.json()),
    enabled: canSupervisorReview,
  });

  const [candidates, setCandidates] = useState<CandidateCustomer[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);

  const pendingInvalidations = () => {
    queryClient.invalidateQueries({ queryKey: ["crm-customer-applications"] });
    queryClient.invalidateQueries({ queryKey: ["crm-profiles"] });
    queryClient.invalidateQueries({ queryKey: crmKeys.myToday() });
    queryClient.invalidateQueries({ queryKey: crmKeys.adminOverview() });
    queryClient.invalidateQueries({ queryKey: ["customers"] });
    queryClient.invalidateQueries({ queryKey: ["crm-batch-candidate-count"] });
  };

  const approveMutation = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const payload: Record<string, unknown> = { action: "approve", reviewNote: reviewNote || undefined };
      if (ownerUserId) payload.ownerUserId = ownerUserId;
      const res = await fetch(`/api/crm/customer-applications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "审核失败");
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("客户申请已通过，客户和 CRM 档案已创建");
      pendingInvalidations();
      resetReview();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const bindMutation = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const res = await fetch(`/api/crm/customer-applications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "approve-bind",
          targetProfileId: bindTargetId,
          reviewNote: reviewNote || undefined,
          ownerUserId: ownerUserId || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "绑定失败");
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("已绑定到既有客户档案");
      pendingInvalidations();
      resetReview();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const res = await fetch(`/api/crm/customer-applications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject", reviewNote: reviewNote || undefined }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "驳回失败");
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("客户申请已驳回");
      queryClient.invalidateQueries({ queryKey: ["crm-customer-applications"] });
      resetReview();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const confirmReviewMutation = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const res = await fetch(`/api/crm/customer-applications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm-review" }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "操作失败");
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("已确认该客户申请");
      queryClient.invalidateQueries({ queryKey: ["crm-customer-applications"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const rejectReviewMutation = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const res = await fetch(`/api/crm/customer-applications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject-review", reviewNote: reviewNote || undefined }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "操作失败");
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("已拒绝该客户申请，客户档案已删除");
      queryClient.invalidateQueries({ queryKey: ["crm-customer-applications"] });
      queryClient.invalidateQueries({ queryKey: ["crm-profiles"] });
      resetReview();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const batchApproveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/crm/customer-applications/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "approve",
          ids: [...selectedIds],
          ownerUserId: batchOwnerUserId || undefined,
          reviewNote: batchReviewNote || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "批量审核失败");
      return data as { approved: number; rejected: number; skipped: Array<{ id: string; reason: string }>; errors: Array<{ id: string; error: string }> };
    },
    onSuccess: (data) => {
      const parts: string[] = [];
      if (data.approved > 0) parts.push(`${data.approved} 条已通过`);
      if (data.skipped.length > 0) parts.push(`${data.skipped.length} 条已跳过`);
      if (data.errors.length > 0) parts.push(`${data.errors.length} 条失败`);
      toast.success(parts.join("，"));
      if (data.errors.length > 0) {
        data.errors.slice(0, 3).forEach((e) => toast.error(`${e.id.slice(-6)}: ${e.error}`));
      }
      pendingInvalidations();
      setSelectedIds(new Set());
      setBatchReviewNote("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const batchRejectMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/crm/customer-applications/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reject",
          ids: [...selectedIds],
          reviewNote: batchReviewNote || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "批量驳回失败");
      return data as { approved: number; rejected: number; skipped: Array<{ id: string; reason: string }>; errors: Array<{ id: string; error: string }> };
    },
    onSuccess: (data) => {
      const parts: string[] = [];
      if (data.rejected > 0) parts.push(`${data.rejected} 条已驳回`);
      if (data.skipped.length > 0) parts.push(`${data.skipped.length} 条已跳过`);
      if (data.errors.length > 0) parts.push(`${data.errors.length} 条失败`);
      toast.success(parts.join("，"));
      pendingInvalidations();
      setSelectedIds(new Set());
      setBatchReviewNote("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const batchConfirmReviewMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/crm/customer-applications/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "confirm-review",
          ids: [...selectedIds],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "批量确认复核失败");
      return data as { confirmed: number; reviewRejected: number; skipped: Array<{ id: string; reason: string }>; errors: Array<{ id: string; error: string }> };
    },
    onSuccess: (data) => {
      const parts: string[] = [];
      if (data.confirmed > 0) parts.push(`${data.confirmed} 条已确认复核`);
      if (data.skipped.length > 0) parts.push(`${data.skipped.length} 条已跳过`);
      if (data.errors.length > 0) parts.push(`${data.errors.length} 条失败`);
      toast.success(parts.join("，"));
      pendingInvalidations();
      setSelectedIds(new Set());
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const batchRejectReviewMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/crm/customer-applications/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reject-review",
          ids: [...selectedIds],
          reviewNote: batchReviewNote || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "批量拒绝复核失败");
      return data as { confirmed: number; reviewRejected: number; skipped: Array<{ id: string; reason: string }>; errors: Array<{ id: string; error: string }> };
    },
    onSuccess: (data) => {
      const parts: string[] = [];
      if (data.reviewRejected > 0) parts.push(`${data.reviewRejected} 条已拒绝复核并删除`);
      if (data.skipped.length > 0) parts.push(`${data.skipped.length} 条已跳过`);
      if (data.errors.length > 0) parts.push(`${data.errors.length} 条失败`);
      toast.success(parts.join("，"));
      pendingInvalidations();
      setSelectedIds(new Set());
      setBatchReviewNote("");
      setBatchReviewDialogOpen(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (filterMode === "review") {
      const reviewableIds = applications
        .filter((a) => a.autoApproved && (a.supervisorReviewStatus === "PENDING" || (a.adminReviewStatus === "PENDING" && a.supervisorReviewStatus === "NONE")))
        .map((a) => a.id);
      if (reviewableIds.length === 0) return;
      const allSelected = reviewableIds.every((id) => selectedIds.has(id));
      setSelectedIds(allSelected ? new Set() : new Set(reviewableIds));
    } else {
      const pendingIds = applications.filter((a) => a.status === "PENDING").map((a) => a.id);
      if (pendingIds.length === 0) return;
      const allSelected = pendingIds.every((id) => selectedIds.has(id));
      setSelectedIds(allSelected ? new Set() : new Set(pendingIds));
    }
  };

  const resetReview = () => {
    setReviewOpen(false);
    setReviewing(null);
    setReviewNote("");
    setOwnerUserId("");
    setBindTargetId("");
    setActionType("approve");
    setCandidates([]);
  };

  const openApproveDialog = async (app: ApplicationItem) => {
    setReviewing(app);
    setReviewNote("");
    setOwnerUserId("");
    setBindTargetId("");
    setActionType("approve");
    setReviewOpen(true);
    setCandidatesLoading(true);
    try {
      const res = await fetch(`/api/crm/customer-applications/${app.id}`);
      if (res.ok) {
        const data = await res.json();
        setCandidates(data.candidates || []);
      }
    } finally {
      setCandidatesLoading(false);
    }
  };

  const switchToReject = (app: ApplicationItem) => {
    setReviewing(app);
    setReviewNote("");
    setOwnerUserId("");
    setBindTargetId("");
    setActionType("reject");
    setCandidates([]);
    setReviewOpen(true);
  };

  const assignees = assigneesData?.assignees || [];

  function openRejectReviewDialog(app: ApplicationItem) {
    setReviewing(app);
    setReviewNote("");
    setOwnerUserId("");
    setBindTargetId("");
    setActionType("reject");
    setCandidates([]);
    setReviewOpen(true);
  }

  return (
    <PageShell>
      <PageHeader
        title={canSupervisorReview ? "客户申请与主管复核" : isUser ? "客户申请记录" : "我的客户申请"}
        actions={isRep && <CustomerApplicationFormDialog />}
      />
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          {canSupervisorReview
            ? (filterMode === "pending" ? `待创建 ${applications.length} 条` : filterMode === "review" ? `待复核 ${applications.length} 条` : `共 ${applications.length} 条`)
            : isUser
              ? `当前视图共 ${applications.length} 条`
              : "申请将自动通过并创建客户档案，主管会进行复核"}
        </p>
          {(canAdminCreate || canBrowseApplications) && (
            <Tabs value={filterMode} onValueChange={(v) => { setSelectedIds(new Set()); router.replace(`/crm/customer-applications?view=${v}`); }} className="mt-2">
              <TabsList>
                {(canAdminCreate || canBrowseApplications) && (
                  <TabsTrigger value="pending">待创建</TabsTrigger>
                )}
                {canBrowseApplications && (
                  <TabsTrigger value="review">待复核</TabsTrigger>
                )}
                <TabsTrigger value="all">全部</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
          {canAdminCreate && filterMode === "pending" && applications.length > 0 && (
            <div className="flex items-center gap-2 mt-2">
              <Checkbox
                id="select-all-pending"
                checked={applications.filter((a) => a.status === "PENDING").every((a) => selectedIds.has(a.id))}
                onCheckedChange={toggleSelectAll}
              />
              <Label htmlFor="select-all-pending" className="text-xs text-muted-foreground cursor-pointer">全选本页待创建</Label>
            </div>
          )}
          {canSupervisorReview && filterMode === "review" && applications.length > 0 && (
            <div className="flex items-center gap-2 mt-2">
              <Checkbox
                id="select-all-review"
                checked={(() => {
                  const reviewable = applications.filter((a) => a.autoApproved && (a.supervisorReviewStatus === "PENDING" || (a.adminReviewStatus === "PENDING" && a.supervisorReviewStatus === "NONE")));
                  return reviewable.length > 0 && reviewable.every((a) => selectedIds.has(a.id));
                })()}
                onCheckedChange={toggleSelectAll}
              />
              <Label htmlFor="select-all-review" className="text-xs text-muted-foreground cursor-pointer">全选本页待复核</Label>
            </div>
          )}
      </div>

      {/* Batch action bar — pending (ADMIN-only) */}
      {canAdminCreate && filterMode === "pending" && selectedIds.size > 0 && (
        isMobile ? (
          <>
            <Button size="sm" className="w-full h-11" onClick={() => setBatchSheetOpen(true)}>
              批量操作 ({selectedIds.size})
            </Button>
            <Sheet open={batchSheetOpen} onOpenChange={setBatchSheetOpen}>
              <SheetContent side="bottom" className="max-h-[90dvh] flex flex-col gap-0 px-0 pb-0">
                <SheetHeader className="px-4 pb-2">
                  <SheetTitle>批量操作 ({selectedIds.size})</SheetTitle>
                </SheetHeader>
                <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-4 space-y-4">
                  <div className="space-y-2">
                    <label className="text-xs text-muted-foreground">负责人</label>
                    <Select value={batchOwnerUserId} onValueChange={(v) => setBatchOwnerUserId(v || "")}>
                      <SelectTrigger className="w-full h-11 text-sm">
                        {batchOwnerUserId
                          ? <span>{assignees.find((a) => a.userId === batchOwnerUserId)?.name || batchOwnerUserId}</span>
                          : <span className="text-muted-foreground">默认提交人</span>}
                      </SelectTrigger>
                      <SelectContent>
                        {assignees.map((a) => (
                          <SelectItem key={a.userId} value={a.userId}>{a.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs text-muted-foreground">审核备注（选填）</label>
                    <Textarea
                      placeholder="审核备注（选填）"
                      value={batchReviewNote}
                      onChange={(e) => setBatchReviewNote(e.target.value)}
                      className="text-sm"
                    />
                  </div>
                  <Button
                    className="w-full h-11"
                    disabled={batchApproveMutation.isPending || batchRejectMutation.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: "批量通过申请",
                        description: `确认批量通过 ${selectedIds.size} 条申请？批量通过仅创建新客户，如需绑定已有客户请单条审核。`,
                      });
                      if (!ok) return;
                      batchApproveMutation.mutate();
                      setBatchSheetOpen(false);
                    }}
                  >
                    {batchApproveMutation.isPending ? "处理中..." : `批量通过 (${selectedIds.size})`}
                  </Button>
                  <Button
                    variant="destructive"
                    className="w-full h-11"
                    disabled={batchApproveMutation.isPending || batchRejectMutation.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: "批量驳回申请",
                        description: `确认批量驳回 ${selectedIds.size} 条申请？`,
                        variant: "destructive",
                      });
                      if (!ok) return;
                      batchRejectMutation.mutate();
                      setBatchSheetOpen(false);
                    }}
                  >
                    {batchRejectMutation.isPending ? "处理中..." : `批量驳回 (${selectedIds.size})`}
                  </Button>
                  <Button variant="ghost" className="w-full" onClick={() => { setSelectedIds(new Set()); setBatchSheetOpen(false); }}>
                    清空选择
                  </Button>
                  <p className="text-xs text-muted-foreground">批量通过仅创建新客户，如需绑定已有客户请单条审核</p>
                </div>
              </SheetContent>
            </Sheet>
          </>
        ) : (
          <div className="border rounded-lg p-4 bg-muted/30 space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm font-medium">已选择 {selectedIds.size} 条</span>
              <div className="flex items-center gap-1">
                <label className="text-xs text-muted-foreground">负责人:</label>
                <Select value={batchOwnerUserId} onValueChange={(v) => setBatchOwnerUserId(v || "")}>
                  <SelectTrigger className="w-32 h-8 text-xs">
                    {batchOwnerUserId
                      ? <span>{assignees.find((a) => a.userId === batchOwnerUserId)?.name || batchOwnerUserId}</span>
                      : <span className="text-muted-foreground">默认提交人</span>}
                  </SelectTrigger>
                  <SelectContent>
                    {assignees.map((a) => (
                      <SelectItem key={a.userId} value={a.userId}>{a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Input
                placeholder="审核备注（选填）"
                value={batchReviewNote}
                onChange={(e) => setBatchReviewNote(e.target.value)}
                className="h-8 text-xs w-48"
              />
              <Button
                size="sm"
                disabled={batchApproveMutation.isPending || batchRejectMutation.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: "批量通过申请",
                    description: `确认批量通过 ${selectedIds.size} 条申请？批量通过仅创建新客户，如需绑定已有客户请单条审核。`,
                  });
                  if (!ok) return;
                  batchApproveMutation.mutate();
                }}
              >
                {batchApproveMutation.isPending ? "处理中..." : `批量通过 (${selectedIds.size})`}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={batchApproveMutation.isPending || batchRejectMutation.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: "批量驳回申请",
                    description: `确认批量驳回 ${selectedIds.size} 条申请？`,
                    variant: "destructive",
                  });
                  if (!ok) return;
                  batchRejectMutation.mutate();
                }}
              >
                {batchRejectMutation.isPending ? "处理中..." : `批量驳回 (${selectedIds.size})`}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                清空选择
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">批量通过仅创建新客户，如需绑定已有客户请单条审核</p>
          </div>
        )
      )}

      {/* Batch action bar — review (ADMIN + REGIONAL_MANAGER) */}
      {canSupervisorReview && filterMode === "review" && selectedIds.size > 0 && (
        isMobile ? (
          <>
            <Button size="sm" className="w-full h-11" onClick={() => setBatchSheetOpen(true)}>
              批量操作 ({selectedIds.size})
            </Button>
            <Sheet open={batchSheetOpen} onOpenChange={setBatchSheetOpen}>
              <SheetContent side="bottom" className="max-h-[90dvh] flex flex-col gap-0 px-0 pb-0">
                <SheetHeader className="px-4 pb-2">
                  <SheetTitle>批量复核 ({selectedIds.size})</SheetTitle>
                </SheetHeader>
                <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-4 space-y-3">
                  <Button
                    className="w-full h-11"
                    disabled={batchConfirmReviewMutation.isPending || batchRejectReviewMutation.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: "批量复核通过申请",
                        description: `确认批量复核通过 ${selectedIds.size} 条申请？`,
                      });
                      if (!ok) return;
                      batchConfirmReviewMutation.mutate();
                      setBatchSheetOpen(false);
                    }}
                  >
                    {batchConfirmReviewMutation.isPending ? "处理中..." : `批量确认复核 (${selectedIds.size})`}
                  </Button>
                  <Button
                    variant="destructive"
                    className="w-full h-11"
                    disabled={batchConfirmReviewMutation.isPending || batchRejectReviewMutation.isPending}
                    onClick={() => {
                      setBatchReviewNote("");
                      setBatchReviewDialogOpen(true);
                      setBatchSheetOpen(false);
                    }}
                  >
                    {batchRejectReviewMutation.isPending ? "处理中..." : `批量拒绝复核并删除 (${selectedIds.size})`}
                  </Button>
                  <Button variant="ghost" className="w-full" onClick={() => { setSelectedIds(new Set()); setBatchSheetOpen(false); }}>
                    清空选择
                  </Button>
                  <p className="text-xs text-muted-foreground">批量确认复核将通过已选申请；批量拒绝将删除自动创建的客户数据</p>
                </div>
              </SheetContent>
            </Sheet>
          </>
        ) : (
          <div className="border rounded-lg p-4 bg-muted/30 space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm font-medium">已选择 {selectedIds.size} 条待复核</span>
              <Button
                size="sm"
                disabled={batchConfirmReviewMutation.isPending || batchRejectReviewMutation.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: "批量复核通过申请",
                    description: `确认批量复核通过 ${selectedIds.size} 条申请？`,
                  });
                  if (!ok) return;
                  batchConfirmReviewMutation.mutate();
                }}
              >
                {batchConfirmReviewMutation.isPending ? "处理中..." : `批量确认复核 (${selectedIds.size})`}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={batchConfirmReviewMutation.isPending || batchRejectReviewMutation.isPending}
                onClick={() => {
                  setBatchReviewNote("");
                  setBatchReviewDialogOpen(true);
                }}
              >
                {batchRejectReviewMutation.isPending ? "处理中..." : `批量拒绝复核并删除 (${selectedIds.size})`}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                清空选择
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">批量确认复核将通过已选申请；批量拒绝将删除自动创建的客户数据</p>
          </div>
        )
      )}

      {isLoading ? (
        <Skeleton className="h-8 w-48" />
      ) : applications.length === 0 ? (
        <CrmEmptyState icon={ClipboardCheck} title="暂无客户申请" />
      ) : (
        <div className="space-y-3">
          {applications.map((app) => (
            <div key={app.id} className="border rounded-lg p-4 bg-card">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-2 flex-1">
                  <div className="flex items-center gap-2">
                    {canAdminCreate && filterMode === "pending" && (
                      <Checkbox
                        id={`app-check-${app.id}`}
                        checked={selectedIds.has(app.id)}
                        onCheckedChange={() => toggleSelect(app.id)}
                      />
                    )}
                    {canSupervisorReview && filterMode === "review" && app.autoApproved && (
                      app.supervisorReviewStatus === "PENDING" ||
                      (app.adminReviewStatus === "PENDING" && app.supervisorReviewStatus === "NONE")
                    ) && (
                      <Checkbox
                        id={`app-check-${app.id}`}
                        checked={selectedIds.has(app.id)}
                        onCheckedChange={() => toggleSelect(app.id)}
                      />
                    )}
                    <span className="font-medium text-lg">{app.name}</span>
                    <StatusBadge status={app.status} />
                    {app.autoApproved && <SupervisorReviewBadge app={app} />}
                    {app.supervisorReviewReason && CONFLICT_BADGES[app.supervisorReviewReason] && (
                      <Badge variant="secondary" className={`text-xs ${CONFLICT_BADGES[app.supervisorReviewReason].className}`}>
                        {CONFLICT_BADGES[app.supervisorReviewReason].label}
                      </Badge>
                    )}
                    {app.conflictType && CONFLICT_BADGES[app.conflictType] && (
                      <Badge variant="secondary" className={`text-xs ${CONFLICT_BADGES[app.conflictType].className}`}>
                        {CONFLICT_BADGES[app.conflictType].label}
                      </Badge>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-sm text-muted-foreground">
                    {app.principal && (
                      <div className="flex items-center gap-1">
                        <User className="h-3.5 w-3.5" />
                        <span>负责人: {app.principal}</span>
                      </div>
                    )}
                    {app.organization && (
                      <div className="flex items-center gap-1">
                        <Building className="h-3.5 w-3.5" />
                        <span>{app.organization}</span>
                      </div>
                    )}
                    {app.email && (
                      <div className="flex items-center gap-1">
                        <Mail className="h-3.5 w-3.5" />
                        <span>{app.email}</span>
                      </div>
                    )}
                    {app.wechat && (
                      <div className="flex items-center gap-1">
                        <MessageCircle className="h-3.5 w-3.5" />
                        <span>微信: {app.wechat}</span>
                      </div>
                    )}
                    {app.address && (
                      <div className="flex items-center gap-1">
                        <MapPin className="h-3.5 w-3.5" />
                        <span>{app.address}</span>
                      </div>
                    )}
                  </div>
                  {app.notes && (
                    <div className="flex items-start gap-1 text-sm text-muted-foreground">
                      <FileText className="h-3.5 w-3.5 mt-0.5" />
                      <span>{app.notes}</span>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>提交人: {app.submittedByUser.name}</span>
                    <span>提交时间: {new Date(app.createdAt).toLocaleString("zh-CN")}</span>
                    {app.reviewedByUser && (
                      <span>审核人: {app.reviewedByUser.name}</span>
                    )}
                    {app.reviewedAt && (
                      <span>审核时间: {new Date(app.reviewedAt).toLocaleString("zh-CN")}</span>
                    )}
                  </div>
                  {app.reviewNote && (
                    <div className="text-sm text-muted-foreground bg-muted/50 rounded p-2">
                      审核备注: {app.reviewNote}
                    </div>
                  )}
                  {app.status === "APPROVED" && app.createdCrmProfile && (
                    <div className="flex gap-2 text-sm">
                      <Link href={`/crm/customers/${app.createdCrmProfile.id}`} className="text-primary hover:underline">
                        查看客户档案
                      </Link>
                    </div>
                  )}
                </div>
                {canAdminCreate && app.status === "PENDING" && (
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm"
                      variant="default"
                      onClick={() => openApproveDialog(app)}
                    >
                      <CheckCircle className="h-4 w-4 mr-1" />通过
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => switchToReject(app)}
                    >
                      <XCircle className="h-4 w-4 mr-1" />驳回
                    </Button>
                  </div>
                )}
                {canSupervisorReview && app.autoApproved && (
                  (app.supervisorReviewStatus === "PENDING" ||
                   (app.adminReviewStatus === "PENDING" && app.supervisorReviewStatus === "NONE"))
                ) && (
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm"
                      variant="default"
                      onClick={() => confirmReviewMutation.mutate({ id: app.id })}
                      disabled={confirmReviewMutation.isPending}
                    >
                      <CheckCircle className="h-4 w-4 mr-1" />确认
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => openRejectReviewDialog(app)}
                    >
                      <XCircle className="h-4 w-4 mr-1" />拒绝并删除
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Single-item review dialog */}
      <Dialog open={reviewOpen} onOpenChange={(v) => { if (!v) resetReview(); }}>
        <DialogContent className="sm:max-w-lg max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
          <DialogHeader>
            <DialogTitle>
              {actionType === "reject" && reviewing?.autoApproved ? "拒绝并删除客户" : actionType === "reject" ? "驳回客户申请" : "审核客户申请"}
            </DialogTitle>
          </DialogHeader>
          {reviewing && (
            <>
              <div className="-mx-4 min-h-0 overflow-y-auto overscroll-contain px-4 pb-1" style={{ WebkitOverflowScrolling: "touch" }}>
                <div className="space-y-4">
              <div className="text-sm space-y-1">
                <p><span className="font-medium">客户:</span> {reviewing.name}</p>
                {reviewing.organization && <p><span className="font-medium">单位:</span> {reviewing.organization}</p>}
                {reviewing.principal && <p><span className="font-medium">负责人:</span> {reviewing.principal}</p>}
                {reviewing.email && <p><span className="font-medium">邮箱:</span> {reviewing.email}</p>}
                {reviewing.wechat && <p><span className="font-medium">微信:</span> {reviewing.wechat}</p>}
                <p><span className="font-medium">提交人:</span> {reviewing.submittedByUser.name}</p>
              </div>

              {actionType !== "reject" && (
                <>
                  {candidatesLoading ? (
                    <div className="text-xs text-muted-foreground">正在检索相似客户...</div>
                  ) : candidates.length > 0 && (
                    <div className="bg-muted/50 border rounded-lg p-3 space-y-2">
                      <div className="flex items-center gap-1 text-sm font-medium">
                        <AlertTriangle className="h-4 w-4" />
                        检测到可能重复的客户 ({candidates.length})
                      </div>
                      <div className="space-y-2">
                        {candidates.map((c) => (
                          <div key={c.id} className="bg-background rounded border p-2 text-sm">
                            <div className="flex items-center justify-between">
                              <div>
                                <span className="font-medium">{c.name}</span>
                                <span className="text-xs text-muted-foreground ml-2">...{c.customerCodeLast6}</span>
                              </div>
                              {c.hasCrmProfile && <Badge variant="secondary" className="ml-1 text-xs">已有CRM</Badge>}
                            </div>
                            <div className="text-xs text-muted-foreground mt-1">
                              {c.organization && <span>{c.organization}</span>}
                            </div>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {c.matchReasons.map((r, i) => (
                                <Badge key={i} variant="secondary" className="text-xs">{r}</Badge>
                              ))}
                            </div>
                            {c.hasCrmProfile ? (
                              <div className="mt-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-xs"
                                  disabled={bindMutation.isPending}
                                  onClick={() => {
                                    setBindTargetId(c.profileId || c.id);
                                    setActionType("bind");
                                  }}
                                >
                                  <Link2 className="h-3 w-3 mr-1" />
                                  绑定到此客户档案
                                </Button>
                              </div>
                            ) : (
                              <div className="mt-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-xs"
                                  disabled={bindMutation.isPending}
                                  onClick={() => {
                                    setBindTargetId(c.id);
                                    setActionType("bind");
                                  }}
                                >
                                  <Link2 className="h-3 w-3 mr-1" />
                                  绑定此客户并创建 CRM 档案
                                </Button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {actionType === "bind" && bindTargetId && (
                    <div className="bg-muted/50 border rounded-lg p-3 text-sm">
                      将把该申请绑定到已有客户档案，不会创建新客户。
                      <Button variant="ghost" size="sm" className="text-xs mt-1" onClick={() => { setBindTargetId(""); setActionType("approve"); }}>
                        取消绑定，创建新客户
                      </Button>
                    </div>
                  )}

                  <div>
                    <label className="text-sm font-medium">CRM 负责人</label>
                    <Select value={ownerUserId} onValueChange={(v) => setOwnerUserId(v || "")}>
                      <SelectTrigger>
                        {ownerUserId
                          ? <span>{assignees.find((a) => a.userId === ownerUserId)?.name || ownerUserId}</span>
                          : <span className="text-muted-foreground">默认: {reviewing.submittedByUser.name}（提交人）</span>}
                      </SelectTrigger>
                      <SelectContent>
                        {assignees.map((a) => (
                          <SelectItem key={a.userId} value={a.userId}>
                            {a.name}{a.userId === reviewing.submittedByUserId ? "（提交人）" : a.kind === "representative" ? "（代表）" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground mt-1">未选择时，默认归属提交人</p>
                  </div>
                </>
              )}

              <div className="space-y-2">
                <label className="text-sm font-medium">审核备注</label>
                <Textarea
                  value={reviewNote}
                  onChange={(e) => setReviewNote(e.target.value)}
                  placeholder="选填，驳回时建议填写原因"
                  rows={3}
                />
              </div>

                </div>
              </div>
              {actionType === "reject" ? (
                <div className="-mx-4 -mb-4 border-t bg-popover/95 px-4 py-3">
                  <Button
                    variant="destructive"
                    className="w-full"
                    disabled={rejectMutation.isPending || rejectReviewMutation.isPending}
                    onClick={() => {
                      if (reviewing?.autoApproved) {
                        rejectReviewMutation.mutate({ id: reviewing.id });
                      } else {
                        rejectMutation.mutate({ id: reviewing.id });
                      }
                    }}
                  >
                    {rejectMutation.isPending || rejectReviewMutation.isPending ? "处理中..." : reviewing?.autoApproved ? "确认拒绝并删除" : "确认驳回"}
                  </Button>
                </div>
              ) : (
                <div className="-mx-4 -mb-4 border-t bg-popover/95 px-4 py-3 flex gap-2">
                  <Button
                    className="flex-1"
                    disabled={approveMutation.isPending || bindMutation.isPending}
                    onClick={() => {
                      if (actionType === "bind" && bindTargetId) {
                        bindMutation.mutate({ id: reviewing.id });
                      } else {
                        approveMutation.mutate({ id: reviewing.id });
                      }
                    }}
                  >
                    {actionType === "bind" ? "确认绑定" : "通过并创建客户"}
                  </Button>
                  <Button
                    variant="destructive"
                    className="flex-1"
                    disabled={approveMutation.isPending || bindMutation.isPending}
                    onClick={() => switchToReject(reviewing)}
                  >
                    驳回
                  </Button>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Batch review reject dialog */}
      <Dialog open={batchReviewDialogOpen} onOpenChange={(v) => { if (!v) { setBatchReviewDialogOpen(false); setBatchReviewNote(""); } }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>批量拒绝复核并删除</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              当前共选中 <span className="font-medium text-foreground">{selectedIds.size}</span> 条申请。
              该操作将拒绝复核并删除自动创建的客户数据，且不可撤销。
            </p>
            <div className="space-y-2">
              <label className="text-sm font-medium">拒绝理由（必填）</label>
              <Textarea
                value={batchReviewNote}
                onChange={(e) => setBatchReviewNote(e.target.value)}
                placeholder="请填写拒绝理由，用于审计和后续追溯"
                rows={3}
              />
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <Button
              variant="destructive"
              className="flex-1"
              disabled={batchRejectReviewMutation.isPending}
              onClick={() => {
                if (!batchReviewNote.trim()) {
                  toast.error("请填写拒绝理由");
                  return;
                }
                batchRejectReviewMutation.mutate();
              }}
            >
              {batchRejectReviewMutation.isPending ? "处理中..." : `确认拒绝并删除 (${selectedIds.size})`}
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              disabled={batchRejectReviewMutation.isPending}
              onClick={() => { setBatchReviewDialogOpen(false); setBatchReviewNote(""); }}
            >
              取消
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}