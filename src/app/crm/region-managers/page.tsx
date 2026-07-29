"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DataTable } from "@/components/ui/data-table";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { crmKeys } from "@/lib/crm/query-keys";
import type { CrmRegionManagerItem } from "@/lib/crm/types";
import { toast } from "sonner";
import { Plus, Edit, Archive } from "lucide-react";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";

export default function RegionManagersPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  if (status === "unauthenticated") { router.push("/login"); return null; }
  if (status === "loading") return <PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>;
  if (session?.user?.role !== "ADMIN") { router.push("/crm"); return null; }

  return <RegionManagerConfig />;
}

function RegionManagerConfig() {
  const queryClient = useQueryClient();
  const { confirm } = useConfirm();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<CrmRegionManagerItem | null>(null);

  const { data, isLoading } = useQuery<{ managers: CrmRegionManagerItem[] }>({
    queryKey: crmKeys.regionManagers(),
    queryFn: () => fetch("/api/crm/region-managers").then((r) => r.json()),
  });

  const managers = data?.managers || [];

  const handleArchiveToggle = async (m: CrmRegionManagerItem) => {
    const ok = await confirm({
      title: m.archived ? "恢复地区经理" : "归档地区经理",
      description: m.archived ? "确定恢复该地区经理?" : "确定归档该地区经理?",
      variant: m.archived ? "default" : "destructive",
    });
    if (!ok) return;
    fetch(`/api/crm/region-managers/${m.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: !m.archived }),
    }).then((r) => r.ok ? toast.success(m.archived ? "已恢复" : "已归档") : Promise.reject(r))
      .then(() => queryClient.invalidateQueries({ queryKey: crmKeys.regionManagers() }))
      .catch(() => toast.error("操作失败"));
  };

  const columns = [
    {
      key: "user",
      header: "用户",
      render: (m: CrmRegionManagerItem) => (
        <div>
          <div className="font-medium">{m.user.name}</div>
          <div className="text-xs text-muted-foreground">{m.user.email}</div>
        </div>
      ),
    },
    { key: "region.name", header: "地区名称", render: (m: CrmRegionManagerItem) => m.region?.name || "-" },
    {
      key: "reps",
      header: "负责代表",
      className: "hidden md:table-cell",
      render: (m: CrmRegionManagerItem) => (
        <span className="text-xs bg-info-bg text-info rounded px-2 py-0.5">
          {m.reps.length} 位代表
        </span>
      ),
    },
    {
      key: "archived",
      header: "状态",
      className: "hidden md:table-cell",
      render: (m: CrmRegionManagerItem) => (
        m.archived ? (
          <span className="text-xs bg-neutral-bg text-neutral rounded px-2 py-0.5">已归档</span>
        ) : (
          <span className="text-xs bg-success-bg text-success rounded px-2 py-0.5">活跃</span>
        )
      ),
    },
    {
      key: "actions",
      header: "操作",
      render: (m: CrmRegionManagerItem) => (
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => { setEditTarget(m); setDialogOpen(true); }}>
            <Edit className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => handleArchiveToggle(m)}>
            <Archive className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <PageShell>
      <PageHeader
        title="地区经理设置"
        description="配置地区经理及其负责的代表"
        actions={
          <Button size="sm" className={cn(isMobile && "h-11")} onClick={() => { setEditTarget(null); setDialogOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" />添加地区经理
          </Button>
        }
      />

      <DataTable
        columns={columns}
        data={managers}
        keyExtractor={(m) => m.id}
        isLoading={isLoading}
        emptyTitle="暂无地区经理"
        emptyDescription="点击右上角添加"
        renderMobileCard={(m) => (
          <div key={m.id} className="rounded-lg border bg-card p-4 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{m.user.name}</div>
                <div className="text-xs text-muted-foreground">{m.user.email}</div>
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={() => { setEditTarget(m); setDialogOpen(true); }}>
                  <Edit className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => handleArchiveToggle(m)}>
                  <Archive className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div>
                <span className="text-muted-foreground text-xs">地区</span>
                <div className="font-medium truncate">{m.region?.name || "-"}</div>
              </div>
              <div>
                <span className="text-muted-foreground text-xs">负责代表</span>
                <div className="font-medium">{m.reps.length} 位</div>
              </div>
              <div>
                <span className="text-muted-foreground text-xs">状态</span>
                <div className="font-medium">{m.archived ? "已归档" : "活跃"}</div>
              </div>
            </div>
          </div>
        )}
      />

      {dialogOpen && (
        <RegionManagerDialog
          edit={editTarget}
          onClose={() => setDialogOpen(false)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: crmKeys.regionManagers() });
            setDialogOpen(false);
          }}
        />
      )}
    </PageShell>
  );
}

function RegionManagerDialog({
  edit,
  onClose,
  onSaved,
}: {
  edit: CrmRegionManagerItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selectedUserId, setSelectedUserId] = useState(edit?.userId || "");
  const [regionId, setRegionId] = useState(edit?.regionId || "");
  const [selectedRepIds, setSelectedRepIds] = useState<string[]>(
    edit?.reps.map((r) => r.representativeId) || []
  );

  const { data: usersData } = useQuery<{ users: { id: string; name: string; email: string }[] }>({
    queryKey: ["admin-users"],
    queryFn: () => fetch("/api/users").then((r) => r.json()),
  });
  const { data: repsData } = useQuery<{ representatives: { id: string; name: string; email: string }[] }>({
    queryKey: ["admin-representatives"],
    queryFn: () => fetch("/api/representatives/list").then((r) => r.json()),
  });
  const { data: regionsData } = useQuery<{ regions: { id: string; name: string }[] }>({
    queryKey: ["representative-regions"],
    queryFn: () => fetch("/api/crm/representative-regions").then((r) => r.json()),
  });

  const users = usersData?.users || [];
  const reps = repsData?.representatives || [];
  const regions = regionsData?.regions || [];

  const mutation = useMutation({
    mutationFn: async () => {
      const url = edit ? `/api/crm/region-managers/${edit.id}` : "/api/crm/region-managers";
      const method = edit ? "PATCH" : "POST";
      const body: Record<string, unknown> = edit ? { regionId: regionId || null, repIds: selectedRepIds } : { userId: selectedUserId, regionId: regionId || null, repIds: selectedRepIds };
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "保存失败");
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success(edit ? "已更新" : "地区经理已添加");
      onSaved();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{edit ? "编辑地区经理" : "添加地区经理"}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          {!edit && (
            <div>
              <label className="text-sm font-medium">选择用户</label>
              <Select value={selectedUserId} onValueChange={(v) => setSelectedUserId(v || "")}>
                <SelectTrigger>
                  {selectedUserId
                    ? <span>{users.find((u) => u.id === selectedUserId)?.name || selectedUserId}</span>
                    : <span className="text-muted-foreground">选择用户...</span>}
                </SelectTrigger>
                <SelectContent>
                  {users.filter((u) => u).map((u) => (
                    <SelectItem key={u.id} value={u.id}>{u.name} ({u.email})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <label className="text-sm font-medium">地区名称</label>
            <Select value={regionId} onValueChange={(v) => setRegionId(v || "")}>
              <SelectTrigger>
                {regionId
                  ? <span>{regions.find((r) => r.id === regionId)?.name || regionId}</span>
                  : <span className="text-muted-foreground">选择地区...</span>}
              </SelectTrigger>
              <SelectContent>
                {regions.map((r) => (
                  <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              如需新增地区，请前往{" "}
              <a href="/admin/representative-regions" className="text-primary hover:underline">地区管理</a>
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-sm font-medium">负责代表 ({selectedRepIds.length} 位)</Label>
            <div className="border rounded-md max-h-40 overflow-y-auto p-2 space-y-1 mt-1">
              {reps.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-2 text-sm hover:bg-muted/50 rounded px-1 py-0.5"
                >
                  <Checkbox
                    id={`rep-${r.id}`}
                    checked={selectedRepIds.includes(r.id)}
                    onCheckedChange={(checked) => {
                      if (checked) setSelectedRepIds([...selectedRepIds, r.id]);
                      else setSelectedRepIds(selectedRepIds.filter((id) => id !== r.id));
                    }}
                  />
                  <Label htmlFor={`rep-${r.id}`} className="flex-1 cursor-pointer">
                    {r.name} <span className="text-xs text-muted-foreground">{r.email}</span>
                  </Label>
                </div>
              ))}
              {reps.length === 0 && <p className="text-xs text-muted-foreground p-2">暂无代表</p>}
            </div>
          </div>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || (!edit && !selectedUserId)} className="w-full">
            {mutation.isPending ? "保存中..." : "保存"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}