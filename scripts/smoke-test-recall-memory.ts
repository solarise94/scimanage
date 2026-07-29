/**
 * 梦境记忆 D3 `agent.recall_memory` 向量召回 smoke（DB 集成，withTempSmokeDb）。
 *
 * 前提：smoke 机 TEI（127.0.0.1:8103）在线；用真实 embedTexts 给种子实体的
 * summary 编码并写入 embeddingBytes，从而能稳定断言「语义排序」。
 *
 * 覆盖：
 *  1. 语义排序：query「单细胞测序项目进展」→ 相关项目实体排第一（score 明显高于无关实体）。
 *  2. scope 隔离：用户 B 的实体不出现在用户 A 的召回结果。
 *  3. entityType 过滤：entityType=customer 只返回客户实体。
 *  4. limit clamp：limit=50 → 10。
 *  5. ARCHIVED 实体不被召回。
 *  6. 降级：独立子进程 + AGENT_VECTOR_BASE_URL=http://127.0.0.1:9（不可用）
 *     → degraded=true，仍按 activityScore 返回候选。
 *
 * 运行: npx tsx scripts/smoke-test-recall-memory.ts
 */

import { withTempSmokeDb } from "./lib/temp-smoke-db";
import { spawnSync } from "node:child_process";
import path from "node:path";

const PREFIX = `SMK-RM-${Date.now().toString(36)}`;
let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    pass++;
  } else {
    console.log(`  ✗ ${msg}`);
    fail++;
  }
}

function assertEq<T>(actual: T, expected: T, msg: string) {
  assert(
    actual === expected,
    `${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`,
  );
}

