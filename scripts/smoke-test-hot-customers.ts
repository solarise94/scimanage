/**
 * `listHotCustomersForActor` 热客户加载层 smoke（DB 集成，docs §5 / §10.1）。
 *
 * 用 withTempSmokeDb 建临时库，覆盖：
 *  1. 排序：多组 profile（ACTIVE+KEY+近期互动 vs FOLLOWING+NORMAL vs LEAD+LOW vs DORMANT）
 *     断言顺序符合 comparator；profileId 尾锚确定性（同样数据跑两次顺序一致）。
 *  2. scope 隔离：REP 只见本人；RM 见本人+下辖不见其他区域；空 scope → []。
 *  3. limit clamp：默认 30；limit=100 → 50；limit=0 → 1（用 60 条数据验证上限）。
 *  4. USER → []。
 *  5. ADMIN（null scope）正常返回 Top-N 且不超 limit。
 *  6. namePinyin 为 null 时回退 toPinyinToneless(name)。
 *
 * 运行: npx tsx scripts/smoke-test-hot-customers.ts
 */

import { withTempSmokeDb } from "./lib/temp-smoke-db";

const PREFIX = `SMK-HC-${Date.now().toString(36)}`;
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
  console.log("=== listHotCustomersForActor 热客户加载 smoke ===\n");

  await withTempSmokeDb(async (handle) => {
    handle.assertSafePath();

    const { prisma } = await import("../src/lib/prisma");
    const { listHotCustomersForActor, compareHotCustomers } = await import(
      "../src/lib/crm/hot-customers"
    );
    const { toPinyinToneless } = await import("../src/lib/crm/pinyin");

    // ── 公共 ADMIN（全量 scope，scopeIds===null）──────────────────────────────
    const admin = await prisma.user.create({
      data: { email: `${PREFIX}-admin@test.local`, name: "Admin", password: "x", role: "ADMIN" },
    });

    // ── 1. 排序：ACTIVE+KEY+近期 > FOLLOWING+NORMAL > LEAD+LOW > DORMANT ────────
    console.log("[1] 排序：阶段/重要性/最近互动/逾期/即将到期/profileId 尾锚");
    {
      const now = new Date();
      const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
      const daysAhead = (d: number) => new Date(now.getTime() + d * 24 * 60 * 60 * 1000);

      const [active, following, lead, dormant] = await Promise.all([
        prisma.crmCustomerProfile.create({
          data: {
            customerCode: `${PREFIX}-sort-active`,
            name: "活动客户",
            ownerUserId: admin.id,
            stage: "ACTIVE",
            importance: "KEY",
            lastFollowUpAt: daysAgo(2),
            nextFollowUpAt: daysAhead(1),
          },
        }),
        prisma.crmCustomerProfile.create({
          data: {
            customerCode: `${PREFIX}-sort-following`,
            name: "跟进中客户",
            ownerUserId: admin.id,
            stage: "FOLLOWING",
            importance: "NORMAL",
            lastFollowUpAt: daysAgo(5),
            nextFollowUpAt: daysAhead(3),
          },
        }),
        prisma.crmCustomerProfile.create({
          data: {
            customerCode: `${PREFIX}-sort-lead`,
            name: "线索客户",
            ownerUserId: admin.id,
            stage: "LEAD",
            importance: "LOW",
            lastFollowUpAt: daysAgo(40),
          },
        }),
        prisma.crmCustomerProfile.create({
          data: {
            customerCode: `${PREFIX}-sort-dormant`,
            name: "休眠客户",
            ownerUserId: admin.id,
            stage: "DORMANT",
            importance: "NORMAL",
            lastFollowUpAt: daysAgo(120),
          },
        }),
      ]);

      const result = await listHotCustomersForActor(
        { userId: admin.id, role: "ADMIN" },
        { limit: 10 },
      );
      console.log(
        "    order:",
        result.map((r) => `${r.stage}:${r.name}`).join(" > "),
      );
      assert(result.length === 4, "4 条全部返回");
      assert(result[0]?.profileId === active.id, "ACTIVE+KEY 排第一");
      assert(result[1]?.profileId === following.id, "FOLLOWING+NORMAL 排第二");
      assert(result[2]?.profileId === lead.id, "LEAD+LOW 排第三");
      assert(result[3]?.profileId === dormant.id, "DORMANT 排最后");

      // 确定性尾锚：同样数据跑两次顺序一致。
      const result2 = await listHotCustomersForActor(
        { userId: admin.id, role: "ADMIN" },
        { limit: 10 },
      );
      const ids1 = result.map((r) => r.profileId).join(",");
      const ids2 = result2.map((r) => r.profileId).join(",");
      assert(ids1 === ids2, "两次调用顺序一致（profileId 尾锚确定性）");

      // 同分场景的 profileId 尾锚：两条完全等价的候选，profileId 字典序决定顺序。
      const [twinA, twinB] = await Promise.all([
        prisma.crmCustomerProfile.create({
          data: {
            customerCode: `${PREFIX}-twin-aaa`,
            name: "双胞胎甲",
            ownerUserId: admin.id,
            stage: "CONTACTED",
            importance: "NORMAL",
            lastFollowUpAt: daysAgo(10),
          },
        }),
        prisma.crmCustomerProfile.create({
          data: {
            customerCode: `${PREFIX}-twin-zzz`,
            name: "双胞胎乙",
            ownerUserId: admin.id,
            stage: "CONTACTED",
            importance: "NORMAL",
            lastFollowUpAt: daysAgo(10),
          },
        }),
      ]);
      const twinResult = await listHotCustomersForActor(
        { userId: admin.id, role: "ADMIN" },
        { limit: 50 },
      );
      const twinAEntry = twinResult.find((r) => r.profileId === twinA.id);
      const twinBEntry = twinResult.find((r) => r.profileId === twinB.id);
      const twinAIdx = twinResult.findIndex((r) => r.profileId === twinA.id);
      const twinBIdx = twinResult.findIndex((r) => r.profileId === twinB.id);
      // 两条候选阶段/重要性/日期都相同 → comparator 只剩 profileId 字典序尾锚。
      const twinAFirstByCmp =
        !!twinAEntry && !!twinBEntry && compareHotCustomers(twinAEntry, twinBEntry) < 0;
      // 仅断言二者相对顺序与 comparator 一致（不预设谁在前，避免依赖 cuid 字典序细节）。
      const actualAFirst = twinAIdx >= 0 && twinBIdx >= 0 && twinAIdx < twinBIdx;
      assert(
        !!twinAEntry && !!twinBEntry,
        "两条同分候选都被返回",
      );
      assert(
        actualAFirst === twinAFirstByCmp,
        "同分候选的相对顺序与 compareHotCustomers 一致（profileId 尾锚）",
      );

      // 清理
      await prisma.crmCustomerProfile.deleteMany({
        where: { id: { in: [active.id, following.id, lead.id, dormant.id, twinA.id, twinB.id] } },
      });
    }

    // ── 2. scope 隔离：REP 只见本人；RM 见本人+下辖；空 scope → [] ─────────────
    console.log("\n[2] scope 隔离：REP / RM / 空 scope");
    {
      // REP-A、REP-B、RM（管 REP-A）、另一区域无关 REP-C
      const repAUser = await prisma.user.create({
        data: { email: `${PREFIX}-repA@test.local`, name: "RepA", password: "x", role: "REPRESENTATIVE" },
      });
      const repA = await prisma.representative.create({
        data: { name: "RepA", email: `${PREFIX}-repA@test.local` },
      });
      const repBUser = await prisma.user.create({
        data: { email: `${PREFIX}-repB@test.local`, name: "RepB", password: "x", role: "REPRESENTATIVE" },
      });
      await prisma.representative.create({
        data: { name: "RepB", email: `${PREFIX}-repB@test.local` },
      });
      const rmUser = await prisma.user.create({
        data: { email: `${PREFIX}-rm@test.local`, name: "RM", password: "x", role: "REGIONAL_MANAGER" },
      });
      const rm = await prisma.crmRegionManager.create({ data: { userId: rmUser.id } });
      await prisma.crmRegionManagerRepresentative.create({
        data: { managerId: rm.id, representativeId: repA.id },
      });

      // REP-A 客户、REP-B 客户
      const repACustomer = await prisma.crmCustomerProfile.create({
        data: {
          customerCode: `${PREFIX}-scope-a`,
          name: "REP-A 客户",
          ownerUserId: repAUser.id,
          stage: "ACTIVE",
          importance: "HIGH",
        },
      });
      const repBCustomer = await prisma.crmCustomerProfile.create({
        data: {
          customerCode: `${PREFIX}-scope-b`,
          name: "REP-B 客户",
          ownerUserId: repBUser.id,
          stage: "ACTIVE",
          importance: "HIGH",
        },
      });

      // REP-A 只见本人客户
      const repAResult = await listHotCustomersForActor(
        { userId: repAUser.id, role: "REPRESENTATIVE" },
        { limit: 50 },
      );
      const repAIds = repAResult.map((r) => r.profileId);
      console.log("    REP-A sees:", repAResult.map((r) => r.name));
      assert(repAIds.includes(repACustomer.id), "REP-A 看见本人客户");
      assert(!repAIds.includes(repBCustomer.id), "REP-A 看不见 REP-B 客户（scope 隔离）");

      // RM 见本人（管 REP-A）下辖，不见 REP-B
      const rmResult = await listHotCustomersForActor(
        { userId: rmUser.id, role: "REGIONAL_MANAGER" },
        { limit: 50 },
      );
      const rmIds = rmResult.map((r) => r.profileId);
      console.log("    RM sees:", rmResult.map((r) => r.name));
      assert(rmIds.includes(repACustomer.id), "RM 看见下辖 REP-A 客户");
      assert(!rmIds.includes(repBCustomer.id), "RM 看不见非下辖 REP-B 客户");

      // 空 scope：构造一个无任何 profile 的全新代表
      const emptyRepUser = await prisma.user.create({
        data: { email: `${PREFIX}-repEmpty@test.local`, name: "RepEmpty", password: "x", role: "REPRESENTATIVE" },
      });
      await prisma.representative.create({
        data: { name: "RepEmpty", email: `${PREFIX}-repEmpty@test.local` },
      });
      const emptyResult = await listHotCustomersForActor(
        { userId: emptyRepUser.id, role: "REPRESENTATIVE" },
        { limit: 50 },
      );
      assert(emptyResult.length === 0, "空 scope → []");

      // 清理
      await prisma.crmCustomerProfile.deleteMany({
        where: { id: { in: [repACustomer.id, repBCustomer.id] } },
      });
      await prisma.crmRegionManagerRepresentative.deleteMany({ where: { managerId: rm.id } });
      await prisma.crmRegionManager.delete({ where: { id: rm.id } });
      await prisma.user.deleteMany({
        where: { id: { in: [repAUser.id, repBUser.id, rmUser.id, emptyRepUser.id] } },
      });
      await prisma.representative.deleteMany({
        where: { email: { contains: `${PREFIX}-rep` } },
      });
    }

    // ── 3. limit clamp：默认 30；100 → 50；0 → 1（用 60 条数据验证）─────────────
    console.log("\n[3] limit clamp：默认 30 / 100→50 / 0→1");
    {
      // 建 60 条 ACTIVE 客户（全量 60 条确保 clamp 上限触发）。
      const created: string[] = [];
      for (let i = 0; i < 60; i += 20) {
        const batch: Array<{ id: string; name: string; customerCode: string }> = [];
        for (let j = 0; j < 20 && i + j < 60; j++) {
          batch.push({
            id: `${PREFIX}-clamp-${i + j}`,
            name: `clamping-${i + j}`,
            customerCode: `${PREFIX}-clamp-c${i + j}`,
          });
        }
        await prisma.$transaction(
          batch.map((b) =>
            prisma.crmCustomerProfile.create({
              data: {
                id: b.id,
                customerCode: b.customerCode,
                name: b.name,
                ownerUserId: admin.id,
                stage: "ACTIVE",
                importance: "NORMAL",
              },
            }),
          ),
        );
        created.push(...batch.map((b) => b.id));
      }
      assert(created.length === 60, "建了 60 条 fixture");

      // 默认 limit = 30
      const def = await listHotCustomersForActor({ userId: admin.id, role: "ADMIN" });
      assert(def.length === 30, `默认 limit=30（实际 ${def.length}）`);

      // limit=100 → clamp 到 50
      const over = await listHotCustomersForActor(
        { userId: admin.id, role: "ADMIN" },
        { limit: 100 },
      );
      assert(over.length === 50, `limit=100 → clamp 50（实际 ${over.length}）`);

      // limit=0 → clamp 到 1
      const zero = await listHotCustomersForActor(
        { userId: admin.id, role: "ADMIN" },
        { limit: 0 },
      );
      assert(zero.length === 1, `limit=0 → clamp 1（实际 ${zero.length}）`);

      // 清理
      await prisma.crmCustomerProfile.deleteMany({
        where: { id: { startsWith: `${PREFIX}-clamp-` } },
      });
    }

    // ── 4. USER → []（无权限角色）──────────────────────────────────────────────
    console.log("\n[4] USER 角色 → []");
    {
      // 先确保 ADMIN 下有可见客户
      await prisma.crmCustomerProfile.create({
        data: {
          customerCode: `${PREFIX}-user-probe`,
          name: "USER 探针客户",
          ownerUserId: admin.id,
          stage: "ACTIVE",
        },
      });
      const userUser = await prisma.user.create({
        data: { email: `${PREFIX}-user@test.local`, name: "PlainUser", password: "x", role: "USER" },
      });
      const userResult = await listHotCustomersForActor(
        { userId: userUser.id, role: "USER" },
        { limit: 50 },
      );
      assert(userResult.length === 0, "USER → []（不开放 Agent 热客户）");
      await prisma.user.delete({ where: { id: userUser.id } });
      await prisma.crmCustomerProfile.deleteMany({
        where: { customerCode: `${PREFIX}-user-probe` },
      });
    }

    // ── 5. ADMIN（null scope）正常返回 Top-N 且不超 limit ─────────────────────
    console.log("\n[5] ADMIN null scope：返回 Top-N 且不超 limit");
    {
      // 建 3 条不同阶段客户
      const ids = ["x-admin-top1", "x-admin-top2", "x-admin-top3"];
      await prisma.$transaction(
        ids.map((id, i) =>
          prisma.crmCustomerProfile.create({
            data: {
              id: `${PREFIX}-${id}`,
              customerCode: `${PREFIX}-${id}-c`,
              name: `ADMIN top ${i}`,
              ownerUserId: admin.id,
              stage: i === 0 ? "ACTIVE" : i === 1 ? "FOLLOWING" : "LEAD",
              importance: "NORMAL",
            },
          }),
        ),
      );
      const r1 = await listHotCustomersForActor(
        { userId: admin.id, role: "ADMIN" },
        { limit: 2 },
      );
      assert(r1.length === 2, `ADMIN limit=2 返回 2 条（实际 ${r1.length}）`);
      assert(r1[0].stage === "ACTIVE", "ADMIN Top-1 阶段=ACTIVE（按 comparator）");

      const r2 = await listHotCustomersForActor(
        { userId: admin.id, role: "ADMIN" },
        { limit: 10 },
      );
      assert(r2.length === 3, `ADMIN limit=10 但只有 3 条 → 返回 3（实际 ${r2.length}）`);
      assert(
        r2.every((r) => typeof r.profileId === "string"),
        "每条都有 profileId",
      );

      await prisma.crmCustomerProfile.deleteMany({
        where: { id: { startsWith: `${PREFIX}-x-admin-top` } },
      });
    }

    // ── 6. namePinyin null 回退 toPinyinToneless(name) ──────────────────────────
    console.log("\n[6] namePinyin=null → 回退 toPinyinToneless(name)");
    {
      // 显式不写 namePinyin（默认 null）
      const profile = await prisma.crmCustomerProfile.create({
        data: {
          customerCode: `${PREFIX}-pinyin-null`,
          name: "王晓明",
          ownerUserId: admin.id,
          stage: "ACTIVE",
          importance: "HIGH",
        },
        select: { id: true, namePinyin: true },
      });
      assert(profile.namePinyin === null, "fixture namePinyin 为 null");

      const result = await listHotCustomersForActor(
        { userId: admin.id, role: "ADMIN" },
        { limit: 50 },
      );
      const hit = result.find((r) => r.profileId === profile.id);
      assert(!!hit, "回退 namePinyin 的客户出现在结果里");
      const expected = toPinyinToneless("王晓明");
      console.log(`    回退 namePinyin: ${hit?.namePinyin}（期望 ${expected}）`);
      assert(hit?.namePinyin === expected, `回退值 = toPinyinToneless(name)（实际 ${hit?.namePinyin}）`);

      await prisma.crmCustomerProfile.delete({ where: { id: profile.id } });
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("❌ 热客户加载 smoke 失败");
    process.exit(1);
  }
  console.log("✅ 热客户加载 smoke 通过");
}

void main().catch((err) => {
  console.error("smoke-test-hot-customers crashed:", err);
  process.exit(2);
});
