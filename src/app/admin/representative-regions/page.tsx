"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Archive, ArchiveRestore } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DataTable, DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";

interface RegionItem {
  id: string;
  name: string;
  province: string | null;
  city: string | null;
  district: string | null;
  description: string | null;
  archived: boolean;
  _count: { reps: number };
}

export default function RepresentativeRegionsPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data: session, status } = useSession();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RegionItem | null>(null);
  const [formName, setFormName] = useState("");
  const [formProvince, setFormProvince] = useState("");
  const [formCity, setFormCity] = useState("");
  const [formDistrict, setFormDistrict] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const { data, isLoading } = useQuery<{ regions: RegionItem[] }>({
    queryKey: ["representative-regions"],
    queryFn: async () => {
      const res = await fetch("/api/crm/representative-regions?archived=true");
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });

  const regions = data?.regions || [];

  const saveMutation = useMutation({
    mutationFn: async () => {
      const url = editing
        ? `/api/crm/representative-regions/${editing.id}`
        : "/api/crm/representative-regions";
      const method = editing ? "PATCH" : "POST";
      const body = {
        name: formName.trim(),
        province: formProvince.trim() || "",
        city: formCity.trim() || "",
        district: formDistrict.trim() || "",
        description: formDesc.trim() || "",
      };
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "保存失败");
      return d;
    },
    onSuccess: () => {
      toast.success(editing ? "已更新" : "已创建");
      setDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ["representative-regions"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const archiveMutation = useMutation({
    mutationFn: async ({ id, archived }: { id: string; archived: boolean }) => {
      const res = await fetch(`/api/crm/representative-regions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived }),
      });
      if (!res.ok) throw new Error("操作失败");
    },
    onSuccess: () => {
      toast.success("已更新");
      queryClient.invalidateQueries({ queryKey: ["representative-regions"] });
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
    setFormProvince("");
    setFormCity("");
    setFormDistrict("");
    setFormDesc("");
    setDialogOpen(true);
  };

  const openEdit = (r: RegionItem) => {
    setEditing(r);
    setFormName(r.name);
    setFormProvince(r.province || "");
    setFormCity(r.city || "");
    setFormDistrict(r.district || "");
    setFormDesc(r.description || "");
    setDialogOpen(true);
  };

  const displayed = showArchived ? regions : regions.filter((r) => !r.archived);

  const NameCell = ({ r }: { r: RegionItem }) => (
    <div className="flex items-center gap-1.5 flex-wrap">
      {r.name}
      {r.archived && <Badge variant="outline" className="text-[10px]">已归档</Badge>}
    </div>
  );

  const columns: DataTableColumn<RegionItem>[] = [
    {
      key: "name",
      header: "名称",
      render: (r) => <NameCell r={r} />,
    },
    { key: "province", header: "省份", render: (r) => <span className="text-muted-foreground">{r.province || "—"}</span> },
    { key: "city", header: "城市", render: (r) => <span className="text-muted-foreground">{r.city || "—"}</span> },
    { key: "district", header: "区县", render: (r) => <span className="text-muted-foreground">{r.district || "—"}</span> },
    { key: "repCount", header: "代表数", align: "right", render: (r) => r._count.reps },
    {
      key: "actions",
      header: "操作",
      align: "right",
      render: (r) => (
        <div className="flex items-center justify-end gap-1">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(r)} title="编辑">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          {!r.archived ? (
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => archiveMutation.mutate({ id: r.id, archived: true })} title="归档">
              <Archive className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => archiveMutation.mutate({ id: r.id, archived: false })} title="取消归档">
              <ArchiveRestore className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  const renderMobileCard = (r: RegionItem) => (
    <div className="rounded-lg border bg-card p-4 space-y-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="font-medium">{r.name}</span>
        {r.archived && <Badge variant="outline" className="text-[10px]">已归档</Badge>}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
        {r.province && <span>{r.province}</span>}
        {r.city && <span>{r.city}</span>}
        {r.district && <span>{r.district}</span>}
        {!r.province && !r.city && !r.district && <span>—</span>}
      </div>
      <div className="text-sm">代表数：{r._count.reps}</div>
      <div className="flex justify-end gap-1 pt-1">
        <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => openEdit(r)} title="编辑">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        {!r.archived ? (
          <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => archiveMutation.mutate({ id: r.id, archived: true })} title="归档">
            <Archive className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => archiveMutation.mutate({ id: r.id, archived: false })} title="取消归档">
            <ArchiveRestore className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <PageShell>
      <PageHeader
        title="地区管理"
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant={showArchived ? "secondary" : "ghost"} onClick={() => setShowArchived(!showArchived)} className="text-xs">
              {showArchived ? "隐藏已归档" : "显示已归档"}
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1 h-3 w-3" /> 新建地区
            </Button>
          </div>
        }
      />

      <DataTable
        columns={columns}
        data={displayed}
        keyExtractor={(r) => r.id}
        isLoading={isLoading}
        emptyTitle="暂无地区"
        emptyDescription="点击右上角新建地区"
        renderMobileCard={renderMobileCard}
      />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑地区" : "新建地区"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">名称 *</Label>
              <Input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="地区名称" className="h-8 text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">省份</Label>
                <Input value={formProvince} onChange={(e) => setFormProvince(e.target.value)} placeholder="省份" className="h-8 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">城市</Label>
                <Input value={formCity} onChange={(e) => setFormCity(e.target.value)} placeholder="城市" className="h-8 text-sm" />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">区县</Label>
              <Input value={formDistrict} onChange={(e) => setFormDistrict(e.target.value)} placeholder="区县" className="h-8 text-sm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">说明</Label>
              <Input value={formDesc} onChange={(e) => setFormDesc(e.target.value)} placeholder="备注说明" className="h-8 text-sm" />
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