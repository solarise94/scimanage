"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Loader2, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { useMediaQuery } from "@/hooks/use-media-query";
import { Button } from "@/components/ui/button";
import { canAccessAgent, isAdmin, isInternalStaff } from "@/lib/role-guards";
import { AgentMobileShell } from "@/components/agent/agent-mobile-shell";
import { AgentWorkbench } from "@/components/agent/agent-workbench";

export interface AgentUiFlags {
  mobileEnabled: boolean;
  desktopEnabled: boolean;
  genuiEnabled: boolean;
  asrConfigured: boolean;
}

const DEFAULT_FLAGS: AgentUiFlags = {
  mobileEnabled: true,
  desktopEnabled: false,
  genuiEnabled: true,
  asrConfigured: false,
};

/**
 * Agent page guard.
 *
 * 第二轮升级后的路由策略：
 * 1. Unauthenticated -> redirect /login.
 * 2. Viewport undetermined -> neutral loading shell.
 * 3. Desktop viewport (>=768px):
 *    - 内部员工（ADMIN/USER）-> AgentWorkbench（双栏：对话 + 信息面板）
 *    - 销售角色（REPRESENTATIVE/REGIONAL_MANAGER）-> DesktopNoticeShell（提示用手机）
 * 4. mobileEnabled false -> redirect /crm.
 * 5. 通过守卫后渲染 AgentMobileShell.
 *
 * 入口权限边界由 canAccessAgent(role) 守门（ADMIN/USER/REPRESENTATIVE/REGIONAL_MANAGER），
 * 服务端 /api/agent/** 入口同样复用 requireAgentAccess(canAccessAgent)。
 */
export default function AgentPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [flags, setFlags] = useState<AgentUiFlags | null>(null);
  const [flagsLoaded, setFlagsLoaded] = useState(false);

  // Load UI flags from server (env -> booleans)
  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    async function loadFlags() {
      try {
        const res = await fetch("/api/agent/ui-config");
        if (!res.ok) throw new Error("Failed to load agent UI config");
        const data = (await res.json()) as AgentUiFlags;
        if (!cancelled) setFlags(data);
      } catch {
        // Fall back to defaults
        if (!cancelled) setFlags(DEFAULT_FLAGS);
      } finally {
        if (!cancelled) setFlagsLoaded(true);
      }
    }
    void loadFlags();
    return () => { cancelled = true; };
  }, [status]);

  // Redirect unauthenticated
  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace("/login");
    }
  }, [router, status]);

  // Session loading
  if (status === "loading") {
    return <LoadingShell />;
  }

  if (!session) return null;

  // Wait for flags + viewport determination before deciding
  // (prevents flashing desktop redirect on a mobile device)
  if (!flagsLoaded) {
    return <LoadingShell />;
  }

  const uiFlags = flags ?? DEFAULT_FLAGS;
  const role = session.user?.role;
  const adminBypass = isAdmin(role);

  // Desktop viewport: 内部员工（ADMIN/USER）渲染双栏 Workbench；
  // 销售角色（REPRESENTATIVE/REGIONAL_MANAGER）仍提示使用手机端。
  if (!isMobile) {
    if (isInternalStaff(role)) {
      return <AgentWorkbench genuiEnabled={uiFlags.genuiEnabled} asrEnabled={uiFlags.asrConfigured} />;
    }
    if (!adminBypass) {
      return (
        <DesktopNoticeShell
          message="Agent 当前仅支持手机端访问，请在手机上打开使用。"
          onBack={() => router.push("/dashboard")}
        />
      );
    }
  }

  if (!uiFlags.mobileEnabled && !adminBypass) {
    return <RedirectShell message="移动 Agent 暂未开放" onMount={() => router.replace("/crm")} />;
  }

  // 硬权限边界（始终生效，与 feature flag 无关）：
  // ADMIN/USER/REPRESENTATIVE/REGIONAL_MANAGER 可进。
  // 服务端 /api/agent/** 入口同样由 requireAgentAccess 复用 canAccessAgent。
  if (!canAccessAgent(role)) {
    return <RedirectShell message="Agent 暂未对你的角色开放" onMount={() => router.replace("/dashboard")} />;
  }

  return <AgentMobileShell genuiEnabled={uiFlags.genuiEnabled} asrEnabled={uiFlags.asrConfigured} />;
}

function LoadingShell() {
  return (
    <div className="flex h-[100dvh] items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

/** Renders a loading shell, fires a toast, then redirects on mount. */
function RedirectShell({ message, onMount }: { message: string; onMount: () => void }) {
  useEffect(() => {
    toast.message(message);
    onMount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <LoadingShell />;
}

/**
 * 桌面端说明页：不再瞬间 router.replace，避免移动壳在桌面误渲染、也避免页面闪烁。
 * 提供一个「返回工作台」按钮（onClick 跳转）。
 */
function DesktopNoticeShell({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Smartphone className="h-6 w-6 text-muted-foreground" />
        </div>
        <h1 className="mb-2 text-lg font-semibold">请使用手机访问 Agent</h1>
        <p className="mb-6 text-sm text-muted-foreground">{message}</p>
        <Button onClick={onBack}>返回工作台</Button>
      </div>
    </div>
  );
}
