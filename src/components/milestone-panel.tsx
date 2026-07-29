"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Pencil, Trash2, Check, RotateCcw, Send, Bell, BellOff, UserPlus, X, Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { toast } from "sonner";

interface MilestoneContact {
  id: string;
  externalContactId: string;
  suppressUntil: string | null;
  name: string;
  email: string;
  department: string | null;
  enabled: boolean;
  archived: boolean;
}

interface Milestone {
  id: string;
  name: string;
  type: string;
  sortOrder: number;
  dueDate: string | null;
  doneAt: string | null;
  completedNotified: boolean;
  note: string | null;
  notifyBeforeHours: number | null;
  nudgeStatus: string | null;
  nudgeLastSentAt: string | null;
  createdAt: string;
  updatedAt: string;
  contacts: MilestoneContact[];
}

interface ContactOption {
  id: string;
  name: string;
  email: string;
  department: string | null;
}

const TYPE_LABELS: Record<string, string> = {
  CUSTOM: "自定义", SAMPLE: "样本", SEQUENCING: "测序", REPORT: "报告",
  DELIVERY: "交付", PAYMENT: "回款", CONTRACT: "合同",
};

const TYPE_OPTIONS = ["CUSTOM", "SAMPLE", "SEQUENCING", "REPORT", "DELIVERY", "PAYMENT", "CONTRACT"];

interface FormState {
  name: string;
  type: string;
  dueDate: string; // datetime-local
  notifyBeforeHours: string;
  note: string;
}

const emptyForm: FormState = { name: "", type: "CUSTOM", dueDate: "", notifyBeforeHours: "", note: "" };

// ISO → datetime-local value (local time, no seconds)
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function milestoneState(m: Milestone): { label: string; variant: "default" | "secondary" | "outline" | "destructive" } {
  if (m.doneAt) return { label: "已完成", variant: "secondary" };
  if (m.dueDate && new Date(m.dueDate).getTime() < Date.now()) return { label: "已逾期", variant: "destructive" };
  return { label: "进行中", variant: "outline" };
}

// 模块级纯工具（避免在组件渲染体内直接调用 Date.now，触发 react-hooks/purity）
function isSuppressedNow(suppressUntil: string | null): boolean {
  return !!suppressUntil && new Date(suppressUntil).getTime() > Date.now();
}

function sevenDaysFromNowISO(): string {
  return new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
}

