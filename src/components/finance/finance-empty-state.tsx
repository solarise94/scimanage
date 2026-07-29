import { Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";

interface FinanceEmptyStateProps {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

/**
 * Finance empty state — thin wrapper over the shared ui/empty-state primitive,
 * keeping the finance-default Inbox icon.
 */
export function FinanceEmptyState({
  title = "暂无数据",
  description,
  action,
  className,
}: FinanceEmptyStateProps) {
  return (
    <EmptyState
      icon={Inbox}
      title={title}
      description={description}
      action={action}
      className={cn(className)}
    />
  );
}
