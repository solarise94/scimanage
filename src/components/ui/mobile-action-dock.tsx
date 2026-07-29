import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * MobileActionDock — fixed bottom action bar for mobile primary actions (§3.8).
 *
 * - Renders only below the md breakpoint (md:hidden).
 * - Anchored above the mobile tab bar: bottom = 4.5rem + safe-area-inset-bottom
 *   (4rem tab bar + 0.5rem gap), matching the FAB baseline. z-index matches FAB.
 * - Background blur + top border for separation.
 * - Mutually exclusive with FAB on the same page (pick one).
 *
 * Pages using this dock MUST add bottom padding to their main content
 * (e.g. `pb-24`) so the last form item isn't covered.
 */
export interface MobileActionDockProps {
  /** Primary action button props (label via children). */
  primary: React.ReactNode;
  /** Optional secondary action(s), rendered before the primary button. */
  secondary?: React.ReactNode;
  className?: string;
  /** Stickiness offset override; defaults to the MobileNav baseline. */
  bottomOffset?: string;
}

export function MobileActionDock({
  primary,
  secondary,
  className,
  bottomOffset = "calc(4.5rem + env(safe-area-inset-bottom))",
}: MobileActionDockProps) {
  return (
    <div
      className={cn(
        "fixed inset-x-0 z-40 flex items-center gap-2 border-t bg-background/80 px-3 py-2 backdrop-blur supports-backdrop-filter:bg-background/70",
        "md:hidden",
        className,
      )}
      style={{ bottom: bottomOffset }}
    >
      {secondary}
      {primary}
    </div>
  );
}

/** Convenience dock button (full-width primary by default). */
export function MobileActionButton({ className, ...props }: React.ComponentProps<typeof Button>) {
  return <Button className={cn("h-11 flex-1", className)} {...props} />;
}
