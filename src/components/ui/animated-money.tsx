"use client";

import { AnimatedNumber } from "@/components/ui/animated-number";
import { MoneyText, type MoneyTextProps } from "@/components/ui/money-text";

interface AnimatedMoneyProps
  extends Omit<MoneyTextProps, "value" | "renderValue"> {
  value: number;
  /** 滚动小数位，默认 2 */
  decimals?: number;
  /** 动画行为，默认 "always"（详见 useCountUp） */
  mode?: "always" | "once";
}

/** 带数字滚动动画的金额展示，复用 MoneyText 的 tone/compact/unit/showCurrency。 */
export function AnimatedMoney({
  value,
  decimals = 2,
  mode = "always",
  unit = "yuan",
  ...rest
}: AnimatedMoneyProps) {
  // 动画按“元”滚动；unit=cents 时先换算，避免把 12345 分滚成 12345 元。
  const animatedValue = unit === "cents" ? value / 100 : value;
  return (
    <AnimatedNumber value={animatedValue} decimals={decimals} mode={mode}>
      {({ formatted }) => (
        <MoneyText value={value} unit={unit} renderValue={formatted} {...rest} />
      )}
    </AnimatedNumber>
  );
}
