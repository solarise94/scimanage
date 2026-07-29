/**
 * NextAuth cookie 名按 Portal 隔离（设计文档 §2.4 方案 2）。
 *
 * 背景：同一 hostname 不同端口跑双门户（31080 FIELD_SALES / 32080 ONLINE_OPS）时，
 * HTTP Cookie 不区分端口，NextAuth 默认 cookie 名会互相覆盖，导致用户在两个门户间
 * 切换时反复掉线。
 *
 * 方案：按 PORTAL_CODE 派生 cookie 名前缀。
 *
 * 取舍说明：
 * - `__Host-` 前缀要求 Secure + Path=/ + 无 Domain。生产 HTTPS 下使用 `__Host-` 可获得
 *   最强隔离；但本地 dev（http）不能使用 `__Host-`（浏览器会丢弃），故 dev 用非
 *   `__Host-` 名（仍带 portal 前缀，隔离不丢）。
 * - 默认（开发环境未设 PORTAL_CODE）保持 NextAuth 原生 cookie 名不变，避免破坏现有
 *   单门户 dev session。
 * - 生产环境（NODE_ENV=production）即使未设 PORTAL_CODE 也不应静默回退到默认名：
 *   生产必须显式设 PORTAL_CODE（config.ts 已在缺失时启动失败），这里跟随同一约束。
 *
 * 该函数返回 NextAuth 的 `cookies` 配置（partial），仅覆盖需要的 4 个 cookie。
 * 调用方在 authOptions.cookies 中与默认值合并即可。
 */

import type { NextAuthOptions } from "next-auth";
import { PORTAL_CODES, type PortalCode, getServerPortalConfig } from "./config";

type CookieOption = NonNullable<
  NonNullable<NextAuthOptions["cookies"]>[keyof NonNullable<NextAuthOptions["cookies"]>]
>;

const DEFAULT_COOKIE_NAMES = {
  sessionToken: "next-auth.session-token",
  csrfToken: "next-auth.csrf-token",
  callbackUrl: "next-auth.callback-url",
  pkceCodeVerifier: "next-auth.pkce.code_verifier",
} as const;

/**
 * 为指定 Portal 派生 cookie 名。
 *
 * 生产（secure）：使用 `__Host-scimanage-<code>-<cookie>` 形式。
 * 非生产（http）：使用 `scimanage-<code>-<cookie>` 形式（无 __Host- 前缀）。
 *
 * 导出以便单元测试（不依赖 env）。
 */
export function portalCookieNames(
  portalCode: PortalCode,
  secure: boolean,
): Record<keyof typeof DEFAULT_COOKIE_NAMES, string> {
  // PortalCode 含下划线（ONLINE_OPS）；cookie 名用连字符 slug 以保证可读且无歧义。
  const slug = portalCode.toLowerCase().replace(/_/g, "-");
  const prefix = secure
    ? `__Host-scimanage-${slug}-`
    : `scimanage-${slug}-`;
  return {
    sessionToken: `${prefix}${DEFAULT_COOKIE_NAMES.sessionToken}`,
    csrfToken: `${prefix}${DEFAULT_COOKIE_NAMES.csrfToken}`,
    callbackUrl: `${prefix}${DEFAULT_COOKIE_NAMES.callbackUrl}`,
    pkceCodeVerifier: `${prefix}${DEFAULT_COOKIE_NAMES.pkceCodeVerifier}`,
  };
}

/**
 * 构建 NextAuth cookies 配置（partial），按当前 Portal 隔离 cookie 名。
 *
 * - 生产环境：secure 名（__Host- 前缀）。
 * - 开发环境且未设 PORTAL_CODE：返回 undefined（保留 NextAuth 默认，不破坏现有 session）。
 * - 开发环境且设了 PORTAL_CODE：非 secure 名（仍隔离）。
 */
export function buildPortalAuthCookies(): NextAuthOptions["cookies"] | undefined {
  const isProduction = process.env.NODE_ENV === "production";
  const code = process.env.PORTAL_CODE;

  // 开发环境未设 PORTAL_CODE：保持默认 cookie 名，不破坏现有单门户 dev session。
  if (!isProduction && (!code || !(PORTAL_CODES as readonly string[]).includes(code))) {
    return undefined;
  }

  // 生产环境必须显式设 PORTAL_CODE；config.ts 在缺失时已启动失败，
  // 这里走 getServerPortalConfig 拿到规范化 code。
  const config = getServerPortalConfig();

  // secure 判定：生产默认 true；显式 NEXTAUTH_URL=http 可覆盖（仅本地 TLS offload 测试）。
  const secure =
    isProduction && !/^http:\/\//i.test(process.env.NEXTAUTH_URL ?? "");

  const names = portalCookieNames(config.code, secure);

  // __Host- 前缀要求 Path=/ 且无 Domain；非 __Host- 仍设 Path=/。
  const baseOptions = {
    path: "/",
    sameSite: "lax" as const,
    secure,
  };

  const cookies: Required<Pick<
    NonNullable<NextAuthOptions["cookies"]>,
    "sessionToken" | "csrfToken" | "callbackUrl" | "pkceCodeVerifier"
  >> = {
    sessionToken: {
      name: names.sessionToken,
      options: baseOptions,
    },
    csrfToken: {
      name: names.csrfToken,
      options: baseOptions,
    },
    callbackUrl: {
      name: names.callbackUrl,
      options: baseOptions,
    },
    pkceCodeVerifier: {
      name: names.pkceCodeVerifier,
      options: {
        path: "/",
        secure,
        sameSite: "lax" as const,
        httpOnly: true,
      },
    },
  };

  return cookies;
}

/** 仅供测试：暴露 baseOptions 形状校验。 */
export type PortalCookieOption = CookieOption;
