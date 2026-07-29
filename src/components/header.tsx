"use client";

import { useSession } from "next-auth/react";
import { FlaskConical, Menu } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Sidebar } from "./sidebar";
import { NotificationCenter } from "./notification-center";
import { useMobileNavStore } from "@/lib/stores/mobile-nav-store";

export function Header() {
  const { data: session } = useSession();
  const user = session?.user;
  const { drawerOpen, setDrawerOpen } = useMobileNavStore();

  return (
    <header className="sticky top-0 z-40 flex h-16 items-center gap-4 border-b bg-background/95 backdrop-blur px-4 md:px-8">
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetTrigger
          className="md:hidden"
          render={<Button variant="ghost" size="icon" className="shrink-0 md:hidden" />}
        >
          <Menu className="h-5 w-5" />
          <span className="sr-only">打开菜单</span>
        </SheetTrigger>
        <SheetContent
          side="left"
          className="w-64 border-r border-border bg-background p-0 shadow-none ring-0 data-[side=left]:rounded-r-none"
        >
          <Sidebar mobile onNavClick={() => setDrawerOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex md:hidden items-center gap-2">
        <FlaskConical className="h-5 w-5 text-primary" />
        <span className="font-bold">SciManage</span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {user && (
          <>
            <NotificationCenter />
            <div className="flex items-center gap-3 pl-2 border-l">
              <div className="hidden sm:flex flex-col items-end">
                <span className="text-sm font-medium leading-none">{user.name}</span>
                <span className="text-xs text-muted-foreground">{user.email}</span>
              </div>
              <Avatar className="h-8 w-8">
                <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                  {user.name?.slice(0, 2)?.toUpperCase() || "U"}
                </AvatarFallback>
              </Avatar>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
