import { NextRequest, NextResponse } from "next/server";
import { runAllReminders } from "@/lib/reminder";

export async function POST(req: NextRequest) {
  const token = process.env.REMINDER_CRON_TOKEN;

  if (!token) {
    console.error("[REMINDER][API] REMINDER_CRON_TOKEN not configured");
    return NextResponse.json({ ok: false, error: "REMINDER_CRON_TOKEN not configured on server" }, { status: 500 });
  }

  const auth = req.headers.get("authorization");
  const expected = `Bearer ${token}`;

  if (!auth || auth !== expected) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runAllReminders();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "未知错误";
    console.error("[REMINDER][API] runAllReminders failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
