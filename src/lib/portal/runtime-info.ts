/**
 * Portal runtime info（设计文档 §2.2）。
 *
 * 把 Portal 运行时元信息集中暴露给 `/api/portal-info`，供部署 smoke test 断言：
 * - portalCode：当前构建/部署的 Portal。
 * - commit：构建版本（沿用现有 APP_BUILD_VERSION 机制；构建时由 next.config.ts 注入）。
 * - schemaVersion：Prisma schema 近似版本。
 * - runScheduledJobs：当前实例是否承担定时任务（PORTAL_RUN_SCHEDULED_JOBS）。
 *
 * schemaVersion 取舍说明：
 * - 仓库使用 `prisma db push`（无 migrations lock 文件），不存在单一权威 schema 版本号。
 * - 这里采用「Prisma client 版本 + schema 内容 sha256 前 12 位」作为近似指纹：
 *   两个 Portal 从同一 commit 构建时该值必须一致；schema 变化时指纹随之变化。
 * - 该值在构建期由 `scripts/generate-schema-version.mjs` 写入
 *   `src/lib/portal/.schema-version.txt`，再由 next.config.ts 经 env
 *   `SCHEMA_VERSION_FINGERPRINT` 内联到运行时（仅服务端，不进客户端 bundle）。
 *   若生成文件缺失（如本地未运行该脚本），回退为运行时读取的 prisma client 版本，
 *   保证 smoke 仍可比对（同 commit 仍一致）。
 */

import { Prisma } from "@prisma/client";
import { getServerPortalConfig } from "./config";

function runtimeSchemaVersionFallback(): string {
  // 仅在构建期指纹缺失时使用。读取运行时 Prisma client 版本；同 commit 构建一致。
  const clientVersion = Prisma.prismaVersion?.client ?? "unknown";
  return `prisma-client:${clientVersion}`;
}

export type RuntimeInfo = {
  portalCode: string;
  commit: string;
  schemaVersion: string;
  runScheduledJobs: boolean;
  displayName: string;
};

export function getRuntimeInfo(): RuntimeInfo {
  const config = getServerPortalConfig();
  const commit =
    process.env.NEXT_PUBLIC_APP_BUILD_VERSION ?? "development";
  const envFingerprint = process.env.SCHEMA_VERSION_FINGERPRINT;
  const schemaVersion =
    typeof envFingerprint === "string" && envFingerprint.length > 0
      ? envFingerprint
      : runtimeSchemaVersionFallback();
  return {
    portalCode: config.code,
    displayName: config.displayName,
    commit,
    schemaVersion,
    runScheduledJobs: config.runScheduledJobs,
  };
}
