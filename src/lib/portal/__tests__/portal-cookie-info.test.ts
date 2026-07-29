/**
 * Portal cookie 隔离 + portal-info 单元测试（设计 §2.2 / §2.4）。
 *
 * 这些测试不触碰数据库，只验证按 PORTAL_CODE 派生的 cookie 名与 runtime-info 字段。
 * env 在 fork worker 间隔离；通过 vi.stubEnv 注入。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// portal config 缓存了 _cachedConfig，每个测试需要清掉缓存才能反映新 env。
function clearPortalConfigCache() {
  // 直接重置模块状态：portal config 用了模块级 _cachedConfig。
  vi.resetModules();
}

describe("portal cookie 名称派生（§2.4 方案 2）", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    clearPortalConfigCache();
  });

  it("生产 secure：ONLINE_OPS 与 FIELD_SALES cookie 名不同且带 __Host- 前缀", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PORTAL_CODE", "ONLINE_OPS");
    const { portalCookieNames } = await import("@/lib/portal/auth-cookies");
    const online = portalCookieNames("ONLINE_OPS", true);
    const field = portalCookieNames("FIELD_SALES", true);
    expect(online.sessionToken).toBe("__Host-scimanage-online-ops-next-auth.session-token");
    expect(field.sessionToken).toBe("__Host-scimanage-field-sales-next-auth.session-token");
    expect(online.sessionToken).not.toBe(field.sessionToken);
    expect(online.csrfToken).not.toBe(field.csrfToken);
  });

  it("非 secure（本地 http dev）：不带 __Host- 前缀，仍带 portal 前缀", async () => {
    const { portalCookieNames } = await import("@/lib/portal/auth-cookies");
    const online = portalCookieNames("ONLINE_OPS", false);
    expect(online.sessionToken).toBe("scimanage-online-ops-next-auth.session-token");
    expect(online.callbackUrl).toBe("scimanage-online-ops-next-auth.callback-url");
  });

  it("开发环境未设 PORTAL_CODE：buildPortalAuthCookies 返回 undefined（保持默认 cookie）", async () => {
    vi.stubEnv("NODE_ENV", "development");
    delete process.env.PORTAL_CODE;
    const { buildPortalAuthCookies } = await import("@/lib/portal/auth-cookies");
    expect(buildPortalAuthCookies()).toBeUndefined();
  });

  it("生产环境设 PORTAL_CODE=ONLINE_OPS：返回 secure cookie 配置", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PORTAL_CODE", "ONLINE_OPS");
    const { buildPortalAuthCookies } = await import("@/lib/portal/auth-cookies");
    const cookies = buildPortalAuthCookies();
    expect(cookies).toBeDefined();
    const sessionToken = cookies!.sessionToken!;
    expect(sessionToken.name).toBe(
      "__Host-scimanage-online-ops-next-auth.session-token",
    );
    expect(sessionToken.options.secure).toBe(true);
    expect(sessionToken.options.path).toBe("/");
  });

  it("生产环境 NEXTAUTH_URL=http：secure=false（本地 TLS offload 测试场景）", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PORTAL_CODE", "FIELD_SALES");
    vi.stubEnv("NEXTAUTH_URL", "http://127.0.0.1:31081");
    const { buildPortalAuthCookies } = await import("@/lib/portal/auth-cookies");
    const cookies = buildPortalAuthCookies();
    const sessionToken = cookies!.sessionToken!;
    expect(sessionToken.options.secure).toBe(false);
    expect(sessionToken.name).toBe(
      "scimanage-field-sales-next-auth.session-token",
    );
  });
});

describe("getRuntimeInfo（§2.2）", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    clearPortalConfigCache();
  });

  it("ONLINE_OPS Portal 返回正确 portalCode + runScheduledJobs=false", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PORTAL_CODE", "ONLINE_OPS");
    vi.stubEnv("PORTAL_RUN_SCHEDULED_JOBS", "false");
    vi.stubEnv("NEXT_PUBLIC_APP_BUILD_VERSION", "abc123");
    vi.stubEnv("SCHEMA_VERSION_FINGERPRINT", "prisma-client:5.22.0:schema:deadbeef");
    const { getRuntimeInfo } = await import("@/lib/portal/runtime-info");
    const info = getRuntimeInfo();
    expect(info.portalCode).toBe("ONLINE_OPS");
    expect(info.commit).toBe("abc123");
    expect(info.schemaVersion).toBe("prisma-client:5.22.0:schema:deadbeef");
    expect(info.runScheduledJobs).toBe(false);
  });

  it("FIELD_SALES Portal 返回 runScheduledJobs=true（默认）", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PORTAL_CODE", "FIELD_SALES");
    vi.stubEnv("PORTAL_RUN_SCHEDULED_JOBS", "true");
    const { getRuntimeInfo } = await import("@/lib/portal/runtime-info");
    const info = getRuntimeInfo();
    expect(info.portalCode).toBe("FIELD_SALES");
    expect(info.runScheduledJobs).toBe(true);
  });

  it("两 Portal 同 commit 同 schemaVersion 应相等（smoke 断言基础）", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SCHEMA_VERSION_FINGERPRINT", "shared-schema-fingerprint");
    vi.stubEnv("NEXT_PUBLIC_APP_BUILD_VERSION", "shared-commit");

    vi.stubEnv("PORTAL_CODE", "FIELD_SALES");
    const { getRuntimeInfo: getField } = await import("@/lib/portal/runtime-info");
    const field = getField();

    clearPortalConfigCache();
    vi.stubEnv("PORTAL_CODE", "ONLINE_OPS");
    const { getRuntimeInfo: getOnline } = await import("@/lib/portal/runtime-info");
    const online = getOnline();

    expect(field.commit).toBe(online.commit);
    expect(field.schemaVersion).toBe(online.schemaVersion);
    expect(field.portalCode).not.toBe(online.portalCode);
  });

  it("SCHEMA_VERSION_FINGERPRINT 缺失时回退到 prisma client 版本（仍非空）", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PORTAL_CODE", "FIELD_SALES");
    delete process.env.SCHEMA_VERSION_FINGERPRINT;
    const { getRuntimeInfo } = await import("@/lib/portal/runtime-info");
    const info = getRuntimeInfo();
    expect(info.schemaVersion).toMatch(/^prisma-client:/);
  });
});
