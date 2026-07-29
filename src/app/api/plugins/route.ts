import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { listPlugins } from "@/lib/plugins/registry";
import { isDraftAIConfigured, isAnyAsrConfigured } from "@/lib/draft/providers";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const plugins = await listPlugins();
  // 与 ui-config 一致：本地 ASR 就绪或腾讯云已配置，capabilities.asr 都算可用。
  const asrReady = await isAnyAsrConfigured();
  return NextResponse.json({
    plugins,
    capabilities: {
      ai: isDraftAIConfigured(),
      asr: asrReady,
    },
  });
}
