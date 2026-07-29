"use client";

import * as React from "react";
import { useCountUp } from "@/hooks/use-count-up";

interface AnimatedNumberProps {
  value: number;
  decimals?: number;
  mode?: "always" | "once";
  className?: string;
  children?: (state: { formatted: string }) => React.ReactNode;
}

export function AnimatedNumber({
  value,
  decimals = 0,
  mode = "always",
  className,
  children,
}: AnimatedNumberProps) {
  const { ref, formatted } = useCountUp({ value, decimals, mode });

  return (
    <span ref={ref} className={className}>
      {children ? children({ formatted }) : formatted}
    </span>
  );
}
