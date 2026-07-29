"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Loader2, ShoppingBag, AlertCircle, FileCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";

/**
 * 订单草稿编辑卡（public tool prepare_order 的 GenUI 卡）。
 *
 * 链路（Phase C，与 propose.ts facade 一致）：
 *   prepare_order → 本卡（选产品/项目类型/数量/单价）→ PATCH 草稿行
 *   → propose_order(orderDraftId) → createAgentProposal → 用户确认 → orders.create_from_draft
 *
 * 模式参考 crm-checkin-draft-card：prepare 产出的锚点 id（orderDraftId）由本卡持有，
 * 用户填表后 PATCH 写草稿，再调 onCreateProposal("propose_order", ...) 生成 PENDING proposal
 * 并立即确认（用户的「生成订单提案」点击即确认意图）。
 *
 * 产品/项目类型只能从 prepare_order 颁发的候选集选（封闭集合，无自由文本）；
 * PATCH 时 service 会查表复核 serviceCatalogId 是否仍为 active catalog 成员。
 */

/** prepare_order facade 透出的产品 option（见 order-drafts.ts ProductOption）。 */
interface ProductOption {
  serviceCatalogId: string;
  productKey?: string;
  displayName: string;
}

/** prepare_order facade 透出的项目类型 option。 */
interface ProjectTypeOption {
  projectTypeOptionId: string;
  displayName: string;
}

/** GenUI 本地行状态：PATCH 时映射为 service 期望的 row 形状。 */
interface DraftRow {
  /** 稳定的本地 key（PATCH body.rows[].rowRef），用顺序生成保证幂等。 */
  rowRef: string;
  serviceCatalogId: string;
  projectTypeOptionId: string;
  quantity: string;
  unitPriceYuan: string;
}

/** PATCH body.rows[] 的形状（与 /api/agent/order-drafts/[id] route 白名单一致）。 */
interface PatchRow {
  rowRef: string;
  serviceCatalogId: string;
  projectTypeOptionId: string;
  quantity: number;
  unitPriceYuan: number;
}

const MAX_UNIT_PRICE_YUAN = 10_000_000;

/** 把本地行转成 PATCH row；非法（未选产品/类型/数量<=0/单价越界）返回 null。 */
function toPatchRow(row: DraftRow): PatchRow | null {
  if (!row.serviceCatalogId || !row.projectTypeOptionId) return null;
  const quantity = Number(row.quantity);
  const unitPriceYuan = Number(row.unitPriceYuan);
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  if (!Number.isFinite(unitPriceYuan) || unitPriceYuan < 0 || unitPriceYuan > MAX_UNIT_PRICE_YUAN) return null;
  return {
    rowRef: row.rowRef,
    serviceCatalogId: row.serviceCatalogId,
    projectTypeOptionId: row.projectTypeOptionId,
    quantity,
    unitPriceYuan,
  };
}

/** 计算当前行的金额（元），用于实时展示。 */
function rowAmount(row: DraftRow): number {
  const q = Number(row.quantity);
  const p = Number(row.unitPriceYuan);
  if (!Number.isFinite(q) || !Number.isFinite(p)) return 0;
  return q * p;
}

