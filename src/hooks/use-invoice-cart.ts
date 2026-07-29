"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * 开票篮持久化模型（finance-invoice-architecture-review-2026-07-01.md §5.1）。
 *
 * 存轻量快照而非纯 id：跨页 / 刷新后 orders state 只有当前页数据，纯 id 无法解析回
 * 订单实体去分组和生成开票默认值。localStorage 只是 UI 缓存——提交前后端必须重新
 * 读取订单、机构、剩余可开票金额，绝不信任缓存快照。
 *
 * 关键约束（§5.1 / §5.3 / §0.1）：
 * - 默认分组键固定为 buyerOrgId（Order.buyerOrganizationId，订单购买方机构），不是 profileId，也不是
 *   buyerOrgNameSnapshot 名称匹配。
 * - 缺 buyerOrgId 的订单不允许加入篮子（调用方负责禁用 checkbox）；本 hook 也会
 *   在 add 时防御性拒绝无 buyerOrgId 的条目。
 * - amount 单位是「分」，用于分摊和合计，禁止在此层做任何比例推断。
 */
export type CartItem = {
  orderId: string;
  orderNo: string;
  /** 展示用：作为开票行项目名的首选来源（可空，回退到订单号 / 客户名）。 */
  title?: string;
  /** CrmCustomerProfile.id；缺绑定时为 null。 */
  profileId: string | null;
  customerName: string;
  /** Order.buyerOrganizationId（订单购买方机构），必填；缺失订单不能加入篮子。 */
  buyerOrgId: string;
  /** 抬头显示。 */
  buyerOrgName: string;
  /** 分，用于分摊和合计。 */
  amount: number;
  /** 排序用时间戳（毫秒）。 */
  addedAt: number;
};

export type CartOrgGroup = {
  orgId: string;
  orgName: string;
  items: CartItem[];
  /** 该机构组的金额合计（分）。 */
  subtotal: number;
};

const KEY_PREFIX = "orders.invoiceCart.";

function storageKeyFor(userId: string | undefined | null): string | null {
  if (!userId) return null;
  return `${KEY_PREFIX}${userId}`;
}

function isValidItem(x: unknown): x is CartItem {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.orderId === "string" &&
    r.orderId.length > 0 &&
    typeof r.buyerOrgId === "string" &&
    r.buyerOrgId.length > 0 &&
    typeof r.amount === "number" &&
    Number.isFinite(r.amount)
  );
}

function readCart(key: string | null): CartItem[] {
  if (!key || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidItem).map((item) => {
      const legacy = item as CartItem;
      // W6.2c：旧缓存把 Customer ID 伪装成 profileId 会写坏提交；下面逐字段重建条目，
      // 旧契约字段随之丢弃；profileId 仅在已是合法字段时保留，否则置空（提交前后端按 orderId 重取）。
      const profileId =
        typeof legacy.profileId === "string" && legacy.profileId.length > 0
          ? legacy.profileId
          : null;
      return {
        orderId: legacy.orderId,
        orderNo: legacy.orderNo,
        title: legacy.title,
        profileId,
        customerName: legacy.customerName,
        buyerOrgId: legacy.buyerOrgId,
        buyerOrgName: legacy.buyerOrgName,
        amount: legacy.amount,
        addedAt: legacy.addedAt,
      };
    });
  } catch {
    return [];
  }
}

function writeCart(key: string | null, items: CartItem[]): void {
  if (!key || typeof window === "undefined") return;
  try {
    if (items.length === 0) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, JSON.stringify(items));
    }
  } catch {
    /* ignore quota / privacy-mode failures — cart is best-effort UI state */
  }
}

/**
 * 开票篮 hook。封装 localStorage 读写 + storage 事件跨 tab 同步 + 派生
 * selectedIds / groupedByOrg / crossOrgCount。
 *
 * 写操作同步落 localStorage + state（不走 persist effect，避免加载/持久化的
 * 双 effect 竞态）；storage 事件只在其他 tab 触发，回填本 tab state。
 */
