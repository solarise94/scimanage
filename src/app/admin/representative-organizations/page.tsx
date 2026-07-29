"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2, Check, X, Plus, Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import Link from "next/link";

interface AdminBinding {
  id: string;
  status: string;
  organizationId: string | null;
  requestedOrganizationName: string | null;
  organizationReviewTaskId: string | null;
  reviewNote: string | null;
  createdAt: string;
  organization: {
    id: string;
    canonicalName: string;
    address: string | null;
  } | null;
  representative: {
    id: string;
    name: string;
    email: string;
  };
}

const STATUS_OPTIONS = [
  { value: "PENDING", label: "待审核" },
  { value: "ACTIVE", label: "已通过" },
  { value: "REJECTED", label: "已拒绝" },
  { value: "ARCHIVED", label: "已归档" },
  { value: "ALL", label: "全部" },
];

function statusBadge(status: string) {
  switch (status) {
    case "ACTIVE": return <Badge variant="default">已通过</Badge>;
    case "PENDING": return <Badge variant="secondary">待审核</Badge>;
    case "REJECTED": return <Badge variant="destructive">已拒绝</Badge>;
    case "ARCHIVED": return <Badge variant="outline">已归档</Badge>;
    default: return <Badge variant="outline">{status}</Badge>;
  }
}

export default function AdminRepOrgPage() {
  const { status } = useSession();
  const router = useRouter();

  if (status === "unauthenticated") {
    router.push("/login");
    return null;
  }
  if (status === "loading") return <div className="p-6">加载中...</div>;

  return <AdminRepOrgReview />;
}

