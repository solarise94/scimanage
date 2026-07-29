"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2, CircleSlash, PackageCheck, Loader2 } from "lucide-react";
import { ORDER_STATUS_TRANSITIONS } from "@/lib/orders/constants";
import { toast } from "sonner";
import type { LucideIcon } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

/**
 * 判断关闭弹窗是否应显示"计提"选项：仅跨月关闭的已确认/已交付订单。
 * 当月确认当月关闭净影响为零，无需计提；DRAFT 无确认额也不显示。
 */
export function shouldShowAccrualOption(order: { status: string; confirmedAt?: string | Date | null; orderedAt?: string | Date | null }): boolean {
  if (order.status !== "CONFIRMED" && order.status !== "DELIVERED") return false;
  const ref = order.confirmedAt ?? order.orderedAt;
  if (!ref) return false;
  const refDate = typeof ref === "string" ? new Date(ref) : ref;
  const now = new Date();
  return refDate.getFullYear() !== now.getFullYear() || refDate.getMonth() !== now.getMonth();
}

/**
 * 订单单一状态机流转控件（四态：草稿/已确认/已交付/关闭）。
 *
 * 数据层（ORDER_STATUS_TRANSITIONS + PATCH 校验）已完备，本文件只把「当前状态的合法下一状态」
 * 渲染成动作；非法转换根本不出现。整组写操作 ADMIN-only，与 PATCH /api/orders/[id] 一致。
 *
 * 提供可组合的三块（见 docs/orders-ui-review-round3.md §二 菜单重排）：
 *   - `OrderStatusButtons`   平铺按钮（详情页高频：确认 / 已交付 / 重新确认）
 *   - `OrderStatusMenuItems` 下拉菜单项（列表页 ··· 菜单；详情页「更多」放低频的「关闭」）
 *   - `OrderCloseReasonDialog` 关闭订单原因弹窗（页面级，写入 OrderStatusHistory.note）
 *
 * 「关闭」吸收了原「取消」，是终态；点击后弹原因弹窗（选填），故标记 needsReason。
 */

export interface OrderStatusAction {
  to: string;
  label: string;
  icon: LucideIcon;
  destructive?: boolean;
  needsReason?: boolean;
}

/** 当前状态 → 合法目标动作列表（含文案/图标/是否需原因）。 */
export function getOrderStatusActions(status: string): OrderStatusAction[] {
  const targets = ORDER_STATUS_TRANSITIONS[status] || [];
  return targets.map((to): OrderStatusAction => {
    switch (to) {
      case "CONFIRMED":
        return { to, label: status === "CLOSED" ? "重新确认" : "确认订单", icon: CheckCircle2 };
      case "DELIVERED":
        return { to, label: "交付项目", icon: PackageCheck };
      case "CLOSED":
        return { to, label: "关闭/取消订单", icon: CircleSlash, destructive: true, needsReason: true };
      default:
        return { to, label: to, icon: CheckCircle2 };
    }
  });
}

