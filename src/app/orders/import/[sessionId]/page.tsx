"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CustomerSelect } from "@/components/customer-select";
import { OrganizationSelect } from "@/components/organization-select";
import { useConfirm } from "@/components/ui/confirm-dialog";

// ─── 类型（与 sessions API 响应对齐） ───────────────────────────────
interface RowPayload {
  buyerName: string | null;
  buyerPhone: string | null;
  buyerWechat: string | null;
  buyerMiniProgramId: string | null;
  buyerCustomerCode: string | null;
  buyerOrgName: string | null;
  buyerAddress: string | null;
  externalOrderNo: string | null;
  title: string | null;
}
interface Candidate { profileId: string; name: string; score: number; reason: string }
interface Suggested { profileId: string; name: string | null; score: number | null; reason: string | null }
interface CreateDraft {
  name?: string; phone?: string | null; wechat?: string | null; miniProgramId?: string | null;
  address?: string | null; organizationId?: string | null; organizationName?: string | null; organizationSiteId?: string | null;
}
interface RowDto {
  id: string;
  rowNo: number;
  reviewStatus: string;
  payload: RowPayload;
  suggested: Suggested | null;
  candidates: Candidate[];
  decisionType: string | null;
  confirmedProfileId: string | null;
  confirmedCustomerName: string | null;
  createCustomerDraft: CreateDraft | null;
  finalOrderId: string | null;
  finalError: string | null;
}
interface Summary {
  rowCount: number; pending: number; autoSuggested: number; ambiguous: number; noMatch: number;
  representativeMissing: number; parseFailed: number; confirmed: number; imported: number; dropped: number;
  failed: number; unresolved: number;
}
interface SessionMeta {
  id: string; source: string; sourceRemark: string | null; category: string; status: string;
  fileName: string | null; createdAt: string;
}
interface SessionResponse {
  session: SessionMeta;
  summary: Summary;
  rows: RowDto[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

const STATUS_LABEL: Record<string, string> = {
  PARSE_FAILED: "解析失败",
  DROPPED: "已剔除",
  PENDING: "待处理",
  AUTO_SUGGESTED: "自动建议",
  AMBIGUOUS: "歧义",
  NO_MATCH: "未匹配",
  REPRESENTATIVE_MISSING: "缺代表",
  CONFIRMED_EXISTING: "已确认（现有）",
  CONFIRMED_CREATE: "已确认（新建）",
  IMPORTED: "已导入",
  FAILED: "失败",
};
function statusVariant(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "CONFIRMED_EXISTING" || s === "CONFIRMED_CREATE" || s === "IMPORTED") return "default";
  if (s === "AUTO_SUGGESTED") return "secondary";
  if (s === "PARSE_FAILED" || s === "FAILED" || s === "REPRESENTATIVE_MISSING") return "destructive";
  return "outline";
}

const FILTERS = [
  { value: "ALL", label: "全部" },
  { value: "AUTO_SUGGESTED", label: "自动建议" },
  { value: "AMBIGUOUS", label: "歧义" },
  { value: "NO_MATCH", label: "未匹配" },
  { value: "CONFIRMED", label: "已确认" },
  { value: "PROBLEM", label: "问题行" },
] as const;

export default function ImportConfirmPage() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;
  const router = useRouter();
  const { data: auth, status } = useSession();
  const { confirm, prompt } = useConfirm();

  const [filter, setFilter] = useState<string>("ALL");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  // 本地剔除集合：rowId -> reason（commit 时一并提交）。
  const [dropped, setDropped] = useState<Record<string, string>>({});

