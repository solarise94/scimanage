/**
 * 梦境记忆 D2 dream cycle smoke（DB 集成，withTempSmokeDb）。
 *
 * 覆盖：
 *  ① 实体刷新：ADMIN fixture + 热客户/热项目数据 → cycle(compactSessions:false)
 *     → AgentEntityMemory 行创建（entityType/name/status ACTIVE/有 activityScore）；
 *     再跑 → 行数不变（upsert 幂等）；项目改 TERMINATED 后再跑 → 对应实体变 STALE。
 *  ② 融合衰减：2 条近重复 content 记忆 → 一条 ARCHIVED；
 *     lastUsedAt 60 天前 → confidence 明显衰减；confidence 0.1 → ARCHIVED；
 *     105 条记忆 → ACTIVE ≤ 100。
 *  ③ 降级：AGENT_VECTOR_BASE_URL 指向不可用端口 → cycle 仍完成（独立子进程，避免 60s health 缓存污染）。
 *
 * 注：smoke 环境无真实 TEI，embed 调用全程降级（返回 null），融合走文本相等降级路径。
 *     故 ② 融合用「归一化后完全相等」造近重复，可稳定断言。
 *
 * 运行: npx tsx scripts/smoke-test-agent-dream.ts
 */

import { withTempSmokeDb } from "./lib/temp-smoke-db";
import { spawnSync } from "node:child_process";
import path from "node:path";

const PREFIX = `SMK-DRM-${Date.now().toString(36)}`;
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

