"use client";

import * as React from "react";
import Link from "next/link";
import { Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { AnimatedMoney } from "@/components/ui/animated-money";
import { MoneyText, formatCompactWanValue, formatMoneyValue } from "@/components/ui/money-text";
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import { useReducedMotion } from "motion/react";

type KpiVariant = "default" | "primary" | "success" | "warning" | "danger" | "muted";

export interface KpiCardProps {
  title: string;
  value: number | string;
  icon?: LucideIcon;
  description?: string;
  trend?: { value: string; direction: "up" | "down" | "flat" };
  variant?: KpiVariant;
  animate?: boolean;
  unit?: "yuan" | "cents";
  href?: string;
  className?: string;
  methodology?: string;
  mobileCompactAmount?: boolean;
}

const variantMap: Record<KpiVariant, { border: string; iconBg: string; iconText: string; tone: React.ComponentProps<typeof MoneyText>["tone"] }> = {
  default: { border: "border-l-transparent", iconBg: "bg-muted", iconText: "text-muted-foreground", tone: "default" },
  primary: { border: "border-l-primary/60", iconBg: "bg-primary/10", iconText: "text-primary", tone: "default" },
  success: { border: "border-l-success-border/60", iconBg: "bg-success/10", iconText: "text-success", tone: "income" },
  warning: { border: "border-l-warning-border/60", iconBg: "bg-warning/10", iconText: "text-warning", tone: "warning" },
  danger: { border: "border-l-danger-border/60", iconBg: "bg-danger/10", iconText: "text-danger", tone: "expense" },
  muted: { border: "border-l-muted", iconBg: "bg-muted", iconText: "text-muted-foreground", tone: "muted" },
};

export function KpiCard({
  title, value, icon: Icon, description, trend, variant = "default", animate = true,
  unit, href, className, methodology, mobileCompactAmount = false,
}: KpiCardProps) {
  const reducedMotion = useReducedMotion();
  const styles = variantMap[variant];
  const isNumber = typeof value === "number";
  const numericValue = isNumber ? value : 0;
  const compactAmount = isNumber && unit && mobileCompactAmount
    ? formatCompactWanValue(numericValue, unit)
    : null;
  const formattedLength = isNumber
    ? unit ? `¥${formatMoneyValue(numericValue, unit)}`.length : numericValue.toLocaleString("zh-CN").length
    : value.length;
  const numberBase = cn(
    "min-w-0 font-bold tabular-nums leading-tight whitespace-nowrap",
    formattedLength > 8 ? "text-lg sm:text-2xl" : "text-2xl",
  );
  const numberToneClass = variant === "success" ? "text-success" : variant === "warning" ? "text-warning" : variant === "danger" ? "text-danger" : variant === "muted" ? "text-muted-foreground" : "";

  const exactAmount = isNumber && unit ? `精确金额：¥${formatMoneyValue(numericValue, unit)}` : null;
  const numberContent = (() => {
    if (!isNumber) return <span className={cn(numberBase, numberToneClass)}>{value}</span>;
    if (unit) {
      const full = animate && !reducedMotion
        ? <AnimatedMoney value={numericValue} unit={unit} tone={styles.tone} className={numberBase} />
        : <MoneyText value={numericValue} unit={unit} tone={styles.tone} className={numberBase} />;
      if (!compactAmount) return full;
      return (
        <>
          <span className={cn(numberBase, numberToneClass, "sm:hidden")}>{compactAmount}</span>
          <span className="hidden sm:inline">{full}</span>
        </>
      );
    }
    const cls = cn(numberBase, numberToneClass);
    return animate && !reducedMotion
      ? <AnimatedNumber value={numericValue} className={cls} />
      : <span className={cls}>{numericValue.toLocaleString("zh-CN")}</span>;
  })();

  const infoText = methodology ?? (compactAmount ? exactAmount : null);
  const card = (
    <Card variant="tinted" className={cn(
      "relative min-w-0 transition-all duration-300 ease-out motion-reduce:transition-none hover:-translate-y-0.5 hover:shadow-md motion-reduce:hover:translate-y-0",
      styles.border,
      variant === "warning" && "bg-warning-bg/30",
      variant === "danger" && "bg-danger-bg/30",
      variant === "success" && "bg-success-bg/30",
      variant === "muted" && "bg-muted/20",
      className,
    )}>
      {href && <Link href={href} aria-label={`${title}：查看详情`} className="absolute inset-0 z-10 rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />}
      <CardHeader className="flex min-w-0 flex-row items-start justify-between gap-2 pb-2">
        <div className="flex min-w-0 items-start gap-1">
          <CardTitle className="min-w-0 text-sm font-medium leading-snug text-muted-foreground">{title}</CardTitle>
          {infoText && (
            <Popover>
              <PopoverTrigger
                aria-label="查看指标口径"
                className="relative z-20 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Info className="h-3.5 w-3.5" />
              </PopoverTrigger>
              <PopoverContent align="start" side="bottom" className="z-50">
                <PopoverTitle>指标口径</PopoverTitle>
                <PopoverDescription>{methodology}</PopoverDescription>
                {compactAmount && exactAmount && <p className="font-medium tabular-nums">{exactAmount}</p>}
              </PopoverContent>
            </Popover>
          )}
        </div>
        {Icon && <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", styles.iconBg, styles.iconText)}><Icon className="h-4 w-4" /></div>}
      </CardHeader>
      <CardContent className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-baseline gap-2">
          {numberContent}
          {trend && <span className={cn("inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium", trend.direction === "up" && "bg-success/10 text-success", trend.direction === "down" && "bg-danger/10 text-danger", trend.direction === "flat" && "bg-muted text-muted-foreground")}>{trend.direction === "up" ? "↑" : trend.direction === "down" ? "↓" : "→"}{trend.value}</span>}
        </div>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      </CardContent>
    </Card>
  );

  return card;
}
