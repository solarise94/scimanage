/**
 * `listHotProjectsForActor` 热项目加载层 smoke（DB 集成）。
 *
 * 用 withTempSmokeDb 建临时库，覆盖：
 *  1. 排序：IN_PROGRESS+近期活动 > NOT_STARTED；同分 projectId 尾锚确定性（两次调用顺序一致）。
 *  2. scope 隔离：REP 只见参与/关联项目（ProjectMember 路径）；ADMIN（null scope）走候选池。
 *  3. 活跃过滤：COMPLETED/TERMINATED/archived 项目不出现。
 *  4. limit clamp：默认 20；limit=100 → 30（用 40 条 fixture 验证上限）。
 *  5. lastActivityAt 取 ActivityLog 与 Ticket 的 max（造一条比 project.updatedAt 新的 ActivityLog 断言生效）。
 *
 * 运行: npx tsx scripts/smoke-test-hot-projects.ts
 */

import { withTempSmokeDb } from "./lib/temp-smoke-db";

const PREFIX = `SMK-HP-${Date.now().toString(36)}`;
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
  console.log("=== listHotProjectsForActor 热项目加载 smoke ===\n");

  await withTempSmokeDb(async (handle) => {
    handle.assertSafePath();

    const { prisma } = await import("../src/lib/prisma");
    const { listHotProjectsForActor, compareHotProjects } = await import(
      "../src/lib/agent-runtime/hot-projects"
    );

    // ── 公共 ADMIN（全量 scope，scopeIds===null）──────────────────────────────
    const admin = await prisma.user.create({
      data: {
        email: `${PREFIX}-admin@test.local`,
        name: "Admin",
        password: "x",
        role: "ADMIN",
      },
    });

    // ── 1. 排序：IN_PROGRESS+近期活动 > NOT_STARTED；projectId 尾锚 ──────────
    console.log("[1] 排序：status + lastActivityAt + projectId 尾锚");
    {
      const now = new Date();
      const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

      // IN_PROGRESS（近期活动）、NOT_STARTED（更近期但状态靠后）、NOT_STARTED（旧活动）
      const inProgress = await prisma.project.create({
        data: {
          id: `${PREFIX}-sort-ip`,
          name: "进行中项目",
          status: "IN_PROGRESS",
          updatedAt: daysAgo(1),
        },
      });
      const notStarted = await prisma.project.create({
        data: {
          id: `${PREFIX}-sort-ns`,
          name: "未启动项目",
          status: "NOT_STARTED",
          updatedAt: daysAgo(0), // 比进行中还新，但状态靠后
        },
      });
      const notStartedOld = await prisma.project.create({
        data: {
          id: `${PREFIX}-sort-ns-old`,
          name: "未启动旧项目",
          status: "NOT_STARTED",
          updatedAt: daysAgo(10),
        },
      });

      const result = await listHotProjectsForActor(
        { userId: admin.id, role: "ADMIN" },
        { limit: 10 },
      );
      console.log(
        "    order:",
        result.map((r) => `${r.status}:${r.name}`).join(" > "),
      );
      assert(result.length === 3, "3 条全部返回");
      assert(result[0]?.projectId === inProgress.id, "IN_PROGRESS 排第一（状态优先）");
      assert(result[1]?.projectId === notStarted.id, "NOT_STARTED 近期排第二");
      assert(result[2]?.projectId === notStartedOld.id, "NOT_STARTED 旧活动排最后");

      // 确定性：同样数据跑两次顺序一致。
      const result2 = await listHotProjectsForActor(
        { userId: admin.id, role: "ADMIN" },
        { limit: 10 },
      );
      const ids1 = result.map((r) => r.projectId).join(",");
      const ids2 = result2.map((r) => r.projectId).join(",");
      assert(ids1 === ids2, "两次调用顺序一致（projectId 尾锚确定性）");

      // 同分场景：两条 NOT_STARTED 且 lastActivityAt 相同 → projectId 字典序尾锚决定顺序。
      const [twinA, twinB] = await Promise.all([
        prisma.project.create({
          data: {
            id: `${PREFIX}-twin-aaa`,
            name: "双胞胎甲",
            status: "NOT_STARTED",
            updatedAt: daysAgo(5),
          },
        }),
        prisma.project.create({
          data: {
            id: `${PREFIX}-twin-zzz`,
            name: "双胞胎乙",
            status: "NOT_STARTED",
            updatedAt: daysAgo(5),
          },
        }),
      ]);
      const twinResult = await listHotProjectsForActor(
        { userId: admin.id, role: "ADMIN" },
        { limit: 50 },
      );
      const twinAEntry = twinResult.find((r) => r.projectId === twinA.id);
      const twinBEntry = twinResult.find((r) => r.projectId === twinB.id);
      const twinAIdx = twinResult.findIndex((r) => r.projectId === twinA.id);
      const twinBIdx = twinResult.findIndex((r) => r.projectId === twinB.id);
      const twinAFirstByCmp =
        !!twinAEntry && !!twinBEntry && compareHotProjects(twinAEntry, twinBEntry) < 0;
      const actualAFirst = twinAIdx >= 0 && twinBIdx >= 0 && twinAIdx < twinBIdx;
      assert(!!twinAEntry && !!twinBEntry, "两条同分候选都被返回");
      assert(
        actualAFirst === twinAFirstByCmp,
        "同分候选相对顺序与 compareHotProjects 一致（projectId 尾锚）",
      );

      await prisma.project.deleteMany({
        where: {
          id: {
            in: [inProgress.id, notStarted.id, notStartedOld.id, twinA.id, twinB.id],
          },
        },
      });
    }

    // ── 2. scope 隔离：REP 只见参与/关联项目（ProjectMember 路径） ────────────
    console.log("\n[2] scope 隔离：REP 经 ProjectMember 路径只见参与项目");
    {
      const repUser = await prisma.user.create({
        data: {
          email: `${PREFIX}-rep@test.local`,
          name: "Rep",
          password: "x",
          role: "REPRESENTATIVE",
        },
      });
      const otherUser = await prisma.user.create({
        data: {
          email: `${PREFIX}-other@test.local`,
          name: "Other",
          password: "x",
          role: "USER",
        },
      });

      const myProject = await prisma.project.create({
        data: {
          id: `${PREFIX}-scope-mine`,
          name: "我参与的项目",
          status: "IN_PROGRESS",
        },
      });
      const otherProject = await prisma.project.create({
        data: {
          id: `${PREFIX}-scope-other`,
          name: "别人的项目",
          status: "IN_PROGRESS",
        },
      });
      // ProjectMember 关系：repUser 是 myProject 成员
      await prisma.projectMember.create({
        data: { projectId: myProject.id, userId: repUser.id, role: "MEMBER" },
      });

      const repResult = await listHotProjectsForActor(
        { userId: repUser.id, role: "REPRESENTATIVE" },
        { limit: 50 },
      );
      const repIds = repResult.map((r) => r.projectId);
      console.log("    REP sees:", repResult.map((r) => r.name));
      assert(repIds.includes(myProject.id), "REP 看见本人参与项目");
      assert(!repIds.includes(otherProject.id), "REP 看不见非参与项目（scope 隔离）");

      // USER 无 ProjectMember 关系 → 空 scope → []
      const userResult = await listHotProjectsForActor(
        { userId: otherUser.id, role: "USER" },
        { limit: 50 },
      );
      assert(userResult.length === 0, "USER 无关系 → []（scope 空集）");

      await prisma.project.deleteMany({
        where: { id: { in: [myProject.id, otherProject.id] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [repUser.id, otherUser.id] } },
      });
    }

    // ── 3. 活跃过滤：COMPLETED/TERMINATED/archived 不出现 ─────────────────────
    console.log("\n[3] 活跃过滤：COMPLETED/TERMINATED/archived 不出现");
    {
      const active = await prisma.project.create({
        data: { id: `${PREFIX}-filt-active`, name: "活跃", status: "IN_PROGRESS" },
      });
      const completed = await prisma.project.create({
        data: { id: `${PREFIX}-filt-done`, name: "已完成", status: "COMPLETED" },
      });
      const terminated = await prisma.project.create({
        data: { id: `${PREFIX}-filt-term`, name: "已终止", status: "TERMINATED" },
      });
      const archived = await prisma.project.create({
        data: {
          id: `${PREFIX}-filt-arch`,
          name: "已归档",
          status: "IN_PROGRESS",
          archived: true,
        },
      });

      const result = await listHotProjectsForActor(
        { userId: admin.id, role: "ADMIN" },
        { limit: 50 },
      );
      const ids = result.map((r) => r.projectId);
      console.log("    returned:", result.map((r) => `${r.status}:${r.name}`));
      assert(ids.includes(active.id), "活跃项目返回");
      assert(!ids.includes(completed.id), "COMPLETED 不返回");
      assert(!ids.includes(terminated.id), "TERMINATED 不返回");
      assert(!ids.includes(archived.id), "archived 不返回");

      await prisma.project.deleteMany({
        where: { id: { in: [active.id, completed.id, terminated.id, archived.id] } },
      });
    }

    // ── 4. limit clamp：默认 20；100 → 30（40 条 fixture 验证上限）─────────────
    console.log("\n[4] limit clamp：默认 20 / 100→30");
    {
      const created: string[] = [];
      for (let i = 0; i < 40; i += 20) {
        const batch: Array<{ id: string; name: string }> = [];
        for (let j = 0; j < 20 && i + j < 40; j++) {
          batch.push({ id: `${PREFIX}-clamp-${i + j}`, name: `clamp-${i + j}` });
        }
        await prisma.$transaction(
          batch.map((b) =>
            prisma.project.create({
              data: { id: b.id, name: b.name, status: "IN_PROGRESS" },
            }),
          ),
        );
        created.push(...batch.map((b) => b.id));
      }
      assert(created.length === 40, "建了 40 条 fixture");

      const def = await listHotProjectsForActor({ userId: admin.id, role: "ADMIN" });
      assert(def.length === 20, `默认 limit=20（实际 ${def.length}）`);

      const over = await listHotProjectsForActor(
        { userId: admin.id, role: "ADMIN" },
        { limit: 100 },
      );
      assert(over.length === 30, `limit=100 → clamp 30（实际 ${over.length}）`);

      await prisma.project.deleteMany({
        where: { id: { startsWith: `${PREFIX}-clamp-` } },
      });
    }

    // ── 5. lastActivityAt 取 ActivityLog 与 Ticket 的 max ─────────────────────
    console.log("\n[5] lastActivityAt 取 ActivityLog/Ticket 的 max（覆盖 project.updatedAt）");
    {
      // project.updatedAt 较旧，造一条更近的 ActivityLog 断言 max 生效。
      const oldUpdated = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000); // 20 天前
      const recentActivity = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1 小时前

      const proj = await prisma.project.create({
        data: {
          id: `${PREFIX}-act-proj`,
          name: "活动信号项目",
          status: "IN_PROGRESS",
          updatedAt: oldUpdated,
        },
      });
      // 手动覆盖 updatedAt（@updatedAt 会自动设当前时间）
      await prisma.project.update({
        where: { id: proj.id },
        data: { updatedAt: oldUpdated },
      });
      await prisma.activityLog.create({
        data: {
          projectId: proj.id,
          userId: admin.id,
          type: "NOTE",
          content: "近期活动",
          createdAt: recentActivity,
        },
      });

      const result = await listHotProjectsForActor(
        { userId: admin.id, role: "ADMIN" },
        { limit: 50 },
      );
      const hit = result.find((r) => r.projectId === proj.id);
      assert(!!hit, "活动信号项目出现在结果里");
      assert(!!hit?.lastActivityAt, "lastActivityAt 非空");
      if (hit?.lastActivityAt) {
        const ts = Date.parse(hit.lastActivityAt);
        console.log(
          `    project.updatedAt=${oldUpdated.toISOString()}, activityLog=${recentActivity.toISOString()}, result=${hit.lastActivityAt}`,
        );
        // 应接近 recentActivity（max），远新于 oldUpdated。
        assert(
          Math.abs(ts - recentActivity.getTime()) < 60 * 1000,
          "lastActivityAt = ActivityLog 的 max（而非 project.updatedAt）",
        );
        assert(
          ts > oldUpdated.getTime() + 24 * 60 * 60 * 1000,
          "lastActivityAt 显著新于 project.updatedAt",
        );
      }

      // 另造一条 Ticket 更新时间，验证 Ticket 信号也被纳入 max。
      const ticketTime = new Date(Date.now() - 30 * 60 * 1000); // 30 分钟前（比 activityLog 更新）
      await prisma.ticket.create({
        data: {
          title: "ticket-signal",
          projectId: proj.id,
          updatedAt: ticketTime,
        },
      });
      const result2 = await listHotProjectsForActor(
        { userId: admin.id, role: "ADMIN" },
        { limit: 50 },
      );
      const hit2 = result2.find((r) => r.projectId === proj.id);
      if (hit2?.lastActivityAt) {
        const ts = Date.parse(hit2.lastActivityAt);
        assert(
          Math.abs(ts - ticketTime.getTime()) < 60 * 1000,
          "加入 Ticket 后 lastActivityAt = max(ActivityLog, Ticket)",
        );
      } else {
        assert(false, "Ticket 信号场景 hit 非空");
      }

      await prisma.project.delete({ where: { id: proj.id } });
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("❌ 热项目加载 smoke 失败");
    process.exit(1);
  }
  console.log("✅ 热项目加载 smoke 通过");
}

void main().catch((err) => {
  console.error("smoke-test-hot-projects crashed:", err);
  process.exit(2);
});
