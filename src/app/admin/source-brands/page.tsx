"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Archive, ArchiveRestore } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { DataTable, DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";

interface BrandItem {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  archived: boolean;
}

export default function SourceBrandsPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data: session, status } = useSession();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<BrandItem | null>(null);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formIsDefault, setFormIsDefault] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const { data, isLoading } = useQuery<{ brands: BrandItem[] }>({
    queryKey: ["source-brands", "admin"],
    queryFn: async () => {
      const res = await fetch("/api/source-brands?includeArchived=true");
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });

  const brands = data?.brands || [];

  const saveMutation = useMutation({
    mutationFn: async () => {
      const url = editing
        ? `/api/source-brands/${editing.id}`
        : "/api/source-brands";
      const method = editing ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: formName, description: formDesc, isDefault: formIsDefault }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "保存失败");
      return d;
    },
    onSuccess: () => {
      toast.success(editing ? "已更新" : "已创建");
      setDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ["source-brands", "admin"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const archiveMutation = useMutation({
    mutationFn: async ({ id, archived }: { id: string; archived: boolean }) => {
      const res = await fetch(`/api/source-brands/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived }),
      });
      if (!res.ok) throw new Error("操作失败");
    },
    onSuccess: () => {
      toast.success("已更新");
      queryClient.invalidateQueries({ queryKey: ["source-brands", "admin"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (status === "loading") return null;
  if (!session || session.user.role !== "ADMIN") {
    router.replace("/dashboard");
    return null;
  }

  const openCreate = () => {
    setEditing(null);
    setFormName("");
    setFormDesc("");
    setFormIsDefault(false);
    setDialogOpen(true);
  };

  const openEdit = (b: BrandItem) => {
    setEditing(b);
    setFormName(b.name);
    setFormDesc(b.description || "");
    setFormIsDefault(b.isDefault);
    setDialogOpen(true);
  };

  const displayed = showArchived ? brands : brands.filter((b) => !b.archived);

  const NameCell = ({ b }: { b: BrandItem }) => (
    <div className="flex items-center gap-1.5 flex-wrap">
      {b.name}
      {b.isDefault && <Badge variant="secondary" className="text-[10px]">默认</Badge>}
      {b.archived && <Badge variant="outline" className="text-[10px]">已归档</Badge>}
    </div>
  );

  const columns: DataTableColumn<BrandItem>[] = [
    {
      key: "name",
      header: "名称",
      render: (b) => <NameCell b={b} />,
    },
    { key: "description", header: "说明", render: (b) => <span className="text-muted-foreground">{b.description || "—"}</span> },
    {
      key: "actions",
      header: "操作",
      align: "right",
      render: (b) => (
        <div className="flex items-center justify-end gap-1">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(b)} title="编辑">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          {!b.archived && !b.isDefault && (
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => archiveMutation.mutate({ id: b.id, archived: true })} title="归档">
              <Archive className="h-3.5 w-3.5" />
            </Button>
          )}
          {b.archived && (
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => archiveMutation.mutate({ id: b.id, archived: false })} title="取消归档">
              <ArchiveRestore className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  const renderMobileCard = (b: BrandItem) => (
    <div className="rounded-lg border bg-card p-4 space-y-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="font-medium">{b.name}</span>
        {b.isDefault && <Badge variant="secondary" className="text-[10px]">默认</Badge>}
        {b.archived && <Badge variant="outline" className="text-[10px]">已归档</Badge>}
      </div>
      <div className="text-sm text-muted-foreground">{b.description || "—"}</div>
      <div className="flex justify-end gap-1 pt-1">
        <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => openEdit(b)} title="编辑">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        {!b.archived && !b.isDefault && (
          <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => archiveMutation.mutate({ id: b.id, archived: true })} title="归档">
            <Archive className="h-3.5 w-3.5" />
          </Button>
        )}
        {b.archived && (
          <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => archiveMutation.mutate({ id: b.id, archived: false })} title="取消归档">
            <ArchiveRestore className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <PageShell>
      <PageHeader
        title="来源品牌管理"
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant={showArchived ? "secondary" : "ghost"} onClick={() => setShowArchived(!showArchived)} className="text-xs">
              {showArchived ? "隐藏已归档" : "显示已归档"}
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1 h-3 w-3" /> 新建
            </Button>
          </div>
        }
      />

      <DataTable
        columns={columns}
        data={displayed}
        keyExtractor={(b) => b.id}
        isLoading={isLoading}
        emptyTitle="暂无来源品牌"
        renderMobileCard={renderMobileCard}
      />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑来源品牌" : "新建来源品牌"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">名称 *</Label>
              <Input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="品牌名称" className="h-8 text-sm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">说明</Label>
              <Input value={formDesc} onChange={(e) => setFormDesc(e.target.value)} placeholder="备注说明" className="h-8 text-sm" />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox checked={formIsDefault} onCheckedChange={(v) => setFormIsDefault(!!v)} id="isDefault" />
              <Label htmlFor="isDefault" className="text-xs">设为默认来源品牌</Label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>取消</Button>
              <Button size="sm" disabled={!formName.trim() || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                {editing ? "保存" : "创建"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}