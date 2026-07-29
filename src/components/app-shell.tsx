"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { Header } from "@/components/header";
import { MobileNav } from "@/components/mobile-nav";
import { RuntimeDebugPanel } from "@/components/runtime-debug-panel";
import { BuildVersionGuard } from "@/components/build-version-guard";

/**
 * Route-aware application shell.
 *
 * On `/agent`:
 * - Desktop keeps the global Sidebar so users can navigate back to other pages.
 * - Header / MobileNav stay hidden; Agent owns top bar + bottom composer.
 * - Sidebar itself is `hidden md:flex`, so mobile Agent still gets a full-bleed
 *   viewport (navigation via the in-shell drawer).
 *
 * On `/login`（含代表 Magic Link 子页）：登录门户不属于已登录应用壳，
 * 不渲染 Sidebar / Header / MobileNav / 调试面板，保持干净的独立入口。
 *
 * On every remaining route the standard desktop Sidebar + Header + MobileNav
 * layout is rendered.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAgentRoute = pathname === "/agent";
  const isPortalRoute = pathname === "/login" || pathname.startsWith("/login/");

  if (isPortalRoute) {
    return <main className="min-h-[100dvh] w-full bg-background">{children}</main>;
  }

  if (isAgentRoute) {
    // 单一 viewport owner：/agent 页面只用这一个 100dvh 容器，
    // 内层 AgentMobileShell / AgentWorkbench 用 h-full，避免 iOS 上
    // 100vh > 100dvh 造成的 body/main 额外滚动与底部空白。
    return (
      <>
        <BuildVersionGuard />
        <Sidebar />
        <main className="flex h-[100dvh] w-full min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
        <RuntimeDebugPanel />
      </>
    );
  }

  return (
    <>
      <BuildVersionGuard />
      <Sidebar />
      <div className="flex-1 flex flex-col min-h-screen md:h-screen md:overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto p-4 md:p-8 pb-24 md:pb-8">
          {children}
        </main>
        <MobileNav />
      </div>
      <RuntimeDebugPanel />
    </>
  );
}
