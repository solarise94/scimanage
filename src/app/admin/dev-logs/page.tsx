"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Search, Plus, Pencil, Send, Archive,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectDisplay, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";

interface DevLogItem {
  id: string;
  version: string | null;
  title: string;
  content: string;
  status: string;
  type: string;
  publishedAt: string | null;
  createdAt: string;
  createdBy: { id: string; name: string };
}

const typeLabels: Record<string, string> = {
  UPDATE: "更新",
  FIX: "修复",
  RELEASE: "发版",
  NOTICE: "公告",
};

export default function DevLogsPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data: session, status: authStatus } = useSession();
  const [statusFilter, setStatusFilter] = useState("ALL");
  const DEVLOG_STATUS_LABELS: Record<string, string> = { ALL: "全部", DRAFT: "草稿", PUBLISHED: "已发布", ARCHIVED: "已归档" };
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [activeLog, setActiveLog] = useState<DevLogItem | null>(null);
  const [form, setForm] = useState({ title: "", content: "", version: "", type: "UPDATE" });

  const { data, isLoading, error } = useQuery<{ logs: DevLogItem[] }>({
    queryKey: ["dev-logs", statusFilter, search],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      if (search) params.set("search", search);
      const res = await fetch(`/api/dev-logs?${params}`);
      if (res.status === 403) throw new Error("无权访问");
      if (!res.ok) throw new Error("加载失败");
      return res.json();
    },
    enabled: authStatus === "authenticated" && session?.user?.role === "ADMIN",
  });

  useEffect(() => {
    if (authStatus === "authenticated" && session?.user?.role !== "ADMIN") {
      router.push("/dashboard");
    }
    if (error?.message === "无权访问") {
      router.push("/dashboard");
    }
  }, [authStatus, session, error, router]);

  const createMutation = useMutation({
    mutationFn: async (payload: typeof form) => {
      const res = await fetch("/api/dev-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "创建失败");
      return data;
    },
    onSuccess: () => {
      toast.success("日志已创建");
      setCreateOpen(false);
      setForm({ title: "", content: "", version: "", type: "UPDATE" });
      queryClient.invalidateQueries({ queryKey: ["dev-logs"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, ...body }: { id: string } & Record<string, unknown>) => {
      const res = await fetch(`/api/dev-logs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "更新失败");
      return data;
    },
    onSuccess: () => {
      toast.success("已更新");
      setEditOpen(false);
      setActiveLog(null);
      queryClient.invalidateQueries({ queryKey: ["dev-logs"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (authStatus === "loading") return null;
  if (!session || session.user.role !== "ADMIN") return null;
  if (error?.message === "无权访问") return null;

  const logs = data?.logs || [];

  return (
    <PageShell>
      <PageHeader
        title="开发日志"
        description="系统更新说明"
        actions={
          <Button onClick={() => { setForm({ title: "", content: "", version: "", type: "UPDATE" }); setCreateOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" />新建
          </Button>
        }
      />

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="搜索..." className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v || "ALL")}>
          <SelectTrigger className="w-28"><SelectDisplay label="状态" valueLabel={DEVLOG_STATUS_LABELS[statusFilter] || "未知"} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">全部</SelectItem>
            <SelectItem value="DRAFT">草稿</SelectItem>
            <SelectItem value="PUBLISHED">已发布</SelectItem>
            <SelectItem value="ARCHIVED">已归档</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : logs.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center">
          <p className="text-muted-foreground">暂无日志</p>
        </div>
      ) : (
        <div className="space-y-3">
          {logs.map((log) => (
            <div key={log.id} className="rounded-lg border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{log.title}</span>
                    {log.version && <Badge variant="outline" className="text-xs">{log.version}</Badge>}
                    <Badge variant="secondary" className="text-xs">{typeLabels[log.type] || log.type}</Badge>
                    {log.status === "DRAFT" && <Badge className="text-xs bg-amber-500">草稿</Badge>}
                    {log.status === "PUBLISHED" && <Badge className="text-xs bg-green-600">已发布</Badge>}
                    {log.status === "ARCHIVED" && <Badge variant="outline" className="text-xs">已归档</Badge>}
                  </div>
                  <p className="text-sm text-muted-foreground">{log.content}</p>
                  <div className="text-xs text-muted-foreground">
                    {log.createdBy.name}
                    {log.publishedAt && ` · 发布于 ${new Date(log.publishedAt).toLocaleString("zh-CN")}`}
                    {!log.publishedAt && ` · ${new Date(log.createdAt).toLocaleString("zh-CN")}`}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="sm" variant="ghost" onClick={() => {
                    setActiveLog(log);
                    setForm({ title: log.title, content: log.content, version: log.version || "", type: log.type });
                    setEditOpen(true);
                  }}>
                    <Pencil className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>新建日志</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>标题 *</Label>
                <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>版本号</Label>
                <Input value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} placeholder="如 v1.2.0" />
              </div>
            </div>
            <div className="space-y-2">
              <Label>类型</Label>
              <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v || "UPDATE" })}>
                <SelectTrigger>
                  <SelectValue>{{ UPDATE: "更新", FIX: "修复", RELEASE: "发版", NOTICE: "公告" }[form.type] || form.type}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="UPDATE">更新</SelectItem>
                  <SelectItem value="FIX">修复</SelectItem>
                  <SelectItem value="RELEASE">发版</SelectItem>
                  <SelectItem value="NOTICE">公告</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>内容 *</Label>
              <Textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} rows={3} placeholder="简要说明更新内容" />
            </div>
            <Button className="w-full" disabled={!form.title.trim() || !form.content.trim() || createMutation.isPending}
              onClick={() => createMutation.mutate(form)}>
              {createMutation.isPending ? "创建中..." : "创建草稿"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>编辑日志</DialogTitle></DialogHeader>
          {activeLog && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>标题</Label>
                  <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>版本号</Label>
                  <Input value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>类型</Label>
                <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v || "UPDATE" })}>
                  <SelectTrigger>
                    <SelectValue>{{ UPDATE: "更新", FIX: "修复", RELEASE: "发版", NOTICE: "公告" }[form.type] || form.type}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="UPDATE">更新</SelectItem>
                    <SelectItem value="FIX">修复</SelectItem>
                    <SelectItem value="RELEASE">发版</SelectItem>
                    <SelectItem value="NOTICE">公告</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>内容</Label>
                <Textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} rows={3} />
              </div>
              <div className="flex gap-2">
                <Button className="flex-1" disabled={!form.title.trim() || !form.content.trim() || updateMutation.isPending}
                  onClick={() => updateMutation.mutate({ id: activeLog.id, title: form.title, content: form.content, version: form.version, type: form.type })}>
                  保存
                </Button>
                {activeLog.status === "DRAFT" && (
                  <Button variant="outline" disabled={!form.title.trim() || !form.content.trim() || updateMutation.isPending}
                    onClick={() => updateMutation.mutate({ id: activeLog.id, title: form.title, content: form.content, version: form.version, type: form.type, status: "PUBLISHED" })}>
                    <Send className="h-3 w-3 mr-1" />发布
                  </Button>
                )}
                {activeLog.status === "PUBLISHED" && (
                  <Button variant="outline" disabled={updateMutation.isPending}
                    onClick={() => updateMutation.mutate({ id: activeLog.id, status: "ARCHIVED" })}>
                    <Archive className="h-3 w-3 mr-1" />归档
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}