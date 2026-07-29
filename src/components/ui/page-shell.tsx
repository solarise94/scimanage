import { cn } from "@/lib/utils";

interface PageShellProps {
  children: React.ReactNode;
  maxWidth?: boolean;
  className?: string;
}

/**
 * PageShell — page-level content wrapper.
 *
 * Adds a short fade-in + translateY(4px) entrance on mount (200ms, ease-out).
 * The entrance is decorative and is disabled under prefers-reduced-motion
 * (§3.6). Kept on transform/opacity only (no layout animation).
 */
export function PageShell({
  children,
  maxWidth = true,
  className,
}: PageShellProps) {
  return (
    <div
      className={cn(
        "space-y-6 animate-[page-fade-in_200ms_ease-out_both] motion-reduce:animate-none",
        maxWidth && "max-w-7xl mx-auto",
        className
      )}
    >
      {children}
    </div>
  );
}
