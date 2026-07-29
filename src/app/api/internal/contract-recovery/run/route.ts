import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { recoverPendingContractFiles } from "@/lib/contracts/application/recover-contract-file";

/**
 * 合同 PENDING_FILE 恢复 + 孤儿清理。
 *
 * 认证方式（二选一）：
 * - Bearer token: 与 REMINDER_CRON_TOKEN 共用，用于 systemd timer 调用
 * - ADMIN session: 用于手动触发
 *
 * T8.3 起走 canonical application service（含审计日志）。
 */
export async function POST(req: NextRequest) {
  // 先尝试 cron token
  const cronToken = process.env.REMINDER_CRON_TOKEN;
  const auth = req.headers.get("authorization");
  const isCron = cronToken && auth === `Bearer ${cronToken}`;

  let invokedBy = "system";
  if (!isCron) {
    // 非 cron 调用需要 ADMIN session
    const session = await getServerSession(authOptions);
    if (!session || session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    invokedBy = session.user.id;
  }

  try {
    const result = await recoverPendingContractFiles({ invokedBy });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[contract-recovery] failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown" },
      { status: 500 },
    );
  }
}
