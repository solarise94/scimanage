/**
 * 客户名 resolver —— 数据层集成测试（真实 gather → score → resolve）。
 *
 * 与 smoke-test-customer-name-resolver.ts（纯函数层）互补：本测试建临时库，跑真实
 * `gatherNameResolutionCandidates`（碰 DB、走 scope），覆盖纯函数层测不到的数据层问题：
 *
 *  1. [P1#1 同音召回核心] spokenName="王小明" 应召回 DB 里的 "王晓明"（同音错字），
 *     且 scoreAndResolve 判 UNIQUE、reasons 含「发音相同」。
 *     —— 验证 pinyin-pro 拼音相等补召回生效（pinyin-match 单独做不到）。
 *  2. [P1#2 SQLite 分块] 区域经理下辖 >900 条 ASSIGNED Profile 时 gather 不抛 P2029。
 *  3. [scope 隔离] 另一代表的客户不应被召回。
 *  4. [拼音输入回退] spokenName="zsy" 仍能召回 "张三阳"（pinyin-match 路径未破坏）。
 *
 * 运行: npx tsx scripts/smoke-test-customer-name-resolver-db.ts
 *
 * 前提: 用 withTempSmokeDb 建临时库，不碰 dev/demo/prod。
 */

import { withTempSmokeDb } from "./lib/temp-smoke-db";

