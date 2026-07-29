"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Archive, ArchiveRestore, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable, DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";

interface ExternalContactItem {
  id: string;
  name: string;
  email: string;
  department: string | null;
  description: string | null;
  ccEmails: string | null;
  enabled: boolean;
  archived: boolean;
}

interface FormState {
  name: string;
  email: string;
  department: string;
  description: string;
  ccEmails: string;
  enabled: boolean;
}

const emptyForm: FormState = {
  name: "", email: "", department: "", description: "", ccEmails: "", enabled: true,
};

export default function ExternalContactsPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data: session, status } = useSession();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ExternalContactItem | null>(null);
  const [form, setForm] = useState<FormState>({ ...emptyForm });
  const [showArchived, setShowArchived] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importResult, setImportResult] = useState<{
    created: number;
    skippedCount: number;
    skipped: { line: number; raw: string; reason: string }[];
  } | null>(null);

  const { data, isLoading } = useQuery<{ contacts: ExternalContactItem[] }>({
    queryKey: ["external-contacts", "admin"],
    queryFn: async () => {
      const res = await fetch("/api/admin/external-contacts?includeArchived=1");
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });

  const contacts = data?.contacts || [];

  const saveMutation = useMutation({
    mutationFn: async () => {
      const url = editing
        ? `/api/admin/external-contacts/${editing.id}`
        : "/api/admin/external-contacts";
      const method = editing ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "保存失败");
      return d;
    },
    onSuccess: () => {
      toast.success(editing ? "已更新" : "已创建");
      setDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ["external-contacts", "admin"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const archiveMutation = useMutation({
    mutationFn: async ({ id, archived }: { id: string; archived: boolean }) => {
      const res = await fetch(`/api/admin/external-contacts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived }),
      });
      if (!res.ok) throw new Error("操作失败");
    },
    onSuccess: () => {
      toast.success("已更新");
      queryClient.invalidateQueries({ queryKey: ["external-contacts", "admin"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/external-contacts/bulk-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: importText }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "导入失败");
      return d as {
        created: number;
        skippedCount: number;
        skipped: { line: number; raw: string; reason: string }[];
      };
    },
    onSuccess: (d) => {
      setImportResult(d);
      toast.success(`导入完成：新增 ${d.created} 条，跳过 ${d.skippedCount} 条`);
      queryClient.invalidateQueries({ queryKey: ["external-contacts", "admin"] });
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
    setForm({ ...emptyForm });
    setDialogOpen(true);
  };

  const openEdit = (c: ExternalContactItem) => {
    setEditing(c);
    setForm({
      name: c.name,
      email: c.email,
      department: c.department || "",
      description: c.description || "",
      ccEmails: c.ccEmails || "",
      enabled: c.enabled,
    });
    setDialogOpen(true);
  };

  const displayed = showArchived ? contacts : contacts.filter((c) => !c.archived);

  // 按部门分组展示（FINANCE 置顶，未分组置底）。contacts 已按 department/name 排序。
  const groups = (() => {
    const map = new Map<string, ExternalContactItem[]>();
    for (const c of displayed) {
      const key = c.department?.trim() || "__ungrouped__";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    const entries = Array.from(map.entries());
    entries.sort(([a], [b]) => {
      if (a === "FINANCE") return -1;
      if (b === "FINANCE") return 1;
      if (a === "__ungrouped__") return 1;
      if (b === "__ungrouped__") return -1;
      return a.localeCompare(b, "zh");
    });
    return entries;
  })();

  const openImport = () => {
    setImportText("");
    setImportResult(null);
    setImportOpen(true);
  };

  const NameCell = ({ c }: { c: ExternalContactItem }) => (
    <div className="flex items-center gap-1.5 flex-wrap">
      {c.name}
      {!c.enabled && <Badge variant="outline" className="text-[10px]">已停用</Badge>}
      {c.archived && <Badge variant="outline" className="text-[10px]">已归档</Badge>}
    </div>
  );

  const columns: DataTableColumn<ExternalContactItem>[] = [
    {
      key: "name",
      header: "名称",
      render: (c) => <NameCell c={c} />,
    },
    { key: "email", header: "收件邮箱", render: (c) => <span className="text-muted-foreground">{c.email}</span> },
    { key: "department", header: "部门", render: (c) => <span className="text-muted-foreground">{c.department || "—"}</span> },
    { key: "ccEmails", header: "抄送", render: (c) => <span className="text-muted-foreground">{c.ccEmails || "—"}</span> },
    {
      key: "actions",
      header: "操作",
      align: "right",
      render: (c) => (
        <div className="flex items-center justify-end gap-1">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(c)} title="编辑">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon" variant="ghost" className="h-7 w-7"
            onClick={() => archiveMutation.mutate({ id: c.id, archived: !c.archived })}
            title={c.archived ? "取消归档" : "归档"}
          >
            {c.archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
          </Button>
        </div>
      ),
    },
  ];

  const renderMobileCard = (c: ExternalContactItem) => (
    <div className="rounded-lg border bg-card p-4 space-y-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="font-medium">{c.name}</span>
        {!c.enabled && <Badge variant="outline" className="text-[10px]">已停用</Badge>}
        {c.archived && <Badge variant="outline" className="text-[10px]">已归档</Badge>}
      </div>
      <div className="text-sm text-muted-foreground">邮箱：{c.email}</div>
      <div className="text-sm text-muted-foreground">部门：{c.department || "—"}</div>
      <div className="text-sm text-muted-foreground">抄送：{c.ccEmails || "—"}</div>
      <div className="flex justify-end gap-1 pt-1">
        <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => openEdit(c)} title="编辑">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon" variant="outline" className="h-8 w-8"
          onClick={() => archiveMutation.mutate({ id: c.id, archived: !c.archived })}
          title={c.archived ? "取消归档" : "归档"}
        >
          {c.archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );

  return (
    <PageShell>
      <PageHeader
        title="外部通讯录管理"
        description="项目里程碑、发票、财务通知的外部收件人。财务通知收件人请将「部门」填为 FINANCE。"
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant={showArchived ? "secondary" : "ghost"} onClick={() => setShowArchived(!showArchived)} className="text-xs">
              {showArchived ? "隐藏已归档" : "显示已归档"}
            </Button>
            <Button size="sm" variant="outline" onClick={openImport}>
              <Upload className="mr-1 h-3 w-3" /> 批量导入
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1 h-3 w-3" /> 新建
            </Button>
          </div>
        }
      />

      {isLoading ? (
        <DataTable
          columns={columns}
          data={[]}
          keyExtractor={(c) => c.id}
          isLoading
          emptyTitle="暂无外部联系人"
          renderMobileCard={renderMobileCard}
        />
      ) : groups.length === 0 ? (
        <DataTable
          columns={columns}
          data={[]}
          keyExtractor={(c) => c.id}
          emptyTitle="暂无外部联系人"
          renderMobileCard={renderMobileCard}
        />
      ) : (
        <div className="space-y-6">
          {groups.map(([key, items]) => (
            <div key={key} className="space-y-2">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">
                  {key === "__ungrouped__" ? "未分组" : key}
                  {key === "FINANCE" && <span className="ml-1 text-xs text-muted-foreground">（财务通知收件人）</span>}
                </h3>
                <Badge variant="secondary" className="text-[10px]">{items.length}</Badge>
              </div>
              <DataTable
                columns={columns}
                data={items}
                keyExtractor={(c) => c.id}
                emptyTitle="—"
                renderMobileCard={renderMobileCard}
              />
            </div>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑外部联系人" : "新建外部联系人"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">名称 *</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="联系人 / 部门名称" className="h-8 text-sm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">收件邮箱 *</Label>
              <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@example.com" className="h-8 text-sm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">部门</Label>
              <Input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} placeholder="财务通知请填 FINANCE" className="h-8 text-sm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">抄送邮箱（逗号/分号分隔）</Label>
              <Input value={form.ccEmails} onChange={(e) => setForm({ ...form, ccEmails: e.target.value })} placeholder="cc1@example.com, cc2@example.com" className="h-8 text-sm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">备注</Label>
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="备注说明" className="h-8 text-sm" />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: !!v })} id="enabled" />
              <Label htmlFor="enabled" className="text-xs">启用（参与通知发送）</Label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>取消</Button>
              <Button size="sm" disabled={!form.name.trim() || !form.email.trim() || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                {editing ? "保存" : "创建"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>批量导入外部联系人</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground space-y-1">
              <p>每行一条，逗号分隔，列顺序：</p>
              <p className="font-mono bg-muted rounded px-2 py-1">名称,邮箱,部门,抄送邮箱,备注</p>
              <p>邮箱必填且须含 @；抄送多个用「;」分隔；财务收件人「部门」填 <span className="font-mono">FINANCE</span>。首行表头会自动跳过；邮箱重复（库内或批次内）会跳过。</p>
            </div>
            <Textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={"财务部,finance@example.com,FINANCE,cc@example.com;cc2@example.com,主要财务收件人\n测序合作组,seq@example.com,SEQ,,"}
              className="h-40 text-sm font-mono"
            />
            {importResult && (
              <div className="rounded-lg border bg-muted/40 p-3 text-xs space-y-1">
                <div>新增 <span className="font-semibold text-emerald-600 dark:text-emerald-400">{importResult.created}</span> 条，跳过 <span className="font-semibold">{importResult.skippedCount}</span> 条。</div>
                {importResult.skipped.length > 0 && (
                  <div className="max-h-40 overflow-auto space-y-0.5 pt-1">
                    {importResult.skipped.map((s, i) => (
                      <div key={i} className="text-muted-foreground">
                        第 {s.line} 行：{s.reason}（{s.raw}）
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => setImportOpen(false)}>关闭</Button>
              <Button size="sm" disabled={!importText.trim() || importMutation.isPending} onClick={() => importMutation.mutate()}>
                {importMutation.isPending ? "导入中…" : "导入"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