async function main() {
  console.log("=== dream cycle smoke ===\n");

  await withTempSmokeDb(async (handle) => {
    handle.assertSafePath();

    const { prisma } = await import("../src/lib/prisma");
    const { runAgentDreamCycle } = await import("../src/lib/agent-runtime/dream");

    // ── 公共 ADMIN（scope=null，候选池路径）──────────────────────────────────
    const admin = await prisma.user.create({
      data: {
        email: `${PREFIX}-admin@test.local`,
        name: "Admin",
        password: "x",
        role: "ADMIN",
      },
    });

    // ════════════════════════════════════════════════════════════════════════
    // [1] 实体刷新：创建 / 幂等 / STALE
    // ════════════════════════════════════════════════════════════════════════
    console.log("[1] 实体刷新：创建 / 幂等 / STALE");
    {
      const cust = await prisma.crmCustomerProfile.create({
        data: {
          ownerUserId: admin.id,
          name: "梦境客户甲",
          organization: "梦境机构",
          stage: "ACTIVE",
          importance: "KEY",
          assignmentStatus: "ASSIGNED",
          archived: false,
          deleted: false,
          lastFollowUpAt: new Date(),
        },
      });
      const proj = await prisma.project.create({
        data: {
          id: `${PREFIX}-proj-1`,
          name: "梦境项目甲",
          status: "IN_PROGRESS",
          archived: false,
          deleted: false,
        },
      });

      const stats1 = await runAgentDreamCycle({ compactSessions: false, entityUserLimit: 5 });
      console.log("    stats1:", JSON.stringify(stats1));

      const custRows = await prisma.agentEntityMemory.findMany({
        where: { userId: admin.id, entityType: "customer", entityId: cust.id },
      });
      const projRows = await prisma.agentEntityMemory.findMany({
        where: { userId: admin.id, entityType: "project", entityId: proj.id },
      });
      assert(custRows.length === 1, "客户实体行创建");
      assert(projRows.length === 1, "项目实体行创建");
      assert(custRows[0]?.status === "ACTIVE", "客户实体 status=ACTIVE");
      assert(projRows[0]?.status === "ACTIVE", "项目实体 status=ACTIVE");
      assert(!!custRows[0]?.name, "客户实体 name 非空");
      assert((custRows[0]?.activityScore ?? -1) > 0, "客户实体 activityScore > 0");
      assert(stats1.entityUpserted >= 2, `entityUpserted >= 2（实际 ${stats1.entityUpserted}）`);

      // 幂等：再跑一次，行数不变。
      const beforeCount = await prisma.agentEntityMemory.count({
        where: { userId: admin.id, status: "ACTIVE" },
      });
      await runAgentDreamCycle({ compactSessions: false, entityUserLimit: 5 });
      const afterCount = await prisma.agentEntityMemory.count({
        where: { userId: admin.id, status: "ACTIVE" },
      });
      assert(afterCount === beforeCount, `幂等：再跑行数不变（${beforeCount} → ${afterCount}）`);

      // 把项目改 TERMINATED → 不再出现在热榜（hot-projects 只返回 NOT_STARTED/IN_PROGRESS）
      // → 对应实体变 STALE。
      await prisma.project.update({
        where: { id: proj.id },
        data: { status: "TERMINATED" },
      });
      const stats3 = await runAgentDreamCycle({ compactSessions: false, entityUserLimit: 5 });
      console.log("    stats3:", JSON.stringify(stats3));
      const projRowAfter = await prisma.agentEntityMemory.findFirst({
        where: { userId: admin.id, entityType: "project", entityId: proj.id },
      });
      assert(
        projRowAfter?.status === "STALE",
        `项目 TERMINATED 后实体变 STALE（实际 ${projRowAfter?.status}）`,
      );
      assert(stats3.entityStale >= 1, `entityStale >= 1（实际 ${stats3.entityStale}）`);
      // 客户仍在热榜 → 仍 ACTIVE。
      const custRowAfter = await prisma.agentEntityMemory.findFirst({
        where: { userId: admin.id, entityType: "customer", entityId: cust.id },
      });
      assert(custRowAfter?.status === "ACTIVE", "客户仍在热榜 → 仍 ACTIVE");

      // 清理本次 fixture（避免污染后续用例）。
      await prisma.agentEntityMemory.deleteMany({ where: { userId: admin.id } });
      await prisma.crmCustomerProfile.deleteMany({ where: { ownerUserId: admin.id } });
      await prisma.project.deleteMany({ where: { id: { startsWith: PREFIX } } });
    }

    // ════════════════════════════════════════════════════════════════════════
    // [2] 融合 + 衰减 + 容量
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n[2] 融合 / 衰减 / 归档 / 容量");
    {
      // 2a. 近重复（归一化后相等）→ 一条 ARCHIVED。
      // 注意：smoke 无 TEI，融合走 normalizeText 完全相等路径；
      // 标点/空白差异在 normalize 后相等，content 不同字面也能合并。
      await prisma.agentMemory.create({
        data: {
          userId: admin.id,
          kind: "preference",
          content: "客户喜欢周五开会",
          confidence: 0.8,
          status: "ACTIVE",
        },
      });
      await prisma.agentMemory.create({
        data: {
          userId: admin.id,
          kind: "preference",
          content: "客户 喜欢，周五 开会。", // normalize 后 = "客户喜欢周五开会"
          confidence: 0.7,
          status: "ACTIVE",
        },
      });

      // 2b. lastUsedAt 60 天前 → confidence 明显衰减（半衰 30 天 → 0.8*0.5^2=0.2 附近）。
      const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      const decayMem = await prisma.agentMemory.create({
        data: {
          userId: admin.id,
          kind: "working_context",
          content: "decay-marker-unique-content-xyz",
          confidence: 0.8,
          status: "ACTIVE",
          lastUsedAt: sixtyDaysAgo,
        },
      });

      // 2c. confidence 0.1 → ARCHIVED（< 0.2 floor）。
      await prisma.agentMemory.create({
        data: {
          userId: admin.id,
          kind: "correction",
          content: "floor-marker-unique-content-abc",
          confidence: 0.1,
          status: "ACTIVE",
        },
      });

      const stats2 = await runAgentDreamCycle({ compactSessions: false, entityUserLimit: 5 });
      console.log("    stats2:", JSON.stringify(stats2));

      // 2a 断言：两条近重复只剩 1 条 ACTIVE。
      const activeDup = await prisma.agentMemory.findMany({
        where: { userId: admin.id, status: "ACTIVE", content: { contains: "周五" } },
      });
      assert(activeDup.length === 1, `近重复合并后剩 1 条 ACTIVE（实际 ${activeDup.length}）`);
      assert(stats2.memoryMerged >= 1, `memoryMerged >= 1（实际 ${stats2.memoryMerged}）`);

      // 2b 断言：60 天前的记忆 confidence 明显衰减（从 0.8 → < 0.4）。
      const decayedRow = await prisma.agentMemory.findUnique({ where: { id: decayMem.id } });
      assert(
        !!decayedRow && decayedRow.confidence < 0.4,
        `60 天前记忆 confidence 衰减 < 0.4（实际 ${decayedRow?.confidence.toFixed(3)}）`,
      );
      assert(stats2.memoryDecayed >= 1, `memoryDecayed >= 1（实际 ${stats2.memoryDecayed}）`);

      // 2c 断言：confidence 0.1 的 → ARCHIVED。
      const floorRow = await prisma.agentMemory.findFirst({
        where: { userId: admin.id, content: { contains: "floor-marker" } },
      });
      assert(
        floorRow?.status === "ARCHIVED",
        `confidence 0.1 → ARCHIVED（实际 ${floorRow?.status}）`,
      );
      assert(stats2.memoryArchived >= 1, `memoryArchived >= 1（实际 ${stats2.memoryArchived}）`);

      // 2d 容量：造 >100 条内容明显不同（不触发 cosine≥0.92 融合）的记忆，
      // 验证跑后 ACTIVE ≤ 100，且被剔除的是最旧最弱的。
      // 用主题词库交叉组合，使每条语义足够不同，bge-m3 不会误判为近重复。
      await prisma.agentMemory.deleteMany({ where: { userId: admin.id } });
      const subjects = [
        "财务对账", "合同审批", "差旅报销", "客户拜访", "项目排期",
        "供应商询价", "库存盘点", "招聘面试", "绩效考核", "系统巡检",
        "数据备份", "权限审计", "邮件营销", "售后回访", "发票核销",
        "采购入库", "物流跟踪", "质量检验", "会议纪要", "培训计划",
      ];
      const objects = [
        "需在本周完成", "已与对方确认", "存在风险点", "需要二次复核", "优先级最高",
        "暂缓处理", "已转交负责人", "等待客户反馈", "进入收尾阶段", "下周启动",
        "涉及外部审核", "成本超预算", "时间节点紧", "跨部门协作", "需要法务介入",
        "已归档存证", "待数据校验", "流程已优化", "资源已就绪", "待领导拍板",
      ];
      // 20×20 = 400 种组合，取前 110 条，远超容量上限且语义两两不同。
      const batch: Array<{ data: object }> = [];
      let combo = 0;
      for (const s of subjects) {
        for (const o of objects) {
          if (combo >= 110) break;
          // confidence 从 0.9 递减到 0.3，让容量剔除可预期（最弱先被剔）。
          const conf = 0.9 - (combo / 110) * 0.6;
          batch.push({
            data: {
              userId: admin.id,
              kind: "preference",
              content: `${s}${o}`,
              confidence: conf,
              status: "ACTIVE",
            },
          });
          combo++;
        }
        if (combo >= 110) break;
      }
      // 分片 createMany（SQLite 变量上限）。
      for (let i = 0; i < batch.length; i += 50) {
        await prisma.agentMemory.createMany({ data: batch.slice(i, i + 50).map((b) => b.data) } as never);
      }
      const beforeCap = await prisma.agentMemory.count({
        where: { userId: admin.id, status: "ACTIVE" },
      });
      assert(beforeCap === 110, `造 110 条 ACTIVE（实际 ${beforeCap}）`);

      const statsCap = await runAgentDreamCycle({ compactSessions: false, entityUserLimit: 5 });
      const afterCap = await prisma.agentMemory.count({
        where: { userId: admin.id, status: "ACTIVE" },
      });
      console.log("    statsCap:", JSON.stringify(statsCap));
      assert(afterCap <= 100, `容量上限：ACTIVE ≤ 100（实际 ${afterCap}）`);
      assert(afterCap === 100, `容量上限精确到 100（实际 ${afterCap}）`);
      assert(statsCap.memoryCapped >= 10, `memoryCapped >= 10（实际 ${statsCap.memoryCapped}）`);

      await prisma.agentMemory.deleteMany({ where: { userId: admin.id } });
    }

    // ════════════════════════════════════════════════════════════════════════
    // [3] 降级：AGENT_VECTOR_BASE_URL 指向不可用端口 → cycle 仍完成
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n[3] 向量服务降级：cycle 仍完成");
    {
      // 独立子进程跑降级用例：vector.ts 的 health 缓存是进程级单例（60s），
      // 子进程隔离可确保 health 探活真正打到不可用端口。
      const scriptDir = path.resolve(__dirname);
      const result = spawnSync(
        "npx",
        ["tsx", path.join(scriptDir, "smoke-test-agent-dream-degrade.ts")],
        {
          cwd: path.resolve(scriptDir, ".."),
          env: {
            ...process.env,
            AGENT_VECTOR_BASE_URL: "http://127.0.0.1:9", // 9 = discard，必然连不上
          },
          encoding: "utf8",
          shell: process.platform === "win32",
        },
      );
      if (result.status !== 0) {
        console.log("    degrade subprocess stdout:", result.stdout?.slice(-1500));
        console.log("    degrade subprocess stderr:", result.stderr?.slice(-1500));
      }
      assert(result.status === 0, `降级子进程退出码 0（实际 ${result.status}）`);
      // 子进程内部已自断言 cycle 完成且无未捕获异常；此处仅校验退出码。
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("❌ dream cycle smoke 失败");
    process.exit(1);
  }
  console.log("✅ dream cycle smoke 通过");
}

void main().catch((err) => {
  console.error("smoke-test-agent-dream crashed:", err);
  process.exit(2);
});
