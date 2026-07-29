import { NextRequest, NextResponse } from "next/server";
import { runAgentDreamCycle } from "@/lib/agent-runtime/dream";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 夜间梦境整理（dream cycle）内部 cron 入口。
 *
 * 鉴权：env AGENT_DREAM_CRON_TOKEN（缺失时回退到 CRM_LIFECYCLE / CRM_REVIEW / REMINDER token）。
 * 照抄 crm-lifecycle route 的鉴权与异常处理惯例。
 */
export async function POST(req: NextRequest) {
  const token =
    process.env.AGENT_DREAM_CRON_TOKEN ||
    process.env.CRM_LIFECYCLE_CRON_TOKEN ||
    process.env.CRM_REVIEW_CRON_TOKEN ||
    process.env.REMINDER_CRON_TOKEN;

  if (!token) {
    console.error("[CRON][AGENT-DREAM] No token configured");
    return NextResponse.json(
      { ok: false, error: "Agent dream cron token not configured" },
      { status: 500 },
    );
  }

  const auth = req.headers.get("authorization");
  const expected = `Bearer ${token}`;
  if (!auth || auth !== expected) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    // 支持可选 body { compactSessions?: boolean, entityUserLimit?: number }；
    // 空 body / 非法 body 时使用默认值（systemd oneshot curl 不带 body）。
    const opts: { compactSessions?: boolean; entityUserLimit?: number } = {};
    try {
      const body = await req.json();
      if (body && typeof body === "object") {
        if (typeof body.compactSessions === "boolean") {
          opts.compactSessions = body.compactSessions;
        }
        if (typeof body.entityUserLimit === "number" && Number.isFinite(body.entityUserLimit)) {
          opts.entityUserLimit = Math.max(0, Math.floor(body.entityUserLimit));
        }
      }
    } catch {
      // 无 body 或非 JSON：使用默认值。
    }

    const stats = await runAgentDreamCycle(opts);
    console.log(
      `[CRON][AGENT-DREAM] users=${stats.usersProcessed} entUp=${stats.entityUpserted} decay=${stats.memoryDecayed} merge=${stats.memoryMerged} compact=${stats.sessionsCompacted} errs=${stats.errors.length}`,
    );
    return NextResponse.json({ ok: true, stats });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "未知错误";
    console.error("[CRON][AGENT-DREAM] Failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
