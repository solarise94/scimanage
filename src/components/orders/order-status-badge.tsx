"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "草稿",
  CONFIRMED: "已确认",
  DELIVERED: "已交付",
  CLOSED: "已关闭",
};

const BADGE_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  CONFIRMED: "default",
  DRAFT: "secondary",
  CLOSED: "outline",
  DELIVERED: "default",
};

function fmtDateTime(s: string | null | undefined): string {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

// orderedAt → confirmedAt → createdAt 回退（与 src/lib/finance/progress.ts:getOrderDate 同口径）
function resolveEstablishedAt(o: OrderTimeline): string | null {
  return o.orderedAt || o.confirmedAt || o.createdAt || null;
}

export interface OrderTimeline {
  id: string;
  status: string;
  orderedAt: string | null;
  confirmedAt: string | null;
  deliveredAt: string | null;
  createdAt: string | null;
}

interface HistoryEntry {
  newStatus?: string | null;
  note?: string | null;
  createdAt?: string | null;
}

/**
 * 状态 Badge → 点击弹出订单时间线（建立/确认/交付 + 最近一次交付流转备注）。
 * 交付备注懒加载：仅在首次打开 Popover 时 fetch /api/orders/[id]/history。
 * 行数据本身不带 history，避免每行预取。非交付态也可点，体验一致。
 */
export function OrderStatusBadge({ order, className }: { order: OrderTimeline; className?: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteLoaded, setNoteLoaded] = useState(false);

  const variant = BADGE_VARIANT[order.status] || "secondary";
  const established = resolveEstablishedAt(order);

  async function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next && !noteLoaded && !noteLoading) {
      setNoteLoading(true);
      try {
        const res = await fetch(`/api/orders/${order.id}/history`);
        if (res.ok) {
          const data = await res.json();
          const history: HistoryEntry[] = Array.isArray(data.history) ? data.history : [];
          // history 已按 createdAt desc 排序，取最近一次 DELIVERED 流转的 note
          const delivered = history.find((h) => h.newStatus === "DELIVERED" && h.note);
          setNote(delivered?.note?.trim() || null);
        }
      } catch {
        /* 交付备注非关键，失败静默 */
      } finally {
        setNoteLoading(false);
        setNoteLoaded(true);
      }
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Badge
            variant={variant}
            className={`cursor-pointer transition-shadow hover:ring-1 hover:ring-foreground/25 ${className || ""}`}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          />
        }
      >
        {STATUS_LABELS[order.status] || order.status}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-col gap-1.5 text-xs">
          <div className="mb-0.5 text-sm font-medium">订单时间线</div>
          <TimelineRow label="建立" value={fmtDateTime(established)} />
          <TimelineRow label="确认" value={fmtDateTime(order.confirmedAt)} muted={!order.confirmedAt} />
          <TimelineRow
            label="交付"
            value={order.deliveredAt ? fmtDateTime(order.deliveredAt) : "尚未交付"}
            muted={!order.deliveredAt}
          />
          <div className="my-1 border-t border-border" />
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">交付备注</span>
            {noteLoading ? (
              <span className="text-muted-foreground">加载中…</span>
            ) : note ? (
              <span className="whitespace-pre-wrap break-words">{note}</span>
            ) : (
              <span className="text-muted-foreground">无</span>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TimelineRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${muted ? "text-muted-foreground" : ""}`}>{value || "—"}</span>
    </div>
  );
}
