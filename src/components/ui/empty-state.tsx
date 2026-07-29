import { Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  icon?: LucideIcon;
  iconClassName?: string;
  className?: string;
}

export function EmptyState({
  title = "暂无数据",
  description,
  action,
  icon: Icon,
  iconClassName,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-12 text-center",
        className
      )}
    >
      {Icon ? (
        <Icon className={cn("h-10 w-10 text-muted-foreground/50 mb-3", iconClassName)} />
      ) : (
        <Inbox className={cn("h-10 w-10 text-muted-foreground/50 mb-3", iconClassName)} />
      )}
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      {description && (
        <p className="text-xs text-muted-foreground/70 mt-1 max-w-sm">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
