"use client";

import { useState } from "react";
import { Check, X, Loader2, AlertCircle, ArrowRight, Package, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";
import { openEntityResource } from "./open-resource";

interface UpdateDiffItem {
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
}

interface CandidateItem {
  profileId?: string;
  reason?: string | null;
}

/**
 * Format a yuan value as currency.
 */
function formatYuan(yuan: number | undefined | null): string {
  if (yuan == null || Number.isNaN(Number(yuan))) return "¥0.00";
  return `¥${Number(yuan).toFixed(2)}`;
}

function planLabel(plan: string | undefined | null): { label: string; tone: string } {
  if (plan === "CREATE") return { label: "新建订单", tone: "bg-emerald-50 text-emerald-700 border-emerald-200" };
  if (plan === "UPDATE") return { label: "更新订单", tone: "bg-sky-50 text-sky-700 border-sky-200" };
  if (plan === "CONFLICT") return { label: "跨来源冲突", tone: "bg-rose-50 text-rose-700 border-rose-200" };
  return { label: plan || "-", tone: "bg-muted/40 text-muted-foreground border-border/40" };
}

function formatValue(v: unknown): string {
  if (v == null || v === "") return "(空)";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/**
 * Confirm / result card for `orders.import_order_row`.
 *
 * Renders the confirmation summary: row number, externalOrderNo, source,
 * CREATE/UPDATE/CONFLICT badge, customer decision, title, amount, dates,
 * match signals, update diff table, warnings, and remaining count.
 *
 * Also renders `orders.get_import_row` analysis output (read-only, no
 * confirm/reject footer) — the same visual summary without proposal actions.
 */
export function ImportOrderRowCard({
  descriptor,
  proposal,
  proposalBusyId,
  onConfirmProposal,
  onRejectProposal,
  onApplyViewIntent,
  onOpenResource,
}: AgentCardProps) {
  const props = descriptor.props;
  const isSaved = descriptor.state === "saved";
  const isAnalysis = !proposal && descriptor.state !== "pending";

  const rowNo = typeof props.rowNo === "number" ? props.rowNo : null;
  const externalOrderNo =
    (typeof props.externalOrderNo === "string" ? props.externalOrderNo : null)
    || (typeof (props.normalizedFields as Record<string, unknown> | undefined)?.externalOrderNo === "string"
      ? ((props.normalizedFields as Record<string, unknown>).externalOrderNo as string)
      : null);
  const plan =
    (typeof props.plan === "string" ? props.plan : null)
    || (typeof (props.normalizedFields as Record<string, unknown> | undefined)?.plan === "string"
      ? ((props.normalizedFields as Record<string, unknown>).plan as string)
      : null);
  const title =
    (typeof props.title === "string" ? props.title : null)
    || (typeof (props.normalizedFields as Record<string, unknown> | undefined)?.productNamesRaw === "string"
      ? ((props.normalizedFields as Record<string, unknown>).productNamesRaw as string)
      : null);
  const amountYuan = typeof props.amountYuan === "number" ? props.amountYuan : null;
  const orderAt = typeof props.orderAt === "string" ? props.orderAt.slice(0, 10) : null;
  const paidAt = typeof props.paidAt === "string" ? props.paidAt.slice(0, 10) : null;
  const updateDiff = Array.isArray(props.updateDiff) ? (props.updateDiff as UpdateDiffItem[]) : [];
  const candidates = Array.isArray(props.candidates) ? (props.candidates as CandidateItem[]) : [];
  const exactDuplicate =
    props.exactDuplicate && typeof props.exactDuplicate === "object"
      ? (props.exactDuplicate as { orderId?: string; deleted?: boolean })
      : null;
  const crossSourceConflict = Array.isArray(props.crossSourceConflict)
    ? (props.crossSourceConflict as Array<{ orderId?: string; source?: string }>)
    : [];
  const progress =
    props.progress && typeof props.progress === "object"
      ? (props.progress as { unresolved?: number; total?: number; imported?: number })
      : {};
  const missingFields = Array.isArray(props.missingFields) ? (props.missingFields as string[]) : [];
  const decisionType =
    typeof (props.decision as Record<string, unknown> | undefined)?.type === "string"
      ? ((props.decision as Record<string, unknown>).type as string)
      : null;

  const [saving, setSaving] = useState(false);

  async function handleConfirm() {
    if (!proposal) return;
    setSaving(true);
    try {
      await onConfirmProposal(proposal.id);
    } finally {
      setSaving(false);
    }
  }

  const pl = planLabel(plan);
  const remaining = typeof progress.unresolved === "number" ? progress.unresolved : null;

  // ─── 已确认（saved）：紧凑结果 ──────────────────────────────────────────────
  if (isSaved) {
    const order = (props.order ?? {}) as Record<string, unknown>;
    const created = typeof props.created === "boolean" ? props.created : null;
    const orderId =
      (typeof order.id === "string" ? order.id : undefined)
      || (typeof props.finalOrderId === "string" ? props.finalOrderId : undefined);
    const orderNo =
      (typeof order.orderNo === "string" ? order.orderNo : undefined)
      || externalOrderNo
      || undefined;
    const summary = (
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100">
          <Check className="h-5 w-5 text-emerald-600" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {title || orderNo || "导入订单"}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {created ? "新建" : "更新"} · {orderNo || ""}
          </div>
        </div>
      </div>
    );
    return (
      <CardShell title={created ? "订单已创建" : "订单已更新"} state="saved">
        {orderId ? (
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 rounded-xl text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            onClick={() => openEntityResource("order", orderId, "打开订单详情", {
              onOpenResource,
              onApplyViewIntent,
            })}
          >
            {summary}
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />
          </button>
        ) : (
          summary
        )}
      </CardShell>
    );
  }

  const isConflict = plan === "CONFLICT";

  return (
    <CardShell
      title={
        isConflict
          ? "跨来源冲突"
          : `${pl.label}：${externalOrderNo || "导入行"}`
      }
      state={descriptor.state}
      footer={
        isAnalysis ? undefined : (
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1"
              disabled={saving || proposalBusyId === proposal?.id || isConflict}
              onClick={handleConfirm}
            >
              {saving || proposalBusyId === proposal?.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              确认导入
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={saving || proposalBusyId === proposal?.id}
              onClick={() => proposal && onRejectProposal(proposal.id)}
            >
              <X className="h-4 w-4" />
              拒绝
            </Button>
          </div>
        )
      }
    >
      <div className="flex items-start justify-between gap-2 rounded-xl bg-muted/30 px-3 py-2">
        <div className="flex min-w-0 items-start gap-2">
          <Package className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {rowNo != null ? `第 ${rowNo} 行 · ` : ""}
              {externalOrderNo || "(缺外部单号)"}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {title || "（无标题）"}
            </div>
          </div>
        </div>
        <Badge variant="outline" className={`shrink-0 text-[10px] ${pl.tone}`}>
          {pl.label}
        </Badge>
      </div>

      {isConflict ? (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-rose-50/70 px-3 py-2 text-xs text-rose-900">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            该外部单号在其他来源已存在，不能通过普通导入自动更新。请向用户说明冲突，
            或引导走独立的订单合并/来源绑定流程。
            {crossSourceConflict.length > 0 ? `（命中 ${crossSourceConflict.length} 条其他来源订单）` : null}
          </div>
        </div>
      ) : null}

      <div className="mt-3 space-y-2 text-sm">
        {decisionType ? (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/20 px-3 py-1.5">
            <span className="text-[11px] text-muted-foreground">客户决策</span>
            <span className="truncate font-medium">{decisionType}</span>
          </div>
        ) : null}
        {amountYuan != null ? (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/20 px-3 py-1.5">
            <span className="text-[11px] text-muted-foreground">金额</span>
            <span className="tabular-nums font-medium">{formatYuan(amountYuan)}</span>
          </div>
        ) : null}
        {(orderAt || paidAt) ? (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/20 px-3 py-1.5">
            <span className="text-[11px] text-muted-foreground">下单 / 付款</span>
            <span className="text-[12px]">
              {orderAt || "-"} / {paidAt || "-"}
            </span>
          </div>
        ) : null}
      </div>

      {missingFields.length > 0 ? (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50/70 px-3 py-1.5 text-[11px] text-amber-900">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>缺失字段：{missingFields.join("、")}</div>
        </div>
      ) : null}

      {candidates.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">
            客户候选（{candidates.length}）
          </div>
          <div className="space-y-1">
            {candidates.slice(0, 5).map((c, idx) => (
              <div
                key={c.profileId || idx}
                className="flex items-center justify-between gap-2 rounded-lg bg-muted/20 px-3 py-1.5 text-[12px]"
              >
                <span className="truncate font-mono text-[11px]">
                  {c.profileId ? `…${c.profileId.slice(-8)}` : "(无 id)"}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {c.reason || "-"}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {exactDuplicate ? (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-lg bg-sky-50/60 px-3 py-1.5 text-[11px] text-sky-900">
          <span>精确来源命中</span>
          <span className="font-mono">…{String(exactDuplicate.orderId || "").slice(-6)}</span>
        </div>
      ) : null}

      {updateDiff.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">
            更新差异（{updateDiff.length}）
          </div>
          <div className="overflow-hidden rounded-lg border border-border/40">
            <table className="w-full text-[11px]">
              <tbody>
                {updateDiff.slice(0, 6).map((d, idx) => (
                  <tr key={idx} className="border-b border-border/20 last:border-0">
                    <td className="px-2 py-1.5 align-top text-muted-foreground">{d.field || "-"}</td>
                    <td className="px-2 py-1.5 align-top">
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-muted-foreground line-through">{formatValue(d.oldValue)}</span>
                        <ArrowRight className="h-3 w-3 text-muted-foreground" />
                        <span className="font-medium">{formatValue(d.newValue)}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {remaining != null ? (
        <div className="mt-3 flex items-center justify-between rounded-xl bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground">
          <span>剩余待处理</span>
          <span className="font-medium">{remaining} 行</span>
        </div>
      ) : null}
    </CardShell>
  );
}
