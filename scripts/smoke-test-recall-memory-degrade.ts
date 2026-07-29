/**
 * recall_memory 降级子进程（由 smoke-test-recall-memory.ts [6] 调起）。
 *
 * 在 AGENT_VECTOR_BASE_URL=http://127.0.0.1:9（不可用）下，对父进程已建好的
 * 临时库（--db / --user / --prefix）跑一次 agent.recall_memory，断言：
 *  - degraded=true；
 *  - 仍按 activityScore 排序（财务项目 activityScore=99 应排第一）；
 *  - 至少返回 1 条候选。
 *
 * 独立进程以确保 vector.ts 的 60s health 缓存不影响主进程。
 *
 * 参数：--db <abs path> --user <userId> --prefix <PREFIX>
 */

import fs from "node:fs";
import path from "node:path";

function readArg(name: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0 || idx + 1 >= process.argv.length) {
    throw new Error(`missing required arg --${name}`);
  }
  return process.argv[idx + 1];
}

async function main() {
  const dbPath = readArg("db");
  const userId = readArg("user");
  const prefix = readArg("prefix");

  if (!fs.existsSync(dbPath)) {
    throw new Error(`db path does not exist: ${dbPath}`);
  }

  // 必须在 import @/lib/prisma 之前设 DATABASE_URL。
  process.env.DATABASE_URL = `file:${dbPath}`;
  // 父进程已设 AGENT_VECTOR_BASE_URL=http://127.0.0.1:9；这里只是显式记录。
  const vectorUrl = process.env.AGENT_VECTOR_BASE_URL || "(default)";
  console.log(`[degrade] db=${dbPath} user=${userId} vector=${vectorUrl}`);

  const { executeAgentAction } = await import("../src/lib/agent-actions/registry");

  const actor = {
    userId,
    role: "REPRESENTATIVE",
    name: "RepA",
    email: `degrade-${prefix}@test.local`,
  };

  const res = await executeAgentAction<{
    query: string;
    items: Array<{ entityId?: string; name?: string; score: number }>;
    total: number;
    degraded: boolean;
  // T9.1c：executeAgentAction 收 AgentExecutionContext（actor + invocation）
  }>({ actor, invocation: { channel: "agent" as const } }, "agent.recall_memory", { query: "单细胞测序项目进展", limit: 5 });

  const items = res.result.items;
  console.log(
    "[degrade] degraded=",
    res.result.degraded,
    " order:",
    items.map((i) => `${i.name ?? i.entityId}:${i.score.toFixed(3)}`).join(" > "),
  );

  let failed = 0;
  function check(cond: boolean, msg: string) {
    if (cond) {
      console.log(`  ✓ ${msg}`);
    } else {
      console.log(`  ✗ ${msg}`);
      failed++;
    }
  }

  check(res.result.degraded === true, "degraded=true（向量服务不可用）");
  check(items.length > 0, "降级路径仍返回候选");
  // 财务项目 activityScore=99 应排第一（降级按 activityScore 排序）。
  check(
    items[0]?.entityId === `${prefix}-proj-finance`,
    `财务项目（activityScore=99）排第一（实际第一：${items[0]?.entityId}）`,
  );

  if (failed > 0) {
    console.error(`[degrade] ${failed} checks failed`);
    process.exit(1);
  }
  console.log("[degrade] OK: degraded path works as expected");
}

void main().catch((err) => {
  console.error("[degrade] crashed:", err);
  process.exit(2);
});
