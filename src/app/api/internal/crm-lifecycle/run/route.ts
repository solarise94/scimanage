import { NextRequest, NextResponse } from "next/server";
import { scanDormantCrmProfiles } from "@/lib/crm/lifecycle";

export async function POST(req: NextRequest) {
  const token = process.env.CRM_LIFECYCLE_CRON_TOKEN
    || process.env.CRM_REVIEW_CRON_TOKEN
    || process.env.REMINDER_CRON_TOKEN;

  if (!token) {
    console.error("[CRON][CRM-LIFECYCLE] No token configured");
    return NextResponse.json({ ok: false, error: "CRM lifecycle cron token not configured" }, { status: 500 });
  }

  const auth = req.headers.get("authorization");
  const expected = `Bearer ${token}`;
  if (!auth || auth !== expected) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await scanDormantCrmProfiles();
    console.log(
      `[CRON][CRM-LIFECYCLE] scanned=${result.scannedCount} warned=${result.warnedCount} dormant=${result.dormantCount}`,
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "未知错误";
    console.error("[CRON][CRM-LIFECYCLE] Failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
