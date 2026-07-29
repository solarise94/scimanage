import { cn } from "@/lib/utils"

/**
 * Skeleton — the single loading primitive.
 *
 * Uses a subtle shimmer sweep instead of a plain opacity pulse. The shimmer is
 * a decorative animation and is disabled under prefers-reduced-motion (falls
 * back to a static muted fill via animate-pulse). Kept on transform/opacity
 * only (no layout animation).
 */
function Skeleton({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "relative overflow-hidden rounded-md bg-muted",
        // base pulse for reduced-motion users (no shimmer sweep)
        "motion-reduce:animate-pulse",
        className
      )}
      {...props}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -translate-x-full animate-[skeleton-shimmer_1.6s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-foreground/5 to-transparent motion-reduce:hidden"
      />
      {children}
    </div>
  )
}

export { Skeleton }
