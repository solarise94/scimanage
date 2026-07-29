import { NextResponse } from "next/server";
import { getRuntimeInfo } from "@/lib/portal/runtime-info";

/**
 * Portal 运行时信息端点（设计文档 §2.2）。
 *
 * 供部署 smoke test 断言 portalCode + commit + schemaVersion 一致。
 * 风格对齐 /api/build-version：无需认证、no-store，部署后立即可探测。
 *
 * 取舍说明：仓库已存在一个受限的 /api/runtime-info 调试端点（ADMIN +
 * x-runtime-debug header，返回 DB 路径等敏感诊断信息，src/lib/runtime-info.ts）。
 * 设计 §2.2 需要的是无需认证、可被部署 smoke 直接 curl 的 portal 元信息；
 * 为避免改动既有受限诊断端点（破坏其安全姿态）或与可能并行修改它的任务冲突，
 * 这里另起公开只读端点 /api/portal-info，只返回部署 smoke 所需的非敏感字段，
 * 不包含任何凭据、内部 token、数据库路径。
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const info = getRuntimeInfo();
  return NextResponse.json(info, {
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}
