"use client";

import * as React from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ActionCardItem {
  label: string;
  href: string;
  icon: React.ElementType;
  description?: React.ReactNode;
}

export interface ActionCardProps {
  action: ActionCardItem;
  className?: string;
}

export function ActionCard({ action, className }: ActionCardProps) {
  return (
    <Link href={action.href} className={cn("block h-full", className)}>
      <Card variant="interactive" className="group h-full">
        <CardContent className="p-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 mt-0.5">
              <action.icon className="h-4 w-4 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium leading-snug line-clamp-2">{action.label}</p>
              {action.description && (
                <p className="text-xs text-muted-foreground leading-snug line-clamp-2">{action.description}</p>
              )}
            </div>
            <ArrowRight className="hidden sm:block h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5" />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
