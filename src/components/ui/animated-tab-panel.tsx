"use client";

import { AnimatePresence, motion } from "motion/react";
import { useReducedMotion } from "motion/react";

export interface AnimatedTabPanelProps {
  /** 当前激活的 tab value */
  activeValue: string;
  /** 本面板对应的 value */
  value: string;
  children: React.ReactNode;
  className?: string;
}

/** 自管显隐的 tab 面板，绕开 base-ui TabsContent 的 unmount 以获得完整 exit 动画。 */
export function AnimatedTabPanel({ activeValue, value, children, className }: AnimatedTabPanelProps) {
  const reduce = useReducedMotion();
  const isActive = activeValue === value;
  return (
    <AnimatePresence mode="wait" initial={false}>
      {isActive && (
        <motion.div
          key={value}
          role="tabpanel"
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
          transition={{ duration: 0.2 }}
          className={className}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