export function useInvoiceCart(userId: string | undefined | null) {
  const key = storageKeyFor(userId);
  const [cartState, setCartState] = useState(() => ({
    key,
    items: readCart(key),
  }));

  // 加载：仅在 key 变化时从 localStorage 读入（客户端 only，避免 SSR 水合不一致）。
  const items = cartState.key === key ? cartState.items : readCart(key);
  const setItems = useCallback(
    (updater: CartItem[] | ((prev: CartItem[]) => CartItem[])) => {
      setCartState((prev) => {
        const current = prev.key === key ? prev.items : readCart(key);
        const nextItems = typeof updater === "function" ? updater(current) : updater;
        return { key, items: nextItems };
      });
    },
    [key],
  );

  // 跨 tab 同步：其他 tab 改写同一 key 时回填本 tab。
  useEffect(() => {
    if (!key || typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) setCartState({ key, items: readCart(key) });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key]);

  const commit = useCallback(
    (next: CartItem[]) => {
      writeCart(key, next);
      setItems(next);
    },
    [key, setItems],
  );

  const add = useCallback(
    (item: CartItem) => {
      if (!key) return;
      // 防御：无结构化购买方机构不得入篮（§5.1 / §0.1）。
      if (!item.buyerOrgId) return;
      setItems((prev) => {
        if (prev.some((p) => p.orderId === item.orderId)) return prev;
        const next = [...prev, item];
        writeCart(key, next);
        return next;
      });
    },
    [key, setItems],
  );

  const addMany = useCallback(
    (list: CartItem[]) => {
      if (!key) return;
      setItems((prev) => {
        const seen = new Set(prev.map((p) => p.orderId));
        const additions = list.filter((it) => it.buyerOrgId && !seen.has(it.orderId));
        if (additions.length === 0) return prev;
        const next = [...prev, ...additions];
        writeCart(key, next);
        return next;
      });
    },
    [key, setItems],
  );

  const remove = useCallback(
    (orderId: string) => {
      if (!key) return;
      setItems((prev) => {
        const next = prev.filter((p) => p.orderId !== orderId);
        if (next.length === prev.length) return prev;
        writeCart(key, next);
        return next;
      });
    },
    [key, setItems],
  );

  const removeMany = useCallback(
    (orderIds: string[]) => {
      if (!key) return;
      const drop = new Set(orderIds);
      setItems((prev) => {
        const next = prev.filter((p) => !drop.has(p.orderId));
        if (next.length === prev.length) return prev;
        writeCart(key, next);
        return next;
      });
    },
    [key, setItems],
  );

  const removeOrg = useCallback(
    (orgId: string) => {
      if (!key) return;
      setItems((prev) => {
        const next = prev.filter((p) => p.buyerOrgId !== orgId);
        if (next.length === prev.length) return prev;
        writeCart(key, next);
        return next;
      });
    },
    [key, setItems],
  );

  const toggle = useCallback(
    (item: CartItem) => {
      if (!key || !item.buyerOrgId) return;
      setItems((prev) => {
        const exists = prev.some((p) => p.orderId === item.orderId);
        const next = exists
          ? prev.filter((p) => p.orderId !== item.orderId)
          : [...prev, item];
        writeCart(key, next);
        return next;
      });
    },
    [key, setItems],
  );

  const clear = useCallback(() => {
    commit([]);
  }, [commit]);

  const selectedIds = useMemo(
    () => new Set(items.map((it) => it.orderId)),
    [items],
  );

  const isSelected = useCallback(
    (orderId: string) => selectedIds.has(orderId),
    [selectedIds],
  );

  const sorted = useMemo(
    () => [...items].sort((a, b) => a.addedAt - b.addedAt),
    [items],
  );

  const groupedByOrg = useMemo<CartOrgGroup[]>(() => {
    const map = new Map<string, CartOrgGroup>();
    for (const it of sorted) {
      let g = map.get(it.buyerOrgId);
      if (!g) {
        g = { orgId: it.buyerOrgId, orgName: it.buyerOrgName, items: [], subtotal: 0 };
        map.set(it.buyerOrgId, g);
      }
      g.items.push(it);
      g.subtotal += it.amount;
    }
    return [...map.values()];
  }, [sorted]);

  const crossOrgCount = groupedByOrg.length;

  const totalAmount = useMemo(
    () => items.reduce((s, it) => s + it.amount, 0),
    [items],
  );

  return {
    /** 排序后的篮子条目（按 addedAt 升序）。 */
    items: sorted,
    count: items.length,
    /** 合计金额（分）。 */
    totalAmount,
    selectedIds,
    isSelected,
    groupedByOrg,
    /** 不同开票机构数量；> 1 表示跨机构。 */
    crossOrgCount,
    add,
    addMany,
    remove,
    removeMany,
    removeOrg,
    toggle,
    clear,
    /** 篮子是否可用（已登录且拿到 userId）。 */
    enabled: key != null,
  };
}
