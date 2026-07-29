"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { cn } from "@/lib/utils";
import { getMobilePrimaryNav, getMobileMoreItem, isActiveNavItem } from "@/lib/nav";
import { useMobileNavStore } from "@/lib/stores/mobile-nav-store";

export function MobileNav() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const role = session?.user?.role;
  const { primary } = getMobilePrimaryNav(role);
  const openDrawer = useMobileNavStore((s) => s.openDrawer);
  const moreItem = getMobileMoreItem();

  const navItems = [...primary, moreItem];

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 border-t bg-background/95 backdrop-blur md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="flex h-16 items-center justify-around">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isMore = item.href === "#more";
          const isActive = isMore
            ? false
            : isActiveNavItem(pathname, item.href);

          const content = (
            <>
              <Icon className="h-5 w-5 shrink-0" />
              <span className="truncate whitespace-nowrap">{item.label}</span>
            </>
          );

          const baseClasses = cn(
            "flex min-w-0 flex-1 flex-col items-center justify-center gap-1 px-2 py-2 text-xs transition-colors",
            isActive
              ? "text-primary font-medium"
              : "text-muted-foreground hover:text-foreground"
          );

          if (isMore) {
            return (
              <button
                key="more"
                type="button"
                onClick={openDrawer}
                className={baseClasses}
                aria-label="更多导航"
              >
                {content}
              </button>
            );
          }

          return (
            <Link
              key={item.href}
              href={item.href}
              className={baseClasses}
            >
              {content}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
