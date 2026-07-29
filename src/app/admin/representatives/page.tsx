"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Search,
  Plus,
  Send,
  Mail,
  Pencil,
  Archive,
  ArchiveRestore,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DataTable, DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RepresentativeRegionEditor } from "@/components/crm/representative-region-editor";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";

interface RepItem {
  id: string;
  name: string;
  email: string;
  kind?: string;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string;
  _count?: { projects: number };
}

export default function AdminRepresentativesPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const queryClient = useQueryClient();
  const { confirm } = useConfirm();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<RepItem | null>(null);
  const [form, setForm] = useState({ name: "", email: "" });
  const [editForm, setEditForm] = useState({ name: "", email: "" });
  const [editRegionIds, setEditRegionIds] = useState<string[]>([]);
  const [loadingRegions, setLoadingRegions] = useState(false);

  const { data, isLoading, error } = useQuery<{ representatives: RepItem[] }>({
    queryKey: ["admin-representatives"],
    queryFn: async () => {
      const res = await fetch("/api/representatives");
      if (res.status === 403) throw new Error("无权访问");
      if (!res.ok) throw new Error("Failed to load representatives");
      return res.json();
    },
    enabled: status === "authenticated" && session?.user?.role === "ADMIN",
  });

  useEffect(() => {
    if (status === "authenticated" && session?.user?.role !== "ADMIN") {
      router.push("/dashboard");
    }
    if (error?.message === "无权访问") {
      router.push("/dashboard");
    }
  }, [status, session, error, router]);

  const createMutation = useMutation({
    mutationFn: async (payload: { name: string; email: string }) => {
      const res = await fetch("/api/representatives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "创建失败");
      return data;
    },
    onSuccess: () => {
      toast.success("代表添加成功，登录链接正在发送");
      setOpen(false);
      setForm({ name: "", email: "" });
      queryClient.invalidateQueries({ queryKey: ["admin-representatives"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: async (payload: { id: string; name?: string; email?: string; regionIds?: string[] }) => {
      const res = await fetch(`/api/representatives/${payload.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "更新失败");
      return data;
    },
    onSuccess: () => {
      toast.success("代表信息已更新");
      setEditOpen(false);
      setEditing(null);
      queryClient.invalidateQueries({ queryKey: ["admin-representatives"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const archiveMutation = useMutation({
    mutationFn: async ({ id, archived }: { id: string; archived: boolean }) => {
      const res = await fetch(`/api/representatives/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "操作失败");
      return data;
    },
    onSuccess: (_, vars) => {
      toast.success(vars.archived ? "代表已归档" : "代表已恢复");
      queryClient.invalidateQueries({ queryKey: ["admin-representatives"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const resendMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/representatives/${id}/resend`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "重发失败");
      return data;
    },
    onSuccess: () => {
      toast.success("登录链接正在重新发送");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (status === "loading") return null;
  if (!session || session.user.role !== "ADMIN") return null;
  if (error?.message === "无权访问") return null;

  const reps = data?.representatives || [];
  const filtered = reps
    .filter(
      (r) =>
        r.name.toLowerCase().includes(search.toLowerCase()) ||
        r.email.toLowerCase().includes(search.toLowerCase())
    )
    // 本部系统代表（kind=SYSTEM）置底显示
    .sort((a, b) => {
      const aSys = a.kind === "SYSTEM" ? 1 : 0;
      const bSys = b.kind === "SYSTEM" ? 1 : 0;
      return aSys - bSys;
    });

  const openEdit = async (rep: RepItem) => {
    setEditing(rep);
    setEditForm({ name: rep.name, email: rep.email });
    setEditRegionIds([]);
    setLoadingRegions(true);
    setEditOpen(true);
    try {
      const d = await fetch(`/api/crm/representatives/${rep.id}`).then((r) => r.json());
      if (d?.regions) setEditRegionIds(d.regions.map((rg: { id: string }) => rg.id));
    } catch { /* ignore */ }
    finally { setLoadingRegions(false); }
  };

  const handleArchive = async (rep: RepItem) => {
    const action = rep.archived ? "恢复" : "归档";
    const ok = await confirm({
      title: `${action}代表`,
      description: `确定要${action}代表 "${rep.name}" 吗？`,
    });
    if (ok) {
      archiveMutation.mutate({ id: rep.id, archived: !rep.archived });
    }
  };

  const StatusBadge = ({ rep }: { rep: RepItem }) =>
    rep.kind === "SYSTEM" ? (
      <Badge variant="outline" className="text-xs border-blue-300 text-blue-600 bg-blue-50 shrink-0 whitespace-nowrap">
        系统
      </Badge>
    ) : rep.archived ? (
      <Badge variant="outline" className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">
        <Archive className="h-3 w-3 mr-1" />
        已归档
        {rep.archivedAt && (
          <span className="ml-1">({new Date(rep.archivedAt).toLocaleDateString("zh-CN")})</span>
        )}
      </Badge>
    ) : (
      <Badge variant="default" className="text-xs bg-green-600 hover:bg-green-700 shrink-0 whitespace-nowrap">
        在职
      </Badge>
    );

  const columns: DataTableColumn<RepItem>[] = [
    {
      key: "name",
      header: "代表",
      render: (rep) => (
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-amber-500 text-white text-xs flex items-center justify-center shrink-0">
            {rep.name?.slice(0, 2)?.toUpperCase() || "R"}
          </div>
          <div className="flex flex-col min-w-0">
            <span className="font-medium truncate max-w-[160px]">{rep.name}</span>
            <span className="text-xs text-muted-foreground truncate max-w-[160px]">{rep.email}</span>
          </div>
        </div>
      ),
    },
    { key: "email", header: "邮箱", render: (rep) => <span className="text-muted-foreground truncate max-w-[200px] block">{rep.email}</span> },
    {
      key: "projects",
      header: "关联项目",
      render: (rep) => (
        <Badge variant="secondary" className="text-xs shrink-0 whitespace-nowrap">
          {rep._count?.projects ?? 0} 个项目
        </Badge>
      ),
    },
    { key: "status", header: "状态", render: (rep) => <StatusBadge rep={rep} /> },
    {
      key: "actions",
      header: "操作",
      align: "right",
      render: (rep) => (
        <div className="flex items-center justify-end gap-1 flex-wrap">
          <Button variant="ghost" size="sm" onClick={() => openEdit(rep)} title="编辑">
            <Pencil className="h-3 w-3 mr-1" />
            编辑
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => resendMutation.mutate(rep.id)}
            disabled={resendMutation.isPending || rep.archived || rep.kind === "SYSTEM"}
            title={rep.kind === "SYSTEM" ? "系统代表不支持登录链接" : "重发 Magic Link"}
          >
            <Send className="h-3 w-3 mr-1" />
            重发
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={rep.kind === "SYSTEM"}
            title={rep.kind === "SYSTEM" ? "系统代表不可归档" : undefined}
            className={
              rep.archived
                ? "text-green-600 hover:text-green-700 hover:bg-green-50"
                : "text-amber-600 hover:text-amber-700 hover:bg-amber-50"
            }
            onClick={() => handleArchive(rep)}
          >
            {rep.archived ? (
              <>
                <ArchiveRestore className="h-3 w-3 mr-1" />
                恢复
              </>
            ) : (
              <>
                <Archive className="h-3 w-3 mr-1" />
                归档
              </>
            )}
          </Button>
        </div>
      ),
    },
  ];

  const renderMobileCard = (rep: RepItem) => (
    <div className={`rounded-lg border bg-card p-4 space-y-3 ${rep.archived ? "opacity-60 bg-muted/20" : ""}`}>
      <div className="flex items-center justify-between gap-2 min-w-0">
        <span className="truncate text-base font-medium">{rep.name}</span>
        <StatusBadge rep={rep} />
      </div>
      <div className="text-xs text-muted-foreground truncate">{rep.email}</div>
      <div>
        <Badge variant="secondary" className="text-xs shrink-0 whitespace-nowrap">
          {rep._count?.projects ?? 0} 个项目
        </Badge>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Button variant="outline" size="sm" onClick={() => openEdit(rep)}>
          <Pencil className="h-3 w-3 mr-1" />
          编辑
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => resendMutation.mutate(rep.id)}
          disabled={resendMutation.isPending || rep.archived || rep.kind === "SYSTEM"}
        >
          <Send className="h-3 w-3 mr-1" />
          重发
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={rep.kind === "SYSTEM"}
          className={
            rep.archived
              ? "text-green-600 hover:text-green-700 hover:bg-green-50"
              : "text-amber-600 hover:text-amber-700 hover:bg-amber-50"
          }
          onClick={() => handleArchive(rep)}
        >
          {rep.archived ? (
            <>
              <ArchiveRestore className="h-3 w-3 mr-1" />
              恢复
            </>
          ) : (
            <>
              <Archive className="h-3 w-3 mr-1" />
              归档
            </>
          )}
        </Button>
      </div>
    </div>
  );

  return (
    <PageShell>
      <PageHeader
        title="代表管理"
        description="管理项目代表，发送 Magic Link 登录链接"
      />

      <div className="flex flex-col sm:flex-row gap-3 min-w-0">
        <div className="relative flex-1 max-w-md min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="搜索代表..."
            className="pl-9 w-full"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button onClick={() => setOpen(true)} className="w-full sm:w-auto">
          <Plus className="mr-2 h-4 w-4" />
          添加代表
        </Button>
      </div>

      {error ? (
        <div className="rounded-lg border bg-card p-12 text-center">
          <p className="text-destructive">加载失败：{error.message}</p>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={filtered}
          keyExtractor={(rep) => rep.id}
          isLoading={isLoading}
          emptyTitle="暂无代表"
          emptyDescription="点击右上角添加代表"
          renderMobileCard={renderMobileCard}
        />
      )}

      {/* Add Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
          <DialogHeader>
            <DialogTitle>添加代表</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!form.name.trim() || !form.email.trim()) return;
              createMutation.mutate({ name: form.name.trim(), email: form.email.trim() });
            }}
            className="contents"
          >
            <div className="-mx-4 min-h-0 overflow-y-auto overscroll-contain px-4 pb-1" style={{ WebkitOverflowScrolling: "touch" }}>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>代表姓名</Label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="请输入代表姓名"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label>通知邮箱</Label>
                  <Input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    placeholder="代表用于接收通知和登录的邮箱"
                    required
                  />
                </div>
              </div>
            </div>
            <div className="-mx-4 -mb-4 border-t bg-popover/95 px-4 py-3">
              <Button type="submit" className="w-full" disabled={createMutation.isPending}>
                <Mail className="mr-2 h-4 w-4" />
                {createMutation.isPending ? "发送中..." : "添加并发送 Magic Link"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-md max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
          <DialogHeader>
            <DialogTitle>编辑代表信息</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!editing) return;
              const updates: { name?: string; email?: string; regionIds?: string[] } = {};
              if (editForm.name.trim() !== editing.name) updates.name = editForm.name.trim();
              if (editForm.email.trim().toLowerCase() !== editing.email) {
                updates.email = editForm.email.trim().toLowerCase();
              }
              updates.regionIds = editRegionIds;
              updateMutation.mutate({ id: editing.id, ...updates });
            }}
            className="contents"
          >
            <div className="-mx-4 min-h-0 overflow-y-auto overscroll-contain px-4 pb-1" style={{ WebkitOverflowScrolling: "touch" }}>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>代表姓名</Label>
                  <Input
                    value={editForm.name}
                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                    placeholder="请输入代表姓名"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label>通知邮箱</Label>
                  <Input
                    type="email"
                    value={editForm.email}
                    onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                    placeholder="代表用于接收通知和登录的邮箱"
                    required
                  />
                </div>
                {editing && (
                  <RepresentativeRegionEditor
                    representativeId={editing.id}
                    embedded
                    selectedIds={editRegionIds}
                    onSelectionChange={setEditRegionIds}
                  />
                )}
              </div>
            </div>
            <div className="-mx-4 -mb-4 border-t bg-popover/95 px-4 py-3">
              <Button type="submit" className="w-full" disabled={updateMutation.isPending || loadingRegions}>
                <Pencil className="mr-2 h-4 w-4" />
                {updateMutation.isPending ? "保存中..." : "保存修改"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}