const PREFIX = `SMK-NR-${Date.now().toString(36)}`;
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
  console.log("=== 客户名 resolver 数据层集成测试 ===\n");

  await withTempSmokeDb(async (handle) => {
    handle.assertSafePath();

    const { prisma } = await import("../src/lib/prisma");
    const {
      gatherNameResolutionCandidates,
      scoreAndResolve,
    } = await import("../src/lib/crm/customer-name-resolver");

    // ── 公共 fixture：ADMIN（全量 scope，scopeIds===null）──────────────────────
    const admin = await prisma.user.create({
      data: { email: `${PREFIX}-admin@test.local`, name: "Admin", password: "x", role: "ADMIN" },
    });

    // ── 1. [P1#1] 同音错字召回（王小明 → 王晓明）────────────────────────────────
    console.log("[1] 同音错字召回：spokenName=王小明 → 召回 王晓明 → UNIQUE");
    {
      // DB 里存的是「王晓明」，ASR 转写成「王小明」（同音错字）。
      const [profileWxm, profileLs] = await Promise.all([
        prisma.crmCustomerProfile.create({
          data: {
            customerCode: `${PREFIX}-wxm`,
            name: "王晓明",
            organization: "中科院A所",
            ownerUserId: admin.id,
          },
        }),
        prisma.crmCustomerProfile.create({
          data: {
            customerCode: `${PREFIX}-ls`,
            name: "李四",
            organization: "B大学",
            ownerUserId: admin.id,
          },
        }),
      ]);

      const gathered = await gatherNameResolutionCandidates(
        { userId: admin.id, role: "ADMIN" },
        "王小明",
      );
      const gatheredIds = gathered.map((g) => g.profileId);
      console.log("    gathered:", gathered.map((g) => g.name));

      // 核心断言：同音错字候选被召回（pinyin-match 单独做不到，必须靠 pinyin-pro 补召回）。
      assert(gatheredIds.includes(profileWxm.id), "王晓明（同音错字）被召回");
      assert(!gatheredIds.includes(profileLs.id), "李四（不相关）未被召回");

      const result = scoreAndResolve("王小明", gathered);
      console.log("    resolution:", result.resolution, "candidates:", result.candidates.map((c) => `${c.name}:${c.score}`));
      assert(result.resolution === "UNIQUE", "resolution === UNIQUE");
      assert(result.candidates[0]?.profileId === profileWxm.id, "王晓明 排第一");
      const hasPinyinReason = result.candidates[0]?.reasons.some((r) => r.includes("发音相同")) ?? false;
      assert(hasPinyinReason, "reasons 含「发音相同」");

      // 清理本组 fixture，避免污染后续 scope 测试。
      await prisma.crmCustomerProfile.deleteMany({ where: { id: { in: [profileWxm.id, profileLs.id] } } });
    }

    // ── 2. [P1#2] SQLite 分块：区域经理下辖 >900 条 Profile 不抛 P2029 ──────────
    console.log("\n[2] SQLite 分块：区域经理下辖 950 条 ASSIGNED Profile 不抛 P2029");
    {
      const repUser = await prisma.user.create({
        data: { email: `${PREFIX}-rep@test.local`, name: "Rep", password: "x", role: "REPRESENTATIVE" },
      });
      const rep = await prisma.representative.create({
        data: { name: "Rep", email: `${PREFIX}-rep@test.local` },
      });
      const rmUser = await prisma.user.create({
        data: { email: `${PREFIX}-rm@test.local`, name: "RM", password: "x", role: "REGIONAL_MANAGER" },
      });
      const rm = await prisma.crmRegionManager.create({ data: { userId: rmUser.id } });
      await prisma.crmRegionManagerRepresentative.create({
        data: { managerId: rm.id, representativeId: rep.id },
      });

      // 批量创建 950 条 ASSIGNED Profile（owner=repUser），超过 SQLite ~999 参数上限。
      // 用 $transaction 分批写入，避免单次 createMany 也超参数上限。
      const BATCH = 950;
      const targetProfileId = `${PREFIX}-target`;
      const profiles: Array<{ id: string; ownerUserId: string; name: string; customerCode: string }> = [];
      for (let i = 0; i < BATCH; i++) {
        profiles.push({
          id: i === 0 ? targetProfileId : `${PREFIX}-p${i}`,
          ownerUserId: repUser.id,
          name: i === 0 ? "目标客户陈七" : `批量客户${i}`,
          customerCode: `${PREFIX}-c${i}`,
        });
      }
      // 分批 createMany（每批 200），用 $transaction 包裹。
      for (let i = 0; i < profiles.length; i += 200) {
        const slice = profiles.slice(i, i + 200);
        await prisma.$transaction(
          slice.map((p) =>
            prisma.crmCustomerProfile.create({
              data: {
                id: p.id,
                customerCode: p.customerCode,
                name: p.name,
                ownerUserId: p.ownerUserId,
              },
            }),
          ),
        );
      }

      // 区域经理可见集合应包含全部 950 条（ownerUserId=repUser，RM 管辖 rep）。
      // gather 不应抛 P2029（too many SQL variables）。
      let gatheredOk = true;
      let gathered: Awaited<ReturnType<typeof gatherNameResolutionCandidates>> = [];
      try {
        gathered = await gatherNameResolutionCandidates(
          { userId: rmUser.id, role: "REGIONAL_MANAGER" },
          "目标客户陈七",
        );
      } catch (err) {
        gatheredOk = false;
        console.log("    gather 抛错:", err instanceof Error ? err.message : String(err));
      }
      assert(gatheredOk, "gather 未抛 P2029（分块生效）");
      const gatheredIds = gathered.map((g) => g.profileId);
      assert(gatheredIds.includes(targetProfileId), "目标客户陈七 被召回（contains 命中）");

      // 清理：删除本组 Profile + fixture。
      await prisma.crmCustomerProfile.deleteMany({ where: { ownerUserId: repUser.id } });
      await prisma.crmRegionManagerRepresentative.deleteMany({ where: { managerId: rm.id } });
      await prisma.crmRegionManager.delete({ where: { id: rm.id } });
      await prisma.representative.delete({ where: { id: rep.id } });
      await prisma.user.deleteMany({ where: { id: { in: [repUser.id, rmUser.id] } } });
    }

    // ── 3. [scope 隔离] 另一代表的客户不应被召回 ────────────────────────────────
    console.log("\n[3] scope 隔离：代表 A 查询时代表 B 的客户不被召回");
    {
      const repA = await prisma.user.create({
        data: { email: `${PREFIX}-repA@test.local`, name: "RepA", password: "x", role: "REPRESENTATIVE" },
      });
      await prisma.representative.create({
        data: { name: "RepA", email: `${PREFIX}-repA@test.local` },
      });
      const repB = await prisma.user.create({
        data: { email: `${PREFIX}-repB@test.local`, name: "RepB", password: "x", role: "REPRESENTATIVE" },
      });
      await prisma.representative.create({
        data: { name: "RepB", email: `${PREFIX}-repB@test.local` },
      });

      // repB 的客户「赵六」，repA 不应看到。
      const profileZl = await prisma.crmCustomerProfile.create({
        data: {
          customerCode: `${PREFIX}-zl`,
          name: "赵六",
          ownerUserId: repB.id,
        },
      });

      const gathered = await gatherNameResolutionCandidates(
        { userId: repA.id, role: "REPRESENTATIVE" },
        "赵六",
      );
      const gatheredIds = gathered.map((g) => g.profileId);
      console.log("    repA gathered:", gathered.map((g) => g.name));
      assert(!gatheredIds.includes(profileZl.id), "repB 的客户「赵六」未被 repA 召回（scope 隔离）");

      await prisma.crmCustomerProfile.deleteMany({ where: { id: profileZl.id } });
      await prisma.user.deleteMany({ where: { id: { in: [repA.id, repB.id] } } });
    }

    // ── 4. [拼音输入回退] zsy → 张三阳（pinyin-match 路径未破坏）──────────────────
    console.log("\n[4] 拼音输入回退：spokenName=zsy → 召回 张三阳");
    {
      const profileZsy = await prisma.crmCustomerProfile.create({
        data: {
          customerCode: `${PREFIX}-zsy`,
          name: "张三阳",
          organization: "E所",
          ownerUserId: admin.id,
        },
      });

      const gathered = await gatherNameResolutionCandidates(
        { userId: admin.id, role: "ADMIN" },
        "zsy",
      );
      const gatheredIds = gathered.map((g) => g.profileId);
      console.log("    gathered:", gathered.map((g) => g.name));

      assert(gatheredIds.includes(profileZsy.id), "张三阳 被 zsy 召回（pinyin-match 路径存活）");

      const result = scoreAndResolve("zsy", gathered);
      console.log("    resolution:", result.resolution, "candidates:", result.candidates.map((c) => `${c.name}:${c.score}`));
      // 拼音首字母命中 = 65 分，低于 UNIQUE_MIN_SCORE(85) → AMBIGUOUS（需用户确认）。
      assert(result.candidates[0]?.profileId === profileZsy.id, "张三阳 排第一");
      assert(result.candidates[0]?.score < 85, `得分 < 85（实际 ${result.candidates[0]?.score}）`);

      await prisma.crmCustomerProfile.deleteMany({ where: { id: profileZsy.id } });
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("❌ 客户名 resolver 数据层集成测试失败");
    process.exit(1);
  }
  console.log("✅ 客户名 resolver 数据层集成测试通过");
}

void main().catch((err) => {
  console.error("smoke-test-customer-name-resolver-db crashed:", err);
  process.exit(2);
});
