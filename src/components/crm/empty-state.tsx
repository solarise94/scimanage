"use client";

import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import type { LucideIcon } from "lucide-react";

interface CrmEmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  className?: string;
}

/**
 * CRM empty state — thin wrapper over the shared ui/empty-state primitive,
 * keeping the CRM-default icon styling (thin stroke, lower opacity).
 */
export function CrmEmptyState({ icon: Icon, title, description, className }: CrmEmptyStateProps) {
  return (
    <EmptyState
      icon={Icon}
      title={title}
      description={description}
      className={cn(className)}
      // Preserve the CRM card visual weight via icon container classes.
      iconClassName="opacity-40"
    />
  );
}
