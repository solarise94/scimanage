"use client";

import { cn } from "@/lib/utils";

export interface StatusChipItem {
  key: string;
  label: string;
  count: number;
  /** 未选中时的状态色点（可选，用于视觉提示各状态颜色） */
  dotColor?: string;
}

export interface StatusChipsProps {
  items: StatusChipItem[];
  activeKey: string;
  onSelect: (key: string) => void;
}

/**
 * 顶部状态 chip 组：带计数、可点击切换。
 * 布局 flex-wrap，移动端横向滚动（overflow-x-auto）。
 */
export function StatusChips({ items, activeKey, onSelect }: StatusChipsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => {
        const active = item.key === activeKey;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onSelect(item.key)}
            aria-pressed={active}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap",
              active
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/70",
            )}
          >
            {item.dotColor && !active && (
              <span className={cn("h-2 w-2 rounded-full", item.dotColor)} />
            )}
            <span>{item.label}</span>
            <span className="tabular-nums opacity-80">{item.count}</span>
          </button>
        );
      })}
    </div>
  );
}
