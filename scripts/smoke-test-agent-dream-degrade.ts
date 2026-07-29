/**
 * dream cycle 降级子进程（由 smoke-test-agent-dream.ts [3] 调起）。
 *
 * 在 AGENT_VECTOR_BASE_URL=http://127.0.0.1:9（不可用）下跑一轮 dream cycle，
 * 断言：cycle 完成、不抛、stats 返回（向量降级路径）。
 * 独立进程以确保 vector.ts 的 60s health 缓存不影响主进程。
 */

import { withTempSmokeDb } from "./lib/temp-smoke-db";

async function main() {
  await withTempSmokeDb(async (handle) => {
    handle.assertSafePath();
    const { prisma } = await import("../src/lib/prisma");
    const { runAgentDreamCycle } = await import("../src/lib/agent-runtime/dream");

    // 造一个 ADMIN 用户 + 一条客户，让 refresh 有数据可处理。
    const admin = await prisma.user.create({
      data: { email: `degrade-${Date.now()}@test.local`, name: "DegAdmin", password: "x", role: "ADMIN" },
    });
    await prisma.crmCustomerProfile.create({
      data: {
        ownerUserId: admin.id,
        name: "降级客户",
        stage: "ACTIVE",
        importance: "KEY",
        assignmentStatus: "ASSIGNED",
        archived: false,
        deleted: false,
        lastFollowUpAt: new Date(),
      },
    });
    // 造一条近重复记忆，验证降级融合路径（normalizeText 完全相等）仍能工作。
    await prisma.agentMemory.create({
      data: { userId: admin.id, kind: "preference", content: "降级融合标记", confidence: 0.8, status: "ACTIVE" },
    });
    await prisma.agentMemory.create({
      data: { userId: admin.id, kind: "preference", content: "降级 融合 标记！", confidence: 0.7, status: "ACTIVE" },
    });

    const stats = await runAgentDreamCycle({ compactSessions: false, entityUserLimit: 5 });
    console.log("[degrade] stats:", JSON.stringify(stats));

    // 断言：cycle 完成（stats 存在且 errors 不含向量相关致命错误）。
    if (!stats || typeof stats !== "object") {
      console.error("[degrade] FAIL: stats missing");
      process.exit(1);
    }
    if (stats.entityUpserted < 1) {
      console.error(`[degrade] FAIL: entityUpserted < 1 (got ${stats.entityUpserted})`);
      process.exit(1);
    }
    // 降级路径：embed 返回 null，embeddingBytes 应为空（未编码）。
    const ent = await prisma.agentEntityMemory.findFirst({
      where: { userId: admin.id },
      select: { embeddingBytes: true },
    });
    if (ent && ent.embeddingBytes && ent.embeddingBytes.length > 0) {
      console.error("[degrade] FAIL: embeddingBytes should be empty when TEI down");
      process.exit(1);
    }
    // 近重复在降级路径下仍合并。
    if (stats.memoryMerged < 1) {
      console.error(`[degrade] FAIL: memoryMerged < 1 in degrade path (got ${stats.memoryMerged})`);
      process.exit(1);
    }
    console.log("[degrade] OK: cycle completed under vector service outage");
  });
}

void main().catch((err) => {
  console.error("[degrade] crashed:", err);
  process.exit(2);
});
