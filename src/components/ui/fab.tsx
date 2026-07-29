"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface FabProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

/**
 * Floating Action Button for mobile.
 * Anchored bottom-right, above the mobile tab bar with safe-area inset.
 */
export function Fab({ children, className, ...props }: FabProps) {
  return (
    <button
      type="button"
      className={cn(
        "fixed right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 active:scale-95 focus-visible:ring-3 focus-visible:ring-ring/50",
        "bottom-[calc(4.5rem+env(safe-area-inset-bottom))]",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}
