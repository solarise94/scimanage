/**
 * 根布局门户准入门闩（设计 §2.4）。
 *
 * 已登录且非 ADMIN 时，校验 session.department 与当前 PORTAL_CODE 一致。
 * 未登录（登录页等）放行，由页面自身处理认证。
 * 拒绝时渲染明确 403 文案（PortalAccessDeniedError），并提供退出入口，避免卡死。
 */
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { PortalAccessDeniedError } from "@/lib/application/errors";
import { assertPortalAccess } from "@/lib/portal/guard";
import { getServerPortalConfig } from "@/lib/portal/config";
import { PortalSignOutLink } from "@/components/portal-signout-link";

export async function PortalAccessGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !session.user.role) {
    return <>{children}</>;
  }

  // 先计算准入结果，再在 try/catch 外渲染 JSX（react-hooks/error-boundaries）。
  let deniedMessage: string | null = null;
  try {
    assertPortalAccess({
      user: {
        id: session.user.id,
        role: session.user.role,
        department: session.user.department || "",
      },
    });
  } catch (err) {
    const config = getServerPortalConfig();
    deniedMessage =
      err instanceof PortalAccessDeniedError
        ? err.message
        : `当前账号无权访问 ${config.displayName} 门户`;
  }

  if (deniedMessage === null) {
    return <>{children}</>;
  }

  return (
    <main className="flex min-h-[100dvh] w-full flex-col items-center justify-center gap-3 bg-background px-6 text-center">
      <h1 className="text-xl font-semibold text-foreground">无权访问此门户</h1>
      <p className="max-w-md text-sm text-muted-foreground">{deniedMessage}</p>
      <p className="text-xs text-muted-foreground">
        请使用与账号部门匹配的门户入口，或联系管理员调整部门。
      </p>
      <PortalSignOutLink />
    </main>
  );
}
