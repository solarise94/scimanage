"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LogOut,
  FlaskConical,
  User,
} from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { getNavGroups, isActiveNavItem, type NavItem } from "@/lib/nav";

function NavLink({
  item,
  isActive,
  onClick,
  indent = false,
}: {
  item: NavItem;
  isActive: boolean;
  onClick?: () => void;
  indent?: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
        isActive
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
        indent && "pl-9"
      )}
    >
      <Icon className="h-4 w-4" />
      {item.label}
      {item.badge && (
        <span className="ml-auto rounded bg-warning-bg text-warning px-1.5 py-0.5 text-[10px] font-medium">
          {item.badge}
        </span>
      )}
    </Link>
  );
}

export function Sidebar({ mobile, onNavClick }: { mobile?: boolean; onNavClick?: () => void }) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const groups = getNavGroups(session?.user?.role);

  return (
    <aside
      className={cn(
        "w-64 flex-col h-screen sticky top-0",
        // 移动端抽屉与 Agent 主界面共用纯背景色，避免 Sheet(popover) 与
        // Sidebar(muted) 叠出一条明显的色差带。
        mobile ? "flex h-full bg-background" : "hidden md:flex border-r bg-muted/30"
      )}
    >
      <div className="flex h-16 items-center gap-2 px-6 border-b">
        <FlaskConical className="h-6 w-6 text-primary" />
        <span className="text-lg font-bold tracking-tight">SciManage</span>
      </div>
      <nav
        className={cn(
          "flex-1 px-4 py-4 space-y-6 overflow-y-auto overscroll-contain",
          // CSS direction 会把原生纵向滚动条移至左侧；每个内容组随即恢复
          // LTR，文字、图标及链接布局不受影响。
          mobile && "[direction:rtl]",
        )}
      >
        {groups.map((group) => {
          // 桌面 Sidebar 隐藏 mobileOnly 项；移动端抽屉全部展示。
          const items = mobile ? group.items : group.items.filter((i) => !i.mobileOnly);
          if (items.length === 0) return null;
          return (
            <div key={group.title} className="space-y-1 [direction:ltr]">
              <p className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {group.title}
              </p>
              {items.map((item) => {
                const isActive = isActiveNavItem(pathname, item.href);
                return (
                  <NavLink
                    key={item.href}
                    item={item}
                    isActive={isActive}
                    onClick={onNavClick}
                  />
                );
              })}
            </div>
          );
        })}
      </nav>
      <div className="border-t p-4 space-y-1">
        <Link
          href="/profile"
          onClick={onNavClick}
          className={cn(
            "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
            pathname.startsWith("/profile")
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          <User className="h-4 w-4" />
          我的
        </Link>
        <Button
          variant="ghost"
          className="w-full justify-start gap-2 text-muted-foreground"
          onClick={() => {
            onNavClick?.();
            signOut({ callbackUrl: "/login" });
          }}
        >
          <LogOut className="h-4 w-4" />
          退出登录
        </Button>
      </div>
    </aside>
  );
}
