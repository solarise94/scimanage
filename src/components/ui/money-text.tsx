import { cn } from "@/lib/utils";
import { centsToYuan } from "@/lib/finance/money";

export interface MoneyTextProps {
  value: number | null | undefined;
  tone?: "default" | "income" | "expense" | "warning" | "muted";
  compact?: boolean;
  showCurrency?: boolean;
  /** 传入值的单位。默认 "yuan"（元）；财务口径数据已存为分时传 "cents" */
  unit?: "yuan" | "cents";
  className?: string;
  /** 已格式化好的显示字符串；命中则跳过内部 toLocaleString，直接渲染。供动画组件注入滚动值。 */
  renderValue?: string;
}

export function formatMoneyValue(
  value: number | null | undefined,
  unit: "yuan" | "cents" = "yuan",
  compact = false,
): string {
  const raw = value ?? 0;
  const num = unit === "cents" ? centsToYuan(raw) : raw;
  return num.toLocaleString("zh-CN", {
    minimumFractionDigits: compact ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export function formatCompactWanValue(
  value: number | null | undefined,
  unit: "yuan" | "cents" = "yuan",
): string | null {
  const raw = value ?? 0;
  const yuan = unit === "cents" ? centsToYuan(raw) : raw;
  if (Math.abs(yuan) < 1_000_000) return null;
  return `¥${(yuan / 10_000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 万`;
}

export function MoneyText({
  value,
  tone = "default",
  compact = false,
  showCurrency = true,
  unit = "yuan",
  className,
  renderValue,
}: MoneyTextProps) {
  const formatted = renderValue ?? formatMoneyValue(value, unit, compact);

  return (
    <span
      className={cn(
        "tabular-nums",
        tone === "income" && "text-success",
        tone === "expense" && "text-danger",
        tone === "warning" && "text-warning",
        tone === "muted" && "text-muted-foreground",
        className
      )}
    >
      {showCurrency && "¥"}
      {formatted}
    </span>
  );
}
