import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getAgentUiConfig } from "@/lib/server-ui-config";
import { isAnyAsrConfigured } from "@/lib/draft/providers";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";

/**
 * Returns agent UI feature flags as booleans.
 *
 * The flags are read from server-side env vars (via getAgentUiConfig) and
 * returned as plain booleans so client components never touch private env.
 * Requires authentication (401 if no session).
 *
 * asrConfigured 用 isAnyAsrConfigured()：当前默认仅腾讯云已配置算可用，
 * 前端看到可用才展示录音按钮。
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = requireAgentAccess(session);
  if (denied) return denied;

  const config = getAgentUiConfig();
  const asrConfigured = await isAnyAsrConfigured();
  return NextResponse.json({
    ...config,
    asrConfigured,
  });
}