async function main() {
  console.log("=== agent.recall_memory 向量召回 smoke ===\n");

  await withTempSmokeDb(async (handle) => {
    handle.assertSafePath();

    const { prisma } = await import("../src/lib/prisma");
    const { executeAgentAction } = await import("../src/lib/agent-actions/registry");
    const { embedTexts, encodeEmbedding } = await import(
      "../src/lib/agent-runtime/vector"
    );

    // ── 公共 REP 用户 A + 用户 B ────────────────────────────────────────────
    const userA = await prisma.user.create({
      data: {
        email: `${PREFIX}-rep-a@test.local`,
        name: "RepA",
        password: "x",
        role: "REPRESENTATIVE",
      },
    });
    const userB = await prisma.user.create({
      data: {
        email: `${PREFIX}-rep-b@test.local`,
        name: "RepB",
        password: "x",
        role: "REPRESENTATIVE",
      },
    });

    const actorA = {
      userId: userA.id,
      role: "REPRESENTATIVE",
      name: "RepA",
      email: userA.email,
    };
    // T9.1c：executeAgentAction 收 AgentExecutionContext（actor + invocation）
    const ctxA = { actor: actorA, invocation: { channel: "agent" as const } };

    // ── 用真实 TEI 给 summary 编码 ──────────────────────────────────────────
    // A 的 3 条实体：单细胞测序（相关）、财务报表（无关）、王晓明客户（无关但语义接近「客户」）。
    // B 的 1 条实体：单细胞竞品（用于 scope 隔离断言——不应出现在 A 的召回里）。
    const summariesA = [
      "单细胞测序项目进展：已完成样本制备，正在做生信分析",
      "季度财务报表整理与发票核对",
      "王晓明客户：偏好 Excel 导出，关注交付周期",
    ];
    const summaryB = "单细胞测序竞品分析报告";

    const allTexts = [...summariesA, summaryB];
    const embeddings = await embedTexts(allTexts);
    if (!embeddings || embeddings.length !== allTexts.length) {
      console.error("TEI embed 失败，无法继续语义排序断言。请确认 127.0.0.1:8103 在线。");
      process.exit(2);
    }
    const embA = embeddings.slice(0, summariesA.length);
    const embB = embeddings[summariesA.length];

    // 建 4 条 AgentEntityMemory（status ACTIVE，有 embeddingBytes）。
    const now = Date.now();
    const daysAgo = (d: number) => new Date(now - d * 24 * 60 * 60 * 1000);

    const entityDefs: Array<{
      userId: string;
      entityType: "project" | "customer";
      entityId: string;
      name: string;
      summary: string;
      embedding: number[];
      activityScore: number;
      lastActiveAt: Date;
      status: string;
    }> = [
      {
        userId: userA.id,
        entityType: "project",
        entityId: `${PREFIX}-proj-scrna`,
        name: "单细胞测序项目",
        summary: summariesA[0],
        embedding: embA[0],
        activityScore: 5.0,
        lastActiveAt: daysAgo(2),
        status: "ACTIVE",
      },
      {
        userId: userA.id,
        entityType: "project",
        entityId: `${PREFIX}-proj-finance`,
        name: "财务报表项目",
        summary: summariesA[1],
        embedding: embA[1],
        activityScore: 8.0, // 故意比单细胞高，验证语义排序压过 activityScore
        lastActiveAt: daysAgo(1),
        status: "ACTIVE",
      },
      {
        userId: userA.id,
        entityType: "customer",
        entityId: `${PREFIX}-cust-wang`,
        name: "王晓明",
        summary: summariesA[2],
        embedding: embA[2],
        activityScore: 3.0,
        lastActiveAt: daysAgo(5),
        status: "ACTIVE",
      },
      {
        userId: userB.id,
        entityType: "project",
        entityId: `${PREFIX}-proj-b-scrna`,
        name: "B 的单细胞竞品项目",
        summary: summaryB,
        embedding: embB,
        activityScore: 9.0,
        lastActiveAt: daysAgo(0),
        status: "ACTIVE",
      },
    ];

    for (const def of entityDefs) {
      await prisma.agentEntityMemory.create({
        data: {
          userId: def.userId,
          entityType: def.entityType,
          entityId: def.entityId,
          name: def.name,
          summary: def.summary,
          activityScore: def.activityScore,
          lastActiveAt: def.lastActiveAt,
          embeddingBytes: encodeEmbedding(def.embedding),
          status: def.status,
        },
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // [1] 语义排序：query「单细胞测序项目进展」→ 单细胞实体排第一
    // ════════════════════════════════════════════════════════════════════════
    console.log("[1] 语义排序：相关项目实体 score 显著高于无关实体");
    {
      const res = await executeAgentAction<{
        query: string;
        items: Array<{ source: string; entityId?: string; name?: string; score: number }>;
        total: number;
        degraded: boolean;
      }>(ctxA, "agent.recall_memory", { query: "单细胞测序项目进展", limit: 5 });
      const items = res.result.items;
      console.log(
        "    order:",
        items.map((i) => `${i.name ?? i.entityId}:${i.score.toFixed(3)}`).join(" > "),
      );
      assertEq(res.result.degraded, false, "[1] 未降级（TEI 在线）");
      assert(items.length > 0, "[1] 至少返回 1 条候选");
      const top = items[0];
      assert(
        top?.entityId === `${PREFIX}-proj-scrna`,
        "[1] 单细胞测序项目排第一（语义命中）",
      );
      // 单细胞 top score 明显高于财务报表（无关）。
      const scrna = items.find((i) => i.entityId === `${PREFIX}-proj-scrna`);
      const finance = items.find((i) => i.entityId === `${PREFIX}-proj-finance`);
      if (scrna && finance) {
        assert(
          scrna.score > finance.score + 0.1,
          `[1] 单细胞 score(${scrna.score.toFixed(3)}) 显著高于财务(${finance.score.toFixed(3)})`,
        );
      } else {
        assert(false, "[1] 单细胞和财务实体都应出现在结果中");
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // [2] scope 隔离：用户 B 的实体不出现在用户 A 的召回
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n[2] scope 隔离：用户 B 的实体不出现在 A 的召回");
    {
      const res = await executeAgentAction<{
        items: Array<{ entityId?: string }>;
      }>(ctxA, "agent.recall_memory", { query: "单细胞测序", limit: 10 });
      const ids = res.result.items.map((i) => i.entityId);
      console.log("    A sees:", ids);
      assert(
        !ids.includes(`${PREFIX}-proj-b-scrna`),
        "[2] B 的单细胞竞品项目不出现在 A 的召回（scope 隔离）",
      );
      assert(
        ids.includes(`${PREFIX}-proj-scrna`),
        "[2] A 自己的单细胞项目出现在召回中",
      );
    }

    // ════════════════════════════════════════════════════════════════════════
    // [3] entityType 过滤：entityType=customer 只返回客户实体
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n[3] entityType 过滤：customer 只返回客户实体");
    {
      const res = await executeAgentAction<{
        items: Array<{ source: string; entityType?: string; entityId?: string }>;
      }>(ctxA, "agent.recall_memory", {
        query: "单细胞 客户 偏好",
        limit: 10,
        entityType: "customer",
      });
      const items = res.result.items;
      console.log("    customer-only:", items.map((i) => i.entityId));
      assert(items.length > 0, "[3] entityType=customer 至少返回 1 条");
      assert(
        items.every((i) => i.entityType === "customer"),
        "[3] 所有返回项 entityType=customer",
      );
      assert(
        items.some((i) => i.entityId === `${PREFIX}-cust-wang`),
        "[3] 王晓明客户出现在结果中",
      );
      assert(
        !items.some((i) => i.entityId === `${PREFIX}-proj-scrna`),
        "[3] 项目实体被过滤掉",
      );
    }

    // ════════════════════════════════════════════════════════════════════════
    // [4] limit clamp：limit=50 → 10
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n[4] limit clamp：limit=50 → 10");
    {
      const res = await executeAgentAction<{
        items: unknown[];
      }>(ctxA, "agent.recall_memory", { query: "单细胞", limit: 50 });
      assertEq(res.result.items.length, 3, "[4] A 只有 3 条实体，limit clamp 不超候选数");
      // 注：A 总共 3 条 ACTIVE 实体，clamp 到 10 但候选池只有 3 → 返回 3。
      // 用一个明确 limit=2 验证 clamp 下界行为。
      const res2 = await executeAgentAction<{
        items: unknown[];
      }>(ctxA, "agent.recall_memory", { query: "单细胞", limit: 2 });
      assertEq(res2.result.items.length, 2, "[4] limit=2 → 返回 2 条");
    }

    // ════════════════════════════════════════════════════════════════════════
    // [5] ARCHIVED 实体不被召回
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n[5] ARCHIVED 实体不被召回");
    {
      // 把单细胞项目置 ARCHIVED，再召回「单细胞」应该看不到它。
      await prisma.agentEntityMemory.updateMany({
        where: { userId: userA.id, entityId: `${PREFIX}-proj-scrna` },
        data: { status: "ARCHIVED" },
      });
      const res = await executeAgentAction<{
        items: Array<{ entityId?: string }>;
      }>(ctxA, "agent.recall_memory", { query: "单细胞测序项目进展", limit: 10 });
      const ids = res.result.items.map((i) => i.entityId);
      console.log("    after ARCHIVE:", ids);
      assert(
        !ids.includes(`${PREFIX}-proj-scrna`),
        "[5] ARCHIVED 单细胞项目不被召回",
      );
      // 恢复以便后续断言不受影响。
      await prisma.agentEntityMemory.updateMany({
        where: { userId: userA.id, entityId: `${PREFIX}-proj-scrna` },
        data: { status: "ACTIVE" },
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // [6] 降级：独立子进程 + 不可用 TEI → degraded=true 仍按 activityScore 返回
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n[6] 降级：AGENT_VECTOR_BASE_URL 指不可用端口 → degraded=true");
    {
      // 把 A 的财务项目 activityScore 调到最高，断言降级路径下它排第一。
      await prisma.agentEntityMemory.updateMany({
        where: { userId: userA.id, entityId: `${PREFIX}-proj-finance` },
        data: { activityScore: 99.0, lastActiveAt: daysAgo(0) },
      });

      const degradeScript = path.resolve(__dirname, "smoke-test-recall-memory-degrade.ts");
      const result = spawnSync(
        "npx",
        ["tsx", degradeScript, "--db", handle.dbPath, "--user", userA.id, "--prefix", PREFIX],
        {
          cwd: path.resolve(__dirname, ".."),
          encoding: "utf8",
          env: {
            ...process.env,
            // 指向不可用端口，触发降级；隔离 health 缓存依赖独立进程。
            AGENT_VECTOR_BASE_URL: "http://127.0.0.1:9",
            DATABASE_URL: handle.databaseUrl,
          },
        },
      );
      // 回显子进程输出（含 degraded=true / 排序断言），便于排查。
      if (result.stdout) console.log(result.stdout.trimEnd());
      if (result.status !== 0) {
        console.error("[6] degrade subprocess stderr:", result.stderr);
      }
      assert(result.status === 0, "[6] 降级子进程退出码 0（degraded=true 且按 activityScore 排序）");
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("❌ recall_memory smoke 失败");
    process.exit(1);
  }
  console.log("✅ recall_memory smoke 通过");
}

void main().catch((err) => {
  console.error("smoke-test-recall-memory crashed:", err);
  process.exit(2);
});
