/**
 * 定时任务/后台 worker 唯一 owner 开关测试（设计 §2.6）。
 *
 * PORTAL_RUN_SCHEDULED_JOBS=false 时，进程内 AgentBackgroundJob worker 不应启动
 * （避免 ONLINE_OPS 副实例与主实例对同一共享 DB 产生重复 claim）。
 * 该开关与 systemd timer owner 一致，由 deploy-portals-prod.sh 协调。
 *
 * 不依赖数据库：isWorkerEnabled 在 setInterval 之前提前返回，不会触发 Prisma。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("PORTAL_RUN_SCHEDULED_JOBS 开关（§2.6 唯一 owner）", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("PORTAL_RUN_SCHEDULED_JOBS=false：worker 不启动", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PORTAL_RUN_SCHEDULED_JOBS", "false");
    // 显式未设 AGENT_JOB_WORKER_ENABLED（走默认 production 分支 + portal gate）
    delete process.env.AGENT_JOB_WORKER_ENABLED;
    const { startAgentBackgroundWorker, getWorkerState, stopAgentBackgroundWorker } =
      await import("@/lib/agent-background-worker");
    startAgentBackgroundWorker();
    const state = getWorkerState();
    expect(state.workerId).toBeNull();
    stopAgentBackgroundWorker();
  });

  it("PORTAL_RUN_SCHEDULED_JOBS=true（默认主实例）：worker 启动（production）", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PORTAL_RUN_SCHEDULED_JOBS", "true");
    delete process.env.AGENT_JOB_WORKER_ENABLED;
    const { startAgentBackgroundWorker, getWorkerState, stopAgentBackgroundWorker } =
      await import("@/lib/agent-background-worker");
    startAgentBackgroundWorker();
    const state = getWorkerState();
    expect(state.workerId).not.toBeNull();
    stopAgentBackgroundWorker();
  });

  it("AGENT_JOB_WORKER_ENABLED=true 显式覆盖（即使 PORTAL_RUN_SCHEDULED_JOBS=false）", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PORTAL_RUN_SCHEDULED_JOBS", "false");
    vi.stubEnv("AGENT_JOB_WORKER_ENABLED", "true");
    const { startAgentBackgroundWorker, getWorkerState, stopAgentBackgroundWorker } =
      await import("@/lib/agent-background-worker");
    startAgentBackgroundWorker();
    const state = getWorkerState();
    expect(state.workerId).not.toBeNull();
    stopAgentBackgroundWorker();
  });
});
