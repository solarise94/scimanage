/**
 * Next.js Instrumentation hook（进程级，在服务端 boot 时执行一次）。
 *
 * 在 Node.js runtime 下拉起进程内后台 Job worker（首版 SQLite 单消费者）。
 * - 仅 `NEXT_RUNTIME === "nodejs"` 时执行（edge runtime 无 Prisma）。
 * - 受 env `AGENT_JOB_WORKER_ENABLED` 控制（默认 production 启用）。
 * - 失败永不 crash boot：所有错误吞掉并记录。
 * - P2-2 parity 断言（manifest↔facade↔action registry）挂在
 *   `ensureBuiltinAgentActionsRegistered`（registry.ts）：本文件会被 edge bundle
 *   静态跟随动态 import 的 actions barrel（→ nodemailer → node builtins），
 *   导致 dev edge 编译失败；registry 只在 nodejs 上下文被调用，天然安全。
 *
 * 见 src/lib/agent-background-worker.ts 顶部的设计说明。
 */

export async function register(): Promise<void> {
  // edge runtime 下不启动。
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  try {
    const { startAgentBackgroundWorker } = await import(
      "@/lib/agent-background-worker"
    );
    startAgentBackgroundWorker();
  } catch (err) {
    console.error(
      "[instrumentation] failed to start agent background worker:",
      err instanceof Error ? err.message : err,
    );
  }
}
