"use client";

import { useState } from "react";
import { Check, X, Loader2, Pencil, Receipt, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";
import { ENTITY_ROW_BUTTON_CLASS, openEntityResource } from "./open-resource";

function formatYuan(cents: number | undefined | null): string {
  if (cents == null || Number.isNaN(Number(cents))) return "¥0.00";
  return `¥${(Number(cents) / 100).toFixed(2)}`;
}

function yuanToCents(yuan: string): number {
  const n = Number(yuan);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

type EditableItem = {
  itemName: string;
  amountCents: number;
  spec?: string | null;
  unit?: string | null;
  quantity?: number | null;
};

/**
 * 将明细金额同步到 coverage 合计（最大余数法 / Hamilton）。
 * - 单行：直接等于合计
 * - 多行：先保证每行至少 1 分，再按原金额比例分摊剩余；无法保证每行 ≥1 分时返回错误
 * - 合计精确等于 coverageTotal，不会出现末行 0/负数
 */
function syncItemsToCoverageTotal(
  items: EditableItem[],
  coverageTotal: number,
): { ok: true; items: EditableItem[] } | { ok: false; error: string } {
  if (items.length === 0) return { ok: true, items };
  if (coverageTotal <= 0) {
    return { ok: false, error: "分摊合计必须大于 0" };
  }
  if (items.length === 1) {
    return { ok: true, items: [{ ...items[0], amountCents: coverageTotal }] };
  }
  if (coverageTotal < items.length) {
    return {
      ok: false,
      error: `分摊合计仅 ${(coverageTotal / 100).toFixed(2)} 元（${coverageTotal} 分），不足以让 ${items.length} 行明细每行至少 1 分。请增大金额或合并明细后再编辑。`,
    };
  }

  const oldTotal = items.reduce((s, it) => s + Math.max(0, it.amountCents), 0);
  // 已精确匹配且每行正数：无需重分摊
  if (oldTotal === coverageTotal && items.every((it) => it.amountCents > 0)) {
    return { ok: true, items };
  }

  const reserve = items.length; // 每行预留 1 分
  const distributable = coverageTotal - reserve;
  const rawWeights = oldTotal > 0
    ? items.map((it) => Math.max(0, it.amountCents))
    : items.map(() => 1);
  const weightSum = rawWeights.reduce((s, w) => s + w, 0) || items.length;

  const exact = rawWeights.map((w) => (w / weightSum) * distributable);
  const floors = exact.map((x) => Math.floor(x));
  const rem = distributable - floors.reduce((s, x) => s + x, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const amounts = floors.map((f) => f + 1); // +1 预留
  for (let k = 0; k < rem; k++) {
    amounts[order[k].i] += 1;
  }

  return {
    ok: true,
    items: items.map((it, i) => ({ ...it, amountCents: amounts[i] })),
  };
}

function invoiceTypeLabel(type: string | undefined | null): string {
  if (type === "SPECIAL") return "专票";
  if (type === "NORMAL") return "普票";
  return type || "-";
}

/**
 * Confirm card for `finance.submit_invoice_request`.
 * Shows coverage, amounts, buyer/seller, and confirm/reject/edit buttons.
 * Edit mode allows adjusting coverage amounts, invoice type, content summary.
 */
export function SubmitInvoiceRequestCard({
  descriptor,
  proposal,
  proposalBusyId,
  onConfirmProposal,
  onRejectProposal,
  onUpdateProposal,
  onApplyViewIntent,
  onOpenResource,
}: AgentCardProps) {
  const isSaved = descriptor.state === "saved";
  const props = descriptor.props;
  const handlers = { onOpenResource, onApplyViewIntent };

  const projectName = typeof props.projectName === "string" ? props.projectName : null;
  const mainOrderNo = typeof props.mainOrderNo === "string" ? props.mainOrderNo : null;
  const buyerOrganizationName = typeof props.buyerOrganizationName === "string" ? props.buyerOrganizationName : "未知购方";
  const sellerName = typeof props.sellerName === "string" ? props.sellerName : "待定";
  const invoiceType = typeof props.invoiceType === "string" ? props.invoiceType : null;
  const totalAmountCents = typeof props.totalAmountCents === "number" ? props.totalAmountCents : 0;
  const contentSummary = typeof props.contentSummary === "string" ? props.contentSummary : null;

  const coverageDetails = Array.isArray(props.coverageDetails)
    ? (props.coverageDetails as Array<{ orderId: string; amountCents: number }>)
    : [];
  const items = Array.isArray(props.items)
    ? (props.items as Array<{ itemName: string; amountCents: number; spec?: string | null; unit?: string | null; quantity?: number | null }>)
    : [];
  const orderLabels = Array.isArray(props.orderLabels)
    ? props.orderLabels.filter((x): x is string => typeof x === "string")
    : [];

  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  // Edit form state — 进入编辑时从最新 proposal.input / props 重新初始化，避免二次编辑回滚
  const [editCoverage, setEditCoverage] = useState<Record<string, string>>({});
  const [editInvoiceType, setEditInvoiceType] = useState<string>("NORMAL");
  const [editContentSummary, setEditContentSummary] = useState<string>("");

  function beginEdit() {
    const currentInput = (proposal?.input ?? {}) as Record<string, unknown>;
    const covSource = Array.isArray(currentInput.coverageAllocations)
      ? (currentInput.coverageAllocations as Array<{ orderId: string; amountCents: number }>)
      : Array.isArray(currentInput.coverageDetails)
        ? (currentInput.coverageDetails as Array<{ orderId: string; amountCents: number }>)
        : coverageDetails;
    setEditCoverage(
      Object.fromEntries(covSource.map((c) => [c.orderId, (c.amountCents / 100).toFixed(2)])),
    );
    const nextType =
      typeof currentInput.invoiceType === "string"
        ? currentInput.invoiceType
        : invoiceType;
    setEditInvoiceType(nextType === "SPECIAL" ? "SPECIAL" : "NORMAL");
    const nextSummary =
      typeof currentInput.contentSummary === "string"
        ? currentInput.contentSummary
        : contentSummary;
    setEditContentSummary(nextSummary || "");
    setEditError(null);
    setEditing(true);
  }

  async function handleConfirm() {
    if (!proposal) return;
    setSaving(true);
    try {
      await onConfirmProposal(proposal.id);
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveEdit() {
    if (!proposal) return;
    setSaving(true);
    setEditError(null);
    try {
      // Build updated input from current proposal input + edited fields
      const currentInput = (proposal.input ?? {}) as Record<string, unknown>;
      const updatedCoverage = (Array.isArray(currentInput.coverageAllocations)
        ? (currentInput.coverageAllocations as Array<{ orderId: string; amountCents: number }>)
        : coverageDetails
      ).map((c) => ({
        orderId: c.orderId,
        amountCents: Math.max(0, yuanToCents(editCoverage[c.orderId] ?? "0")),
      }));
      const coverageTotal = updatedCoverage.reduce((s, c) => s + c.amountCents, 0);
      if (coverageTotal <= 0) {
        setEditError("覆盖订单分摊合计必须大于 0");
        return;
      }
      if (updatedCoverage.some((c) => c.amountCents <= 0)) {
        setEditError("每笔覆盖订单分摊金额必须大于 0");
        return;
      }
      // 多明细按最大余数法同步金额，保证 items 合计 = coverage 合计且每行 ≥1 分
      const currentItems: EditableItem[] = Array.isArray(currentInput.items)
        ? (currentInput.items as EditableItem[])
        : items;
      const synced = syncItemsToCoverageTotal(currentItems, coverageTotal);
      if (!synced.ok) {
        setEditError(synced.error);
        return;
      }

      await onUpdateProposal(proposal.id, {
        ...currentInput,
        coverageAllocations: updatedCoverage,
        invoiceType: editInvoiceType,
        contentSummary: editContentSummary.trim() || null,
        items: synced.items,
      });
      setEditing(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  if (isSaved) {
    const invoice = (props.invoice ?? {}) as Record<string, unknown>;
    const invoiceId = typeof invoice.id === "string" ? invoice.id : undefined;
    const summary = (
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100">
          <Check className="h-5 w-5 text-emerald-600" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium">{buyerOrganizationName} · {formatYuan(totalAmountCents)}</div>
          <div className="text-[11px] text-muted-foreground">
            {invoiceTypeLabel(invoiceType)} · 状态：待开票（REQUESTED）
          </div>
        </div>
      </div>
    );
    return (
      <CardShell title="开票申请已提交" state="saved">
        {invoiceId ? (
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 rounded-xl text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            onClick={() => openEntityResource("invoice", invoiceId, "打开发票详情", handlers)}
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

  return (
    <CardShell
      title="提交开票申请"
      state={descriptor.state}
      footer={
        <div className="flex gap-2">
          {editing ? (
            <>
              <Button
                size="sm"
                className="flex-1"
                disabled={saving}
                onClick={handleSaveEdit}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                保存修改
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setEditError(null);
                }}
              >
                取消
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                className="flex-1"
                disabled={saving || proposalBusyId === proposal?.id}
                onClick={handleConfirm}
              >
                {saving || proposalBusyId === proposal?.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                确认创建本张
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={saving || proposalBusyId === proposal?.id}
                onClick={beginEdit}
              >
                <Pencil className="h-4 w-4" />
                编辑
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={saving || proposalBusyId === proposal?.id}
                onClick={() => proposal && onRejectProposal(proposal.id)}
              >
                <X className="h-4 w-4" />
                暂不创建
              </Button>
            </>
          )}
        </div>
      }
    >
      {/* Header: project + order */}
      <div className="flex items-center gap-3 rounded-xl bg-muted/30 px-3 py-2">
        <Receipt className="h-5 w-5 text-muted-foreground" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {projectName ? `${projectName} · ` : ""}{mainOrderNo || "订单开票"}
          </div>
          <div className="text-[11px] text-muted-foreground">
            确认后直接提交为待开票（REQUESTED）
          </div>
        </div>
      </div>

      {/* Key fields */}
      <div className="mt-3 space-y-2 text-sm">
        <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/20 px-3 py-1.5">
          <span className="text-[11px] text-muted-foreground">购方</span>
          <span className="truncate font-medium">{buyerOrganizationName}</span>
        </div>
        <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/20 px-3 py-1.5">
          <span className="text-[11px] text-muted-foreground">销方</span>
          <span className="truncate font-medium">{sellerName}</span>
        </div>
        <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/20 px-3 py-1.5">
          <span className="text-[11px] text-muted-foreground">票种 / 金额</span>
          <span className="tabular-nums font-semibold">
            {editing ? (
              <select
                className="rounded border border-border bg-background px-1.5 py-0.5 text-xs"
                value={editInvoiceType}
                onChange={(e) => setEditInvoiceType(e.target.value)}
              >
                <option value="NORMAL">普票</option>
                <option value="SPECIAL">专票</option>
              </select>
            ) : invoiceTypeLabel(invoiceType)}
            {" · "}
            {formatYuan(editing
              ? coverageDetails.reduce((s, c) => s + Math.max(0, yuanToCents(editCoverage[c.orderId] ?? "0")), 0)
              : totalAmountCents)}
          </span>
        </div>
        {editing ? (
          <div className="rounded-lg bg-muted/20 px-3 py-2">
            <label className="mb-1 block text-[11px] text-muted-foreground">开票内容</label>
            <Input
              value={editContentSummary}
              onChange={(e) => setEditContentSummary(e.target.value)}
              placeholder="技术服务费等"
              className="h-8 text-sm"
            />
          </div>
        ) : contentSummary ? (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/20 px-3 py-1.5">
            <span className="text-[11px] text-muted-foreground">开票内容</span>
            <span className="truncate">{contentSummary}</span>
          </div>
        ) : null}
      </div>

      {/* Coverage details */}
      {coverageDetails.length > 0 ? (
        <div className="mt-3 rounded-lg border border-border/50 px-3 py-2">
          <div className="text-[11px] font-medium text-muted-foreground">覆盖订单分摊</div>
          <div className="mt-1 space-y-1">
            {coverageDetails.map((c, i) => {
              const label = orderLabels[i] || c.orderId.slice(-6);
              if (editing) {
                return (
                  <div key={`${c.orderId}-${i}`} className="flex items-center justify-between text-[12px]">
                    <span className="font-mono text-[11px] text-muted-foreground">{label}</span>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      className="h-7 w-28 text-right text-xs"
                      value={editCoverage[c.orderId] ?? ""}
                      onChange={(e) => setEditCoverage((prev) => ({ ...prev, [c.orderId]: e.target.value }))}
                    />
                  </div>
                );
              }
              return (
                <button
                  key={`${c.orderId}-${i}`}
                  type="button"
                  className={ENTITY_ROW_BUTTON_CLASS}
                  onClick={() => openEntityResource("order", c.orderId, "打开订单详情", handlers)}
                >
                  <span className="min-w-0 truncate font-medium">{label}</span>
                  <span className="flex shrink-0 items-center gap-1 tabular-nums text-muted-foreground">
                    {formatYuan(c.amountCents)}
                    <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
                  </span>
                </button>
              );
            })}
          </div>
          {editing ? (
            <div className="mt-1.5 text-[11px] text-muted-foreground">
              保存时会按比例同步明细金额，使明细合计与分摊合计一致
            </div>
          ) : null}
          {editError ? (
            <div className="mt-1.5 text-[11px] text-destructive">{editError}</div>
          ) : null}
        </div>
      ) : null}

      {/* Items */}
      {!editing && items.length > 0 ? (
        <div className="mt-2 rounded-lg border border-border/50 px-3 py-2">
          <div className="text-[11px] font-medium text-muted-foreground">明细</div>
          <div className="mt-1 space-y-1">
            {items.map((item, i) => (
              <div key={i} className="flex items-center justify-between text-[12px]">
                <span className="truncate">{item.itemName}{item.quantity != null ? ` ×${item.quantity}` : ""}</span>
                <span className="tabular-nums">{formatYuan(item.amountCents)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </CardShell>
  );
}
