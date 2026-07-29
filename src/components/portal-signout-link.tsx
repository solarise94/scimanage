"use client";

import { signOut } from "next-auth/react";

/**
 * PortalAccessGate 拒绝页的退出入口（客户端组件）。
 * 与侧边栏一致走 next-auth/react signOut，避免直链 /api/auth/signout。
 */
export function PortalSignOutLink() {
  return (
    <button
      type="button"
      onClick={() => signOut({ callbackUrl: "/login" })}
      className="mt-2 cursor-pointer text-sm font-medium text-primary underline underline-offset-4"
    >
      退出并重新登录
    </button>
  );
}