export function OrderDraftEditCard({
  descriptor,
  proposal,
  proposalBusyId,
  onConfirmProposal,
  onCreateProposal,
  onCardDirtyChange,
}: AgentCardProps) {
  const orderDraftId = descriptor.props.orderDraftId as string;
  const expectedVersion = typeof descriptor.props.version === "number" ? descriptor.props.version : 0;
  const patchEndpoint = descriptor.props.patchEndpoint as string;
  const productOptions = (descriptor.props.productOptions as ProductOption[] | undefined) ?? [];
  const projectTypeOptions = (descriptor.props.projectTypeOptions as ProjectTypeOption[] | undefined) ?? [];

  const isPending = descriptor.state === "pending";
  const isTerminal = descriptor.state === "saved" || descriptor.state === "cancelled";

  // 初始一行空行，引导用户开始填写。
  const [rows, setRows] = useState<DraftRow[]>(() => [
    { rowRef: "row-1", serviceCatalogId: "", projectTypeOptionId: "", quantity: "1", unitPriceYuan: "" },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(expectedVersion);

  // 未保存状态上报（与 checkin-draft-card 一致的 dirty 保护模式）。
  useEffect(() => {
    if (isTerminal || isPending) {
      onCardDirtyChange?.(false);
      return;
    }
    const hasContent = rows.some(
      (r) => r.serviceCatalogId || r.projectTypeOptionId || r.quantity !== "1" || r.unitPriceYuan,
    );
    onCardDirtyChange?.(hasContent);
    return () => onCardDirtyChange?.(false);
  }, [rows, isTerminal, isPending, onCardDirtyChange]);

  const addRow = useCallback(() => {
    setRows((prev) => [
      ...prev,
      {
        rowRef: `row-${prev.length + 1}`,
        serviceCatalogId: "",
        projectTypeOptionId: "",
        quantity: "1",
        unitPriceYuan: "",
      },
    ]);
  }, []);

  const removeRow = useCallback((idx: number) => {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  }, []);

  const updateRow = useCallback((idx: number, patch: Partial<DraftRow>) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }, []);

  const totalYuan = rows.reduce((sum, r) => sum + rowAmount(r), 0);

  async function handleGenerateProposal() {
    if (!orderDraftId || !patchEndpoint) {
      setError("草稿数据缺失（orderDraftId/patchEndpoint），请重新发起 prepare_order");
      return;
    }

    const patchRows = rows.map(toPatchRow);
    // 所有行必须完整填写（不允许半成品行进 PATCH）。
    if (patchRows.some((r) => r === null)) {
      setError("每行需完整选择产品、项目类型，并填写大于 0 的数量与有效单价");
      return;
    }
    if (patchRows.length === 0) {
      setError("至少添加一行订单内容");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      // 1. PATCH 草稿行（乐观锁 expectedVersion）。
      const patchRes = await fetch(patchEndpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: version, rows: patchRows }),
      });
      const patchData = (await patchRes.json().catch(() => ({}))) as {
        ok?: boolean;
        version?: number;
        error?: string;
        code?: string;
      };
      if (!patchRes.ok || !patchData.ok) {
        if (patchData.code === "VERSION_CONFLICT") {
          setError("草稿版本已变化（可能被其他操作修改），请重新发起 prepare_order");
        } else {
          setError(patchData.error ?? "保存草稿行失败");
        }
        return;
      }
      if (typeof patchData.version === "number") setVersion(patchData.version);

      // 2. 调 propose_order(orderDraftId) 生成 PENDING proposal。
      if (!onCreateProposal) {
        setError("无法创建订单提案（缺少 onCreateProposal）");
        return;
      }
      const newProposal = await onCreateProposal("propose_order", { orderDraftId });
      if (!newProposal) {
        setError("生成订单提案失败，请重试");
        return;
      }
      // 用户的「生成订单提案」点击即确认意图，立即确认（与 checkin-draft-card 一致）。
      await onConfirmProposal(newProposal.id);
    } catch {
      setError("操作失败，请重试");
    } finally {
      setSubmitting(false);
    }
  }

  // 已生成 proposal（propose_order 返回 mode:"proposal"）→ 复用 OrderCreateDraftCard 渲染确认态，
  // 本卡只处理 prepare_order 的 preview 态。pending/saved/cancelled 由 state 短路。
  if (isPending && proposal) {
    return null; // 由 orders.create-draft 卡（propose_order 映射）渲染
  }

  if (descriptor.state === "saved") {
    return (
      <CardShell title="订单草稿" state="saved">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100">
            <FileCheck className="h-5 w-5 text-emerald-600" />
          </div>
          <div className="min-w-0 text-sm">
            <div className="font-medium">订单提案已生成</div>
            <div className="text-[11px] text-muted-foreground">请在订单确认卡中完成最终确认</div>
          </div>
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell
      title="新建订单草稿"
      state={descriptor.state}
      footer={
        <div className="flex flex-col gap-2">
          {error ? (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200/80 bg-rose-50/80 px-3 py-2 text-xs text-rose-950">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          ) : null}
          <Button
            size="sm"
            className="w-full"
            disabled={submitting || !!proposalBusyId}
            onClick={handleGenerateProposal}
          >
            {submitting || proposalBusyId ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileCheck className="h-4 w-4" />
            )}
            生成订单提案
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {/* 行列表 */}
        {rows.map((row, idx) => (
          <div key={row.rowRef} className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-medium text-muted-foreground">第 {idx + 1} 行</span>
              {rows.length > 1 ? (
                <button
                  type="button"
                  className="text-muted-foreground transition-colors hover:text-rose-600"
                  onClick={() => removeRow(idx)}
                  aria-label="删除行"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>

            <div className="space-y-2">
              {/* 产品 */}
              <div>
                <label className="mb-1 block text-[11px] text-muted-foreground">产品</label>
                <Select
                  value={row.serviceCatalogId}
                  onValueChange={(v) => v && updateRow(idx, { serviceCatalogId: v })}
                >
                  <SelectTrigger className="w-full" size="sm">
                    <SelectValue placeholder="选择产品" />
                  </SelectTrigger>
                  <SelectContent>
                    {productOptions.map((opt) => (
                      <SelectItem key={opt.serviceCatalogId} value={opt.serviceCatalogId}>
                        {opt.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* 项目类型 */}
              <div>
                <label className="mb-1 block text-[11px] text-muted-foreground">项目类型</label>
                <Select
                  value={row.projectTypeOptionId}
                  onValueChange={(v) => v && updateRow(idx, { projectTypeOptionId: v })}
                >
                  <SelectTrigger className="w-full" size="sm">
                    <SelectValue placeholder="选择项目类型" />
                  </SelectTrigger>
                  <SelectContent>
                    {projectTypeOptions.map((opt) => (
                      <SelectItem key={opt.projectTypeOptionId} value={opt.projectTypeOptionId}>
                        {opt.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* 数量 + 单价 */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] text-muted-foreground">数量</label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min="1"
                    step="1"
                    value={row.quantity}
                    onChange={(e) => updateRow(idx, { quantity: e.target.value })}
                    className="h-7 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-muted-foreground">单价（元）</label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={row.unitPriceYuan}
                    onChange={(e) => updateRow(idx, { unitPriceYuan: e.target.value })}
                    className="h-7 text-sm"
                    placeholder="0.00"
                  />
                </div>
              </div>

              {/* 行金额 */}
              {row.serviceCatalogId && row.quantity && row.unitPriceYuan ? (
                <div className="text-right text-[11px] text-muted-foreground">
                  小计：¥{rowAmount(row).toFixed(2)}
                </div>
              ) : null}
            </div>
          </div>
        ))}

        {/* 添加行 */}
        <Button size="sm" variant="outline" className="w-full" onClick={addRow}>
          <Plus className="h-3.5 w-3.5" />
          添加一行
        </Button>

        {/* 合计 */}
        <div className="flex items-center justify-between border-t border-border/60 pt-2 text-sm">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <ShoppingBag className="h-3.5 w-3.5" />
            合计
          </span>
          <span className="font-medium">¥{totalYuan.toFixed(2)}</span>
        </div>
      </div>
    </CardShell>
  );
}
