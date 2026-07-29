import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Every production build gets a distinct identifier, including deployments
// built from a dirty worktree at the same Git commit.  The client uses it to
// detect tabs that survived a deployment and reload them before they can call
// APIs with an obsolete contract.
const appBuildVersion = process.env.APP_BUILD_VERSION ?? `${Date.now()}`;

// Schema 版本指纹（设计 §2.2）：由 prebuild 脚本生成。同 commit 双 Portal 构建时
// 该值一致，供 /api/portal-info 与部署 smoke 断言。文件缺失时回退 null，运行时
// 再回退到 @prisma/client 版本（仍保证同 commit 一致）。
let schemaVersionFingerprint: string | null = null;
try {
  schemaVersionFingerprint = readFileSync(
    resolve(process.cwd(), "src/lib/portal/.schema-version.txt"),
    "utf8",
  ).trim();
} catch {
  // prebuild 未运行（如 dev 直接 next dev）；运行时回退。
}

const nextConfig: NextConfig = {
  output: "standalone",
  generateBuildId: async () => appBuildVersion,
  env: {
    NEXT_PUBLIC_APP_BUILD_VERSION: appBuildVersion,
    // 仅服务端读取（不带 NEXT_PUBLIC_ 前缀，不会泄露到客户端 bundle）。
    SCHEMA_VERSION_FINGERPRINT: schemaVersionFingerprint ?? "",
    // 客户端 Portal code（设计 §2.3）：用于 Sidebar 等客户端组件按 capability 隐藏
    // 不属于本门户的入口。产品表面隔离；API 权限仍由 assertPortalAccess + 部门校验保证。
    NEXT_PUBLIC_PORTAL_CODE: process.env.PORTAL_CODE ?? "",
  },
  async redirects() {
    return [
      {
        source: "/finance/project-receivables",
        destination: "/finance/order-receivables",
        permanent: true,
      },
      {
        source: "/orders/import/pingoodmice",
        destination: "/orders/import?source=PINGOODMICE",
        permanent: true,
      },
    ];
  },
  serverExternalPackages: ["@prisma/client", "prisma"],
  // dev(webpack) 下 instrumentation.ts 会被 edge runtime target（日志前缀 [browser]）
  // 编译，并静态跟随 register() 内动态 import 的 nodejs-only 链（agent-background-worker
  // → crypto/path、actions barrel → nodemailer/stream）。这些链只在
  // NEXT_RUNTIME==="nodejs" 守卫后执行，edge 永远不会运行到——把 node builtins shim
  // 为空模块让 edge 编译通过。不影响 nodejs target 与 Turbopack 生产构建（忽略本字段）。
  webpack: (config, { nextRuntime, webpack }) => {
    if (nextRuntime === "edge") {
      const shimmed = [
        "crypto", "path", "stream", "fs", "os", "net", "tls", "dns", "zlib",
        "node:crypto", "node:path", "node:stream", "node:fs", "node:os",
        "node:net", "node:tls", "node:dns", "node:zlib",
      ];
      const fallback = { ...(config.resolve.fallback ?? {}) } as Record<string, unknown>;
      for (const name of shimmed) {
        if (!(name in fallback)) fallback[name] = false;
      }
      config.resolve.fallback = fallback;
      // node: 前缀在 web/webworker target 下先抛 UnhandledSchemeError（早于 fallback），
      // 统一改写成裸名让上面的 fallback 接管。
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource: { request: string }) => {
          resource.request = resource.request.replace(/^node:/, "");
        }),
      );
    }
    return config;
  },
  images: {
    unoptimized: true,
  },
  outputFileTracingExcludes: {
    "*": [
      "CLAUDE.md", "AGENTS.md", "README.md",
      "docs/**", "scripts/**", "prisma/**",
      "dev.db", "components.json", "eslint.config.mjs",
      ".draft-media/**",
      ".invoice-staging/**",
      "*.conf",
    ],
  },
  // Keep standalone output rooted at this repository. Without this, an
  // unrelated parent package-lock can make Turbopack nest server.js under the
  // workspace path, while the production systemd unit expects it at the
  // standalone root.
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
