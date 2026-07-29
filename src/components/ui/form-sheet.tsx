"use client";

import * as React from "react";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogScrollableContent,
  DialogScrollableBody,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface FormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  /** Desktop container variant. "plain" keeps current DialogContent behavior; "scrollable" uses DialogScrollableContent. */
  desktopVariant?: "plain" | "scrollable";
  /** Additional className for desktop Dialog content (e.g. "sm:max-w-md"). */
  desktopMaxW?: string;
  children: React.ReactNode;
}

/**
 * Responsive form container.
 *
 * Contract:
 * - Does NOT render <form>; the caller provides the <form> inside `children`.
 * - No fixed footer slot; submit button must live inside the form (and therefore inside children).
 * - Mobile renders a bottom Sheet with a scrollable body.
 * - Desktop renders the equivalent existing Dialog container unchanged.
 */
export function FormSheet({
  open,
  onOpenChange,
  title,
  desktopVariant = "plain",
  desktopMaxW,
  children,
}: FormSheetProps) {
  const isMobile = useMediaQuery("(max-width: 767px)");

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="max-h-[90dvh] flex flex-col gap-0 px-0 pb-0">
          <SheetHeader className="px-4 pb-2">
            <SheetTitle>{title}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
            {children}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  if (desktopVariant === "scrollable") {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogScrollableContent className={cn("sm:max-w-sm", desktopMaxW)}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <DialogScrollableBody>{children}</DialogScrollableBody>
        </DialogScrollableContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("sm:max-w-sm", desktopMaxW)}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