function AdminRepOrgReview() {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("PENDING");
  const [repSearch, setRepSearch] = useState("");
  const [reviewTarget, setReviewTarget] = useState<AdminBinding | null>(null);
  const [reviewAction, setReviewAction] = useState<"approve" | "reject">("approve");
  const [reviewNote, setReviewNote] = useState("");
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addRepName, setAddRepName] = useState("");
  const [addOrgName, setAddOrgName] = useState("");

  const isAdmin = session?.user?.role === "ADMIN";

  const { data, isLoading } = useQuery<{ bindings: AdminBinding[] }>({
    queryKey: ["admin-rep-orgs", statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      const res = await fetch(`/api/crm/representative-organizations?${params}`);
      if (!res.ok) throw new Error("加载失败");
      return res.json();
    },
    enabled: isAdmin,
  });

  const reviewMutation = useMutation({
    mutationFn: async ({ id, action, note }: { id: string; action: string; note: string }) => {
      const res = await fetch(`/api/crm/representative-organizations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reviewNote: note || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "操作失败");
      return json as { binding: AdminBinding; autoAssigned?: number };
    },
    onSuccess: (result, vars) => {
      if (vars.action === "approve") {
        const msg = result.autoAssigned
          ? `已通过，自动分配了 ${result.autoAssigned} 位客户`
          : "已通过";
        toast.success(msg);
      } else {
        toast.success("已拒绝");
      }
      setReviewTarget(null);
      setReviewNote("");
      queryClient.invalidateQueries({ queryKey: ["admin-rep-orgs"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const addMutation = useMutation({
    mutationFn: async ({ repId, orgName }: { repId: string; orgName: string }) => {
      const res = await fetch("/api/crm/representative-organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ representativeId: repId, canonicalName: orgName }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "添加失败");
      return json;
    },
    onSuccess: () => {
      toast.success("绑定已添加");
      setAddDialogOpen(false);
      setAddRepName("");
      setAddOrgName("");
      queryClient.invalidateQueries({ queryKey: ["admin-rep-orgs"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (!isAdmin) {
    return <div className="p-6">仅管理员可访问此页面。</div>;
  }

  const bindings = data?.bindings || [];
  const filtered = repSearch.trim()
    ? bindings.filter((b) =>
        b.representative.name.toLowerCase().includes(repSearch.trim().toLowerCase()) ||
        b.representative.email.toLowerCase().includes(repSearch.trim().toLowerCase())
      )
    : bindings;

  return (
    <div className="p-6 space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">绑定审核</h1>
          <p className="text-sm text-muted-foreground mt-1">
            审核代表的单位绑定申请
          </p>
        </div>
        <Button onClick={() => setAddDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          添加绑定
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value ?? "ALL")}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="状态">
              {STATUS_OPTIONS.find((o) => o.value === statusFilter)?.label || statusFilter}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder="搜索代表..."
          value={repSearch}
          onChange={(e) => setRepSearch(e.target.value)}
          className="w-[200px]"
        />
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-8">
          <Loader2 className="h-4 w-4 animate-spin" />
          加载中...
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">
          暂无{statusFilter === "PENDING" ? "待审核" : ""}记录
        </div>
      ) : (
        <div className="grid gap-2">
          {filtered.map((b) => (
            <BindingRow
              key={b.id}
              binding={b}
              onApprove={() => { setReviewTarget(b); setReviewAction("approve"); setReviewNote(""); }}
              onReject={() => { setReviewTarget(b); setReviewAction("reject"); setReviewNote(""); }}
            />
          ))}
        </div>
      )}

      <Dialog open={!!reviewTarget} onOpenChange={(v) => { if (!v) setReviewTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewAction === "approve" ? "通过绑定申请" : "拒绝绑定申请"}
            </DialogTitle>
          </DialogHeader>
          {reviewTarget && !reviewTarget.organizationId && reviewTarget.organizationReviewTaskId && reviewAction === "approve" && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <p>该绑定关联的单位尚未通过主数据审核。</p>
                <Link href="/admin/organization-reviews" className="text-amber-900 underline">
                  前往单位审核
                </Link>
              </div>
            </div>
          )}
          <div className="space-y-3">
            <div className="text-sm">
              <span className="text-muted-foreground">代表: </span>
              {reviewTarget?.representative.name}
            </div>
            <div className="text-sm">
              <span className="text-muted-foreground">单位: </span>
              {reviewTarget?.organization?.canonicalName || reviewTarget?.requestedOrganizationName || "未知"}
            </div>
            <Textarea
              placeholder={reviewAction === "reject" ? "请填写拒绝原因..." : "备注（可选）"}
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewTarget(null)}>取消</Button>
            <Button
              variant={reviewAction === "approve" ? "default" : "destructive"}
              disabled={reviewMutation.isPending || (reviewAction === "reject" && !reviewNote.trim())}
              onClick={() => {
                if (!reviewTarget) return;
                reviewMutation.mutate({ id: reviewTarget.id, action: reviewAction, note: reviewNote.trim() });
              }}
            >
              {reviewMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {reviewAction === "approve" ? "通过" : "拒绝"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AddBindingDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        repName={addRepName}
        onRepNameChange={setAddRepName}
        orgName={addOrgName}
        onOrgNameChange={setAddOrgName}
        isPending={addMutation.isPending}
        onSubmit={(repId, orgName) => addMutation.mutate({ repId, orgName })}
      />
    </div>
  );
}

function BindingRow({
  binding,
  onApprove,
  onReject,
}: {
  binding: AdminBinding;
  onApprove: () => void;
  onReject: () => void;
}) {
  const orgName = binding.organization?.canonicalName || binding.requestedOrganizationName || "未知单位";
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-3">
        <Building2 className="h-5 w-5 text-muted-foreground shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">{orgName}</span>
            {statusBadge(binding.status)}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            代表: {binding.representative.name} · {new Date(binding.createdAt).toLocaleDateString("zh-CN")}
          </p>
          {binding.reviewNote && (
            <p className="text-xs text-muted-foreground mt-0.5">备注: {binding.reviewNote}</p>
          )}
        </div>
        {binding.status === "PENDING" && (
          <div className="flex items-center gap-1 shrink-0">
            <Button size="sm" variant="outline" onClick={onApprove}>
              <Check className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="outline" onClick={onReject}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AddBindingDialog({
  open,
  onOpenChange,
  repName,
  onRepNameChange,
  orgName,
  onOrgNameChange,
  isPending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  repName: string;
  onRepNameChange: (v: string) => void;
  orgName: string;
  onOrgNameChange: (v: string) => void;
  isPending: boolean;
  onSubmit: (repId: string, orgName: string) => void;
}) {
  const { data: repsData } = useQuery<{ representatives: { id: string; name: string; email: string }[] }>({
    queryKey: ["representatives-list-for-binding"],
    queryFn: async () => {
      const res = await fetch("/api/crm/representatives?limit=500");
      if (!res.ok) throw new Error("加载代表列表失败");
      return res.json();
    },
    enabled: open,
  });

  const reps = repsData?.representatives || [];
  const filteredReps = repName.trim()
    ? reps.filter((r) =>
        r.name.toLowerCase().includes(repName.trim().toLowerCase()) ||
        r.email.toLowerCase().includes(repName.trim().toLowerCase())
      )
    : reps;
  const [selectedRepId, setSelectedRepId] = useState("");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>为代表添加绑定</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">选择代表</label>
            <Input
              placeholder="搜索代表姓名或邮箱..."
              value={repName}
              onChange={(e) => { onRepNameChange(e.target.value); setSelectedRepId(""); }}
            />
            {repName.trim() && filteredReps.length > 0 && !selectedRepId && (
              <div className="border rounded-md max-h-32 overflow-y-auto">
                {filteredReps.slice(0, 8).map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm hover:bg-accent"
                    onClick={() => { setSelectedRepId(r.id); onRepNameChange(r.name); }}
                  >
                    {r.name} <span className="text-muted-foreground">({r.email})</span>
                  </button>
                ))}
              </div>
            )}
            {selectedRepId && (
              <p className="text-xs text-muted-foreground">已选择: {repName}</p>
            )}
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">单位名称</label>
            <Input
              placeholder="输入单位名称..."
              value={orgName}
              onChange={(e) => onOrgNameChange(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            disabled={!selectedRepId || !orgName.trim() || isPending}
            onClick={() => onSubmit(selectedRepId, orgName.trim())}
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