export function MilestonePanel({
  projectId,
  canManage,
  readOnly,
}: {
  projectId: string;
  canManage: boolean;
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const { confirm } = useConfirm();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Milestone | null>(null);
  const [form, setForm] = useState<FormState>({ ...emptyForm });
  const [contactDialogFor, setContactDialogFor] = useState<Milestone | null>(null);
  const [selectedContactId, setSelectedContactId] = useState<string>("");

  const { data, isLoading } = useQuery<{ milestones: Milestone[] }>({
    queryKey: ["milestones", projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/milestones`);
      if (!res.ok) throw new Error("加载节点失败");
      return res.json();
    },
  });
  const milestones = data?.milestones || [];

  // 收件人选择列表（绑定弹窗打开时才拉取）
  const { data: contactData } = useQuery<{ contacts: ContactOption[] }>({
    queryKey: ["external-contacts", "options"],
    queryFn: async () => {
      const res = await fetch("/api/external-contacts");
      if (!res.ok) throw new Error("加载通讯录失败");
      return res.json();
    },
    enabled: !!contactDialogFor,
  });
  const contactOptions = contactData?.contacts || [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["milestones", projectId] });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const url = editing
        ? `/api/projects/${projectId}/milestones/${editing.id}`
        : `/api/projects/${projectId}/milestones`;
      const method = editing ? "PATCH" : "POST";
      const payload = {
        name: form.name,
        type: form.type,
        dueDate: form.dueDate ? new Date(form.dueDate).toISOString() : null,
        notifyBeforeHours: form.notifyBeforeHours === "" ? null : Number(form.notifyBeforeHours),
        note: form.note,
      };
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "保存失败");
      return d;
    },
    onSuccess: () => {
      toast.success(editing ? "已更新" : "已创建");
      setDialogOpen(false);
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const completeMutation = useMutation({
    mutationFn: async ({ id, done }: { id: string; done: boolean }) => {
      const res = await fetch(`/api/projects/${projectId}/milestones/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ done }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "操作失败");
      return d;
    },
    onSuccess: (_d, v) => {
      toast.success(v.done ? "已标记完成" : "已重新打开");
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/projects/${projectId}/milestones/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "删除失败");
      }
    },
    onSuccess: () => { toast.success("已删除"); invalidate(); },
    onError: (err: Error) => toast.error(err.message),
  });

  const nudgeMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/projects/${projectId}/milestones/${id}/nudge`, { method: "POST" });
      const d = await res.json();
      if (!res.ok && res.status !== 200) throw new Error(d.error || "催办失败");
      return d as { ok: boolean; reason?: string; retryAfterMinutes?: number; recipients?: number; sent?: number; failed?: number };
    },
    onSuccess: (d) => {
      if (d.ok) {
        toast.success(`已催办：发送 ${d.sent}/${d.recipients} 成功`);
        invalidate();
      } else if (d.reason === "RATE_LIMITED") {
        toast.info(`该节点 ${d.retryAfterMinutes} 分钟前刚催办过，请稍后再试`);
      } else if (d.reason === "NO_RECIPIENT") {
        toast.warning("该节点未绑定任何有效收件人");
      } else {
        toast.error("催办失败");
      }
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const bindContactMutation = useMutation({
    mutationFn: async ({ milestoneId, externalContactId }: { milestoneId: string; externalContactId: string }) => {
      const res = await fetch(`/api/projects/${projectId}/milestones/${milestoneId}/contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ externalContactId }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "绑定失败");
      return d;
    },
    onSuccess: () => { toast.success("已绑定收件人"); setSelectedContactId(""); invalidate(); },
    onError: (err: Error) => toast.error(err.message),
  });

  const unbindContactMutation = useMutation({
    mutationFn: async ({ milestoneId, cid }: { milestoneId: string; cid: string }) => {
      const res = await fetch(`/api/projects/${projectId}/milestones/${milestoneId}/contacts/${cid}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "解绑失败");
      }
    },
    onSuccess: () => { toast.success("已解绑"); invalidate(); },
    onError: (err: Error) => toast.error(err.message),
  });

  const suppressMutation = useMutation({
    mutationFn: async ({ milestoneId, cid, suppressUntil }: { milestoneId: string; cid: string; suppressUntil: string | null }) => {
      const res = await fetch(`/api/projects/${projectId}/milestones/${milestoneId}/contacts/${cid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suppressUntil }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "操作失败");
      return d;
    },
    onSuccess: () => { invalidate(); },
    onError: (err: Error) => toast.error(err.message),
  });

  const openCreate = () => {
    setEditing(null);
    setForm({ ...emptyForm });
    setDialogOpen(true);
  };

  const openEdit = (m: Milestone) => {
    setEditing(m);
    setForm({
      name: m.name,
      type: m.type,
      dueDate: toLocalInput(m.dueDate),
      notifyBeforeHours: m.notifyBeforeHours != null ? String(m.notifyBeforeHours) : "",
      note: m.note || "",
    });
    setDialogOpen(true);
  };

  const handleDelete = async (m: Milestone) => {
    const ok = await confirm({
      title: "删除节点",
      description: `确定删除节点「${m.name}」吗？该操作不可撤销。`,
      variant: "destructive",
      confirmText: "删除",
    });
    if (ok) deleteMutation.mutate(m.id);
  };

  const handleSetSuppress = async (m: Milestone, c: MilestoneContact) => {
    if (isSuppressedNow(c.suppressUntil)) {
      suppressMutation.mutate({ milestoneId: m.id, cid: c.id, suppressUntil: null });
      return;
    }
    // 默认静默 7 天
    suppressMutation.mutate({ milestoneId: m.id, cid: c.id, suppressUntil: sevenDaysFromNowISO() });
  };

  if (isLoading) {
    return <div className="text-sm text-muted-foreground py-8 text-center">加载中…</div>;
  }

  return (
    <div className="space-y-4">
      {canManage && !readOnly && (
        <div className="flex justify-end">
          <Button size="sm" onClick={openCreate}>
            <Plus className="mr-1 h-3 w-3" /> 新建节点
          </Button>
        </div>
      )}

      {milestones.length === 0 ? (
        <div className="text-sm text-muted-foreground py-8 text-center">暂无周期节点</div>
      ) : (
        milestones.map((m) => {
          const st = milestoneState(m);
          return (
            <Card key={m.id} className="p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{m.name}</span>
                    <Badge variant="outline" className="text-[10px]">{TYPE_LABELS[m.type] || m.type}</Badge>
                    <Badge variant={st.variant} className="text-[10px]">{st.label}</Badge>
                    {m.completedNotified && (
                      <Badge variant="outline" className="text-[10px] border-success-border text-success" title="该节点逾期后才完成，系统已向催办收件人发送「节点已完成」通知邮件">
                        已发完成通知
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
                    <span>到期: {fmtDateTime(m.dueDate)}</span>
                    {m.notifyBeforeHours != null && <span>提前提醒: {m.notifyBeforeHours}h</span>}
                    {m.doneAt && <span>完成: {fmtDateTime(m.doneAt)}</span>}
                    {m.nudgeLastSentAt && <span>最近催办/通知: {fmtDateTime(m.nudgeLastSentAt)}</span>}
                  </div>
                  {m.note && <div className="text-xs text-muted-foreground whitespace-pre-wrap">{m.note}</div>}
                </div>
                {canManage && !readOnly && (
                  <div className="flex items-center gap-1 shrink-0">
                    {!m.doneAt ? (
                      <Button size="icon" variant="ghost" className="h-7 w-7" title="标记完成"
                        onClick={() => completeMutation.mutate({ id: m.id, done: true })}>
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <Button size="icon" variant="ghost" className="h-7 w-7" title="重新打开"
                        onClick={() => completeMutation.mutate({ id: m.id, done: false })}>
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button size="icon" variant="ghost" className="h-7 w-7" title="编辑" onClick={() => openEdit(m)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" title="删除" onClick={() => handleDelete(m)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>

              {/* 收件人 */}
              <div className="border-t pt-2 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">催办收件人（{m.contacts.length}）</span>
                  <div className="flex items-center gap-1">
                    {!readOnly && !m.doneAt && m.contacts.length > 0 && (
                      <Button size="sm" variant="outline" className="h-7 text-xs"
                        disabled={nudgeMutation.isPending}
                        onClick={() => nudgeMutation.mutate(m.id)}>
                        <Send className="mr-1 h-3 w-3" /> 催办
                      </Button>
                    )}
                    {canManage && !readOnly && (
                      <Button size="sm" variant="ghost" className="h-7 text-xs"
                        onClick={() => { setContactDialogFor(m); setSelectedContactId(""); }}>
                        <UserPlus className="mr-1 h-3 w-3" /> 绑定
                      </Button>
                    )}
                  </div>
                </div>
                {m.contacts.length === 0 ? (
                  <div className="text-xs text-muted-foreground">未绑定收件人，逾期不会自动催办外部部门。</div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {m.contacts.map((c) => {
                      const suppressed = isSuppressedNow(c.suppressUntil);
                      return (
                        <div key={c.id} className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
                          <span className={!c.enabled ? "text-muted-foreground line-through" : ""}>{c.name}</span>
                          {c.department && <span className="text-muted-foreground">({c.department})</span>}
                          {!c.enabled && <Badge variant="outline" className="text-[9px]">已停用</Badge>}
                          {suppressed && (
                            <span className="text-warning flex items-center gap-0.5" title={`静默至 ${fmtDateTime(c.suppressUntil)}`}>
                              <Clock className="h-3 w-3" />静默
                            </span>
                          )}
                          {canManage && !readOnly && (
                            <>
                              <button className="text-muted-foreground hover:text-foreground" title={suppressed ? "取消静默" : "静默 7 天"}
                                onClick={() => handleSetSuppress(m, c)}>
                                {suppressed ? <Bell className="h-3 w-3" /> : <BellOff className="h-3 w-3" />}
                              </button>
                              <button className="text-muted-foreground hover:text-destructive" title="解绑"
                                onClick={() => unbindContactMutation.mutate({ milestoneId: m.id, cid: c.id })}>
                                <X className="h-3 w-3" />
                              </button>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </Card>
          );
        })
      )}

      {/* 新建/编辑节点弹窗 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑节点" : "新建节点"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">节点名称 *</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：样本送检 / 报告交付" className="h-8 text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">类型</Label>
                <Select value={form.type} onValueChange={(v) => v && setForm({ ...form, type: v })}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TYPE_OPTIONS.map((t) => (
                      <SelectItem key={t} value={t}>{TYPE_LABELS[t]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">提前提醒（小时）</Label>
                <Input type="number" min={0} value={form.notifyBeforeHours}
                  onChange={(e) => setForm({ ...form, notifyBeforeHours: e.target.value })}
                  placeholder="留空=不提前" className="h-8 text-sm" />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">到期日</Label>
              <Input type="datetime-local" value={form.dueDate}
                onChange={(e) => setForm({ ...form, dueDate: e.target.value })} className="h-8 text-sm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">备注</Label>
              <Textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="备注说明" className="text-sm min-h-[60px]" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>取消</Button>
              <Button size="sm" disabled={!form.name.trim() || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                {editing ? "保存" : "创建"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 绑定收件人弹窗 */}
      <Dialog open={!!contactDialogFor} onOpenChange={(o) => !o && setContactDialogFor(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>绑定催办收件人</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              从外部通讯录选择收件人。如需新增联系人，请前往「管理后台 → 外部通讯录」。
            </p>
            <div className="space-y-1">
              <Label className="text-xs">联系人</Label>
              <Select value={selectedContactId} onValueChange={(v) => setSelectedContactId(v ?? "")}>
                <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="选择联系人" /></SelectTrigger>
                <SelectContent>
                  {contactOptions
                    .filter((c) => !contactDialogFor?.contacts.some((bound) => bound.externalContactId === c.id))
                    .map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}{c.department ? ` (${c.department})` : ""} — {c.email}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setContactDialogFor(null)}>关闭</Button>
              <Button size="sm" disabled={!selectedContactId || bindContactMutation.isPending}
                onClick={() => contactDialogFor && bindContactMutation.mutate({ milestoneId: contactDialogFor.id, externalContactId: selectedContactId })}>
                绑定
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