/** 统一的状态 PATCH。成功 toast + onChanged 由调用方处理（这里只做请求 + 失败 toast）。 */
export async function patchOrderStatus(orderId: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`/api/orders/${orderId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(d.error || "流转失败");
      return false;
    }
    return true;
  } catch {
    toast.error("流转请求失败");
    return false;
  }
}

/**
 * 平铺状态按钮（ADMIN-only）。默认排除「关闭」（低频，详情页放进「更多」下拉）。
 * needsReason 的动作通过 onRequestClose 交回页面（弹原因弹窗）。
 */
export function OrderStatusButtons({
  orderId,
  status,
  isAdmin,
  onChanged,
  onRequestClose,
  exclude = ["CLOSED"],
  className,
}: {
  orderId: string;
  status: string;
  isAdmin: boolean;
  onChanged?: () => void;
  onRequestClose?: (orderId: string) => void;
  exclude?: string[];
  className?: string;
}) {
  const [pending, setPending] = useState<string | null>(null);
  if (!isAdmin) return null;

  const actions = getOrderStatusActions(status).filter((a) => !exclude.includes(a.to));
  if (actions.length === 0) return null;

  const busy = pending !== null;

  const run = async (a: OrderStatusAction) => {
    if (a.needsReason) {
      onRequestClose?.(orderId);
      return;
    }
    setPending(a.to);
    const ok = await patchOrderStatus(orderId, { status: a.to });
    setPending(null);
    if (ok) {
      toast.success("状态已更新");
      onChanged?.();
    }
  };

  return (
    <div className={className} onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-1.5">
        {actions.map((a) => {
          const Icon = a.icon;
          return (
            <Button
              key={a.to}
              size="sm"
              variant="outline"
              className={`h-7 text-xs ${a.destructive ? "text-destructive hover:text-destructive border-destructive/40" : ""}`}
              disabled={busy}
              onClick={(e) => { e.stopPropagation(); run(a); }}
            >
              {pending === a.to ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Icon className="h-3 w-3 mr-1" />}
              {a.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 下拉菜单项形式的状态流转（用于列表 ··· 菜单 / 详情「更多」）。
 * 必须置于 <DropdownMenuContent> 内。needsReason 的动作交回 onRequestClose；其余直接 PATCH。
 * `only` 可限定只渲染部分目标（如详情「更多」只放 CLOSED）。
 */
export function OrderStatusMenuItems({
  orderId,
  status,
  onChanged,
  onRequestClose,
  only,
}: {
  orderId: string;
  status: string;
  onChanged?: () => void;
  onRequestClose: (orderId: string) => void;
  only?: string[];
}) {
  let actions = getOrderStatusActions(status);
  if (only) actions = actions.filter((a) => only.includes(a.to));
  if (actions.length === 0) return null;

  const handle = async (a: OrderStatusAction) => {
    if (a.needsReason) {
      onRequestClose(orderId);
      return;
    }
    const ok = await patchOrderStatus(orderId, { status: a.to });
    if (ok) {
      toast.success("状态已更新");
      onChanged?.();
    }
  };

  return (
    <>
      {actions.map((a) => {
        const Icon = a.icon;
        return (
          <DropdownMenuItem
            key={a.to}
            className={a.destructive ? "text-destructive" : undefined}
            onClick={() => handle(a)}
          >
            <Icon className="h-3.5 w-3.5 mr-1.5" />{a.label}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

/**
 * 关闭订单原因弹窗（页面级，受控）。orderId 为空时不渲染。
 * 关闭 = 终态（吸收原取消），原因选填，写入 OrderStatusHistory.note。
 */
export function OrderCloseReasonDialog({
  orderId,
  open,
  onOpenChange,
  onChanged,
  showAccrualOption = false,
}: {
  orderId: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onChanged?: () => void;
  showAccrualOption?: boolean;
}) {
  const [reason, setReason] = useState("");
  const [accrual, setAccrual] = useState(false);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!orderId) return;
    setBusy(true);
    const body: Record<string, unknown> = { status: "CLOSED", statusNote: reason.trim() || undefined };
    if (accrual) body.closeType = "ACCRUAL";
    const ok = await patchOrderStatus(orderId, body);
    setBusy(false);
    if (ok) {
      toast.success("订单已关闭");
      onChanged?.();
      setReason("");
      setAccrual(false);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) { onOpenChange(v); if (!v) { setReason(""); setAccrual(false); } } }}>
      <DialogContent className="sm:max-w-sm" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>关闭/取消订单</DialogTitle>
          <DialogDescription>关闭为终态。可填写原因（选填，如取消原因），将记录到操作日志。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {showAccrualOption && (
            <>
              <div className="flex items-start gap-2">
                <Checkbox
                  id="accrual-option"
                  checked={accrual}
                  onCheckedChange={(v) => setAccrual(v === true)}
                />
                <div className="grid gap-1 leading-none">
                  <Label htmlFor="accrual-option" className="text-sm font-medium">
                    计提处理（在关闭月冲回本订单的已确认金额）
                  </Label>
                </div>
              </div>
              {accrual && (
                <p className="text-xs text-muted-foreground">
                  将创建一笔负向记录，在本月报表中抵消本订单的已确认金额。原订单的确认记录不变（仍留在原确认月的报表中）。
                </p>
              )}
            </>
          )}
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="关闭原因（选填）"
            rows={3}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            返回
          </Button>
          <Button variant="destructive" disabled={busy} onClick={confirm}>
            {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            确认关闭订单
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
