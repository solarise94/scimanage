"use client";

/**
 * OrderRowDrawer — thin Sheet chrome wrapping {@link OrderDetailView}.
 *
 * The body (Tabs, action bar, dialogs, data loading, mutations) now lives in
 * `order-detail-view.tsx`, where it is shared with the Agent workspace embedded
 * resource view. This file preserves the original Sheet + open/onOpenChange +
 * returnTo contract consumed by `src/app/orders/page.tsx` (no prop changes).
 *
 * Behaviour is identical to the pre-extraction drawer:
 *   - `Sheet` from the right, `sm:max-w-2xl`, scrollable body.
 *   - `onOpenChange(false)` resets the active tab (handled inside the view via
 *     orderId-keyed remount) and notifies the parent.
 *   - When `orderId` is null the Sheet renders empty (no View mounted).
 */

import { useCallback } from "react";
import {
  Sheet,
  SheetContent,
} from "@/components/ui/sheet";
import { OrderDetailView } from "@/components/orders/order-detail-view";

export function OrderRowDrawer({
  orderId,
  open,
  onOpenChange,
  isAdmin,
  userId,
  role,
  initialAction = "",
  initialView = "",
  returnTo = null,
  onChanged,
}: {
  orderId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isAdmin: boolean;
  userId?: string;
  role?: string | null;
  initialAction?: string;
  initialView?: string;
  returnTo?: string | null;
  onChanged?: () => void;
}) {
  // 关闭时由父级把 orderId 置 null；这里仅转发，保证 onOpenChange 契约不变。
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        className="w-full! sm:max-w-2xl! overflow-y-auto"
      >
        {orderId ? (
          <OrderDetailView
            orderId={orderId}
            isAdmin={isAdmin}
            userId={userId}
            role={role}
            initialAction={initialAction}
            initialView={initialView}
            mode="drawer"
            returnTo={returnTo}
            onChanged={onChanged}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