  // 数据获取走 React Query（与 dashboard/advances 等页一致）：queryKey 含 filter/page，
  // 切 filter/翻页自动重取；refetch() 用于行级操作后的手动刷新。这样取数不在 effect 里同步 setState，
  // 从根上避免 react-hooks/set-state-in-effect。
  const { data, isLoading: loading, refetch } = useQuery<SessionResponse>({
    queryKey: ["import-session", sessionId, filter, page],
    queryFn: async () => {
      const res = await fetch(`/api/orders/import/sessions/${sessionId}?reviewStatus=${filter}&page=${page}&pageSize=20`);
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error || "加载失败");
        throw new Error(d.error || "加载失败");
      }
      return d as SessionResponse;
    },
    enabled: status === "authenticated",
  });

  // 仅在未认证时跳转登录（无 setState，不触发 set-state-in-effect）。
  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  const summary = data?.summary;
  const isTerminal = useMemo(
    () => !!data && ["COMMITTED", "ABORTED", "FAILED"].includes(data.session.status),
    [data],
  );

  if (status !== "authenticated" || auth?.user.role !== "ADMIN") {
    return (
      <PageShell>
        <PageHeader title="订单导入确认" backHref="/orders/import" />
        <Card><CardContent className="py-10 text-center text-muted-foreground">需要管理员权限</CardContent></Card>
      </PageShell>
    );
  }

  // ── 行级决策 API ──
  async function patchRow(rowId: string, body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch(`/api/orders/import/sessions/${sessionId}/rows/${rowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) { toast.error(d.error || "保存失败"); return false; }
      await refetch();
      return true;
    } catch {
      toast.error("保存失败");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function batchAccept() {
    setBusy(true);
    try {
      const res = await fetch(`/api/orders/import/sessions/${sessionId}/rows/batch-accept`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) { toast.error(d.error || "操作失败"); return; }
      toast.success(`已采纳 ${d.accepted} 条高置信建议`);
      await refetch();
    } finally {
      setBusy(false);
    }
  }

  async function recompute() {
    setBusy(true);
    try {
      const res = await fetch(`/api/orders/import/sessions/${sessionId}/recompute`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) { toast.error(d.error || "操作失败"); return; }
      toast.success(`已重新匹配 ${d.recomputed} 条待确认行`);
      await refetch();
    } finally {
      setBusy(false);
    }
  }

  async function abortSession() {
    const ok = await confirm({ title: "取消导入会话", description: "取消后该批数据不会导入，且无法恢复。", variant: "destructive", confirmText: "取消会话" });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/orders/import/sessions/${sessionId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "ABORTED" }),
      });
      const d = await res.json();
      if (!res.ok) { toast.error(d.error || "操作失败"); return; }
      toast.success("会话已取消");
      router.push("/orders/import");
    } finally {
      setBusy(false);
    }
  }

  async function toggleDrop(row: RowDto) {
    if (dropped[row.id]) {
      setDropped((m) => { const n = { ...m }; delete n[row.id]; return n; });
      return;
    }
    const reason = await prompt({ title: "剔除该行", description: "请填写剔除原因（必填，记入导入报告）。", confirmText: "剔除" });
    if (!reason?.trim()) return;
    setDropped((m) => ({ ...m, [row.id]: reason.trim() }));
  }

  async function commit() {
    if (!summary) return;
    const droppedRowIds = Object.keys(dropped);
    // 阻塞行 = 未确认行总数 - 本地已标记剔除的数量（粗校验，服务端再权威校验 §9.1）。
    const blocking = Math.max(0, summary.unresolved - droppedRowIds.length);
    const ok = await confirm({
      title: "确认导入",
      description: `将导入 ${summary.confirmed} 条已确认订单，剔除 ${droppedRowIds.length} 条。${blocking > 0 ? `仍有约 ${blocking} 条未确认/未剔除，可能被服务端拒绝。` : ""}`,
      confirmText: "开始导入",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/orders/import/sessions/${sessionId}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ droppedRowIds, dropReasons: dropped }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error || "导入失败", { description: d.detail || undefined, duration: 8000 });
        await refetch();
        return;
      }
      toast.success(`导入完成：成功 ${d.imported ?? 0} 条，剔除 ${d.dropped ?? 0} 条`);
      await refetch();
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell>
      <PageHeader
        title="订单导入确认"
        description={data ? `来源 ${data.session.source}${data.session.fileName ? ` · ${data.session.fileName}` : ""} · 状态 ${data.session.status}` : "加载中…"}
        backHref="/orders/import"
        actions={
          !isTerminal ? (
            <div className="flex gap-2">
              <Button variant="outline" onClick={recompute} disabled={busy}>重新匹配</Button>
              <Button variant="outline" onClick={batchAccept} disabled={busy}>接受全部高置信建议</Button>
              <Button variant="outline" onClick={abortSession} disabled={busy}>取消会话</Button>
              <Button onClick={commit} disabled={busy}>确认导入</Button>
            </div>
          ) : undefined
        }
      />

      {summary && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          <SummaryStat label="总行数" value={summary.rowCount} />
          <SummaryStat label="自动建议" value={summary.autoSuggested} />
          <SummaryStat label="歧义" value={summary.ambiguous} />
          <SummaryStat label="未匹配" value={summary.noMatch} />
          <SummaryStat label="已确认" value={summary.confirmed} tone="ok" />
          <SummaryStat label="待处理" value={summary.unresolved} tone={summary.unresolved > 0 ? "warn" : "ok"} />
        </div>
      )}

      <Tabs value={filter} onValueChange={(v) => { setFilter(v); setPage(1); }}>
        <TabsList>
          {FILTERS.map((f) => <TabsTrigger key={f.value} value={f.value}>{f.label}</TabsTrigger>)}
        </TabsList>
        <TabsContent value={filter} className="mt-4 space-y-3">
          {loading && <Card><CardContent className="py-8 text-center text-muted-foreground">加载中…</CardContent></Card>}
          {!loading && data && data.rows.length === 0 && (
            <Card><CardContent className="py-8 text-center text-muted-foreground">该筛选下没有行</CardContent></Card>
          )}
          {!loading && data?.rows.map((row) => (
            <RowEditor
              key={row.id}
              row={row}
              disabled={busy || isTerminal}
              droppedReason={dropped[row.id]}
              onPatch={patchRow}
              onToggleDrop={() => toggleDrop(row)}
            />
          ))}

          {data && data.totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 pt-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</Button>
              <span className="text-sm text-muted-foreground">{page} / {data.totalPages}</span>
              <Button variant="outline" size="sm" disabled={page >= data.totalPages} onClick={() => setPage((p) => p + 1)}>下一页</Button>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}

function SummaryStat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" }) {
  const color = tone === "warn" ? "text-amber-600" : tone === "ok" ? "text-emerald-600" : "text-foreground";
  return (
    <Card size="sm">
      <CardContent className="py-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`text-xl font-semibold ${color}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

// ─── 单行决策编辑器 ───────────────────────────────────────────────
function RowEditor({
  row, disabled, droppedReason, onPatch, onToggleDrop,
}: {
  row: RowDto;
  disabled: boolean;
  droppedReason?: string;
  onPatch: (rowId: string, body: Record<string, unknown>) => Promise<boolean>;
  onToggleDrop: () => void;
}) {
  const p = row.payload;
  const isConfirmed = row.reviewStatus === "CONFIRMED_EXISTING" || row.reviewStatus === "CONFIRMED_CREATE";
  const [mode, setMode] = useState<"none" | "pick" | "create">("none");

  // 改选现有客户
  const [pickId, setPickId] = useState("");
  const [pickName, setPickName] = useState("");
  // 新建客户草稿
  const [draft, setDraft] = useState<CreateDraft>(() => ({
    name: p.buyerName ?? "",
    phone: p.buyerPhone ?? "",
    // 不再预填 wechat：buyerWechat 来自订单"下单用户"（orderUser），
    // 在拼好鼠/代下单场景是店铺下单账号（如"陈亮(id:270949)"），不是收件人客户微信。
    // 预填会把无关字符串当作客户唯一身份，触发 commit 阶段 wechat 强去重错绑（见 B1/B2）。
    wechat: "",
    miniProgramId: p.buyerMiniProgramId ?? "",
    address: p.buyerAddress ?? "",
    organizationId: "",
    organizationName: "",
  }));
  const [orgDisplay, setOrgDisplay] = useState("");

  return (
    <Card className={droppedReason ? "opacity-60 border-dashed" : undefined}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            #{row.rowNo + 1} · {p.buyerName || "（无姓名）"}
            {p.externalOrderNo && <span className="ml-2 font-normal text-muted-foreground">单号 {p.externalOrderNo}</span>}
          </CardTitle>
          <Badge variant={droppedReason ? "outline" : statusVariant(row.reviewStatus)}>
            {droppedReason ? "已剔除" : (STATUS_LABEL[row.reviewStatus] ?? row.reviewStatus)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {/* 买方信息 */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-3">
          {p.buyerPhone && <div>电话：{p.buyerPhone}</div>}
          {p.buyerWechat && <div className="text-muted-foreground/70">下单用户：{p.buyerWechat}</div>}
          {p.buyerMiniProgramId && <div>小程序ID：{p.buyerMiniProgramId}</div>}
          {p.buyerCustomerCode && <div>客户编号：{p.buyerCustomerCode}</div>}
          {p.buyerOrgName && <div>门店：{p.buyerOrgName}</div>}
          {p.buyerAddress && <div className="col-span-2 sm:col-span-3">地址：{p.buyerAddress}</div>}
          {p.title && <div className="col-span-2 sm:col-span-3">商品：{p.title}</div>}
        </div>

        {row.finalError && <div className="rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">{row.finalError}</div>}
        {droppedReason && <div className="text-xs text-muted-foreground">剔除原因：{droppedReason}</div>}

        {/* 已确认态 */}
        {isConfirmed && !droppedReason && (
          <div className="flex items-center justify-between rounded bg-emerald-50 px-3 py-2">
            <div className="text-sm">
              {row.reviewStatus === "CONFIRMED_EXISTING"
                ? <>已绑定客户：<b>{row.confirmedCustomerName ?? row.confirmedProfileId}</b></>
                : <>将新建客户：<b>{row.createCustomerDraft?.name}</b>{row.createCustomerDraft?.organizationName ? `（${row.createCustomerDraft.organizationName}）` : ""}</>}
            </div>
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onPatch(row.id, { decisionType: "RESET" })}>撤销</Button>
          </div>
        )}

        {/* 自动建议态：快速采纳 */}
        {row.reviewStatus === "AUTO_SUGGESTED" && row.suggested && !droppedReason && (
          <div className="flex items-center justify-between rounded bg-secondary/40 px-3 py-2">
            <div className="text-sm">
              建议绑定：<b>{row.suggested.name ?? row.suggested.profileId}</b>
              {row.suggested.score != null && <span className="ml-2 text-xs text-muted-foreground">置信 {row.suggested.score}</span>}
              {row.suggested.reason && <span className="ml-2 text-xs text-muted-foreground">{row.suggested.reason}</span>}
            </div>
            <Button size="sm" disabled={disabled} onClick={() => onPatch(row.id, { decisionType: "USE_SUGGESTION" })}>采纳</Button>
          </div>
        )}

        {/* 候选列表（歧义/未匹配/待处理） */}
        {!isConfirmed && !droppedReason && row.candidates.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">候选客户：</div>
            {row.candidates.slice(0, 5).map((c) => (
              <div key={c.profileId} className="flex items-center justify-between rounded border px-2 py-1">
                <div className="text-sm">{c.name}<span className="ml-2 text-xs text-muted-foreground">{c.score} · {c.reason}</span></div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => {
                    onPatch(row.id, { decisionType: "PICK_EXISTING", confirmedProfileId: c.profileId });
                  }}
                >选择</Button>
              </div>
            ))}
          </div>
        )}

        {/* 决策操作区 */}
        {!isConfirmed && !droppedReason && row.reviewStatus !== "PARSE_FAILED" && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant={mode === "pick" ? "default" : "outline"} disabled={disabled} onClick={() => setMode(mode === "pick" ? "none" : "pick")}>改选现有客户</Button>
              <Button size="sm" variant={mode === "create" ? "default" : "outline"} disabled={disabled} onClick={() => setMode(mode === "create" ? "none" : "create")}>新建客户</Button>
              <Button size="sm" variant="ghost" disabled={disabled} onClick={onToggleDrop}>剔除该行</Button>
            </div>

            {mode === "pick" && (
              <div className="flex items-center gap-2">
                <div className="flex-1"><CustomerSelect value={pickId} displayValue={pickName || undefined} onChange={(id, name) => { setPickId(id || ""); setPickName(name || ""); }} /></div>
                <Button size="sm" disabled={disabled || !pickId} onClick={async () => { if (await onPatch(row.id, { decisionType: "PICK_EXISTING", confirmedProfileId: pickId })) { setMode("none"); setPickName(""); } }}>确认</Button>
              </div>
            )}

            {mode === "create" && (
              <div className="space-y-2 rounded border p-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Input placeholder="客户名*" value={draft.name ?? ""} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
                  <Input placeholder="电话" value={draft.phone ?? ""} onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))} />
                  <Input placeholder="微信" value={draft.wechat ?? ""} onChange={(e) => setDraft((d) => ({ ...d, wechat: e.target.value }))} />
                  <Input placeholder="小程序ID" value={draft.miniProgramId ?? ""} onChange={(e) => setDraft((d) => ({ ...d, miniProgramId: e.target.value }))} />
                  <Input placeholder="地址" className="sm:col-span-2" value={draft.address ?? ""} onChange={(e) => setDraft((d) => ({ ...d, address: e.target.value }))} />
                </div>
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">机构*（新建客户必须归属机构）</div>
                  <OrganizationSelect value={draft.organizationId || ""} displayValue={orgDisplay}
                    onChange={(id, canonicalName) => { setDraft((d) => ({ ...d, organizationId: id || "", organizationName: canonicalName || "" })); setOrgDisplay(canonicalName || ""); }} />
                </div>
                <div className="flex justify-end">
                  <Button size="sm" disabled={disabled || !draft.name?.trim() || (!draft.organizationId && !draft.organizationName?.trim())}
                    onClick={async () => { if (await onPatch(row.id, { decisionType: "CREATE_NEW", createCustomerDraft: draft })) setMode("none"); }}>
                    确认新建
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 解析失败行：只能剔除 */}
        {row.reviewStatus === "PARSE_FAILED" && !droppedReason && (
          <Button size="sm" variant="ghost" disabled={disabled} onClick={onToggleDrop}>剔除该行</Button>
        )}

        {droppedReason && (
          <Button size="sm" variant="ghost" disabled={disabled} onClick={onToggleDrop}>撤销剔除</Button>
        )}
      </CardContent>
    </Card>
  );
}
