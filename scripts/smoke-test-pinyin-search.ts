/**
 * `crm.search_customers_by_pinyin` 拼音搜索工具 smoke（DB 集成，docs §6.2 / §10.1）。
 *
 * 用 withTempSmokeDb 建临时库，直接执行新 action 的 execute（不走 HTTP），覆盖：
 *  1. 冷客户不依赖时间窗口：建 220 个干扰 profile 后，再用最早创建的「王晓明」查「王小明」
 *     → candidates 含王晓明、matchType="exact-homophone"（旧实现 200 条窗口会漏）。
 *  2. 同音两人：周舟 + 周州 都在库，查「周舟」→ 两个候选都返回，scoreAndResolve 不判 UNIQUE。
 *  3. scope 隔离：REP-A 的客户对 REP-B 不可见（pinyin 工具路径）。
 *  4. limit clamp：limit=50 被夹到 10；不传 limit 默认 5。
 *  5. 拼音首字母：query「zsy」召回「张三阳」（matchType="pinyin-initial"，Set scope 全量内存路径）。
 *
 * 运行: npx tsx scripts/smoke-test-pinyin-search.ts
 */

import { withTempSmokeDb } from "./lib/temp-smoke-db";

const PREFIX = `SMK-PY-${Date.now().toString(36)}`;
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
  console.log("=== crm.search_customers_by_pinyin 拼音搜索 smoke ===\n");

  await withTempSmokeDb(async (handle) => {
    handle.assertSafePath();

    const { prisma } = await import("../src/lib/prisma");
    const { registerCrmActions } = await import("../src/lib/agent-actions/actions/crm");
    const { listAgentActions } = await import("../src/lib/agent-actions/registry");
    const { toPinyinToneless } = await import("../src/lib/crm/customer-name-resolver");
    registerCrmActions();
    const action = listAgentActions().find((a) => a.key === "crm.search_customers_by_pinyin");
    if (!action) {
      console.error("未找到 crm.search_customers_by_pinyin action");
      process.exit(2);
    }

    // 通用 ADMIN fixture（null scope，全量可见）。
    const admin = await prisma.user.create({
      data: { email: `${PREFIX}-admin@test.local`, name: "Admin", password: "x", role: "ADMIN" },
    });

    // ── 1. 冷客户不依赖时间窗口（220 干扰 + 王晓明最早创建）────────────────────
    console.log("[1] 220 干扰客户后，「王小明」仍能召回最早创建的「王晓明」并标记 exact-homophone");
    {
      // 先建目标「王晓明」（时间戳最早），再建 220 个干扰 profile（循环生成）。
      const wxm = await prisma.crmCustomerProfile.create({
        data: {
          customerCode: `${PREFIX}-wxm`,
          name: "王晓明",
          namePinyin: toPinyinToneless("王晓明"),
          organization: "中科院A所",
          ownerUserId: admin.id,
        },
      });
      const distractorCount = 220;
      const distractorIds: string[] = [];
      for (let i = 0; i < distractorCount; i += 100) {
        const slice = Array.from({ length: Math.min(100, distractorCount - i) }, (_, j) => {
          const idx = i + j;
          return {
            id: `${PREFIX}-d${idx}`,
            customerCode: `${PREFIX}-dc${idx}`,
            name: `干扰客户${idx}`,
            namePinyin: toPinyinToneless(`干扰客户${idx}`) || null,
            ownerUserId: admin.id,
          };
        });
        await prisma.$transaction(
          slice.map((p) =>
            prisma.crmCustomerProfile.create({
              data: {
                id: p.id,
                customerCode: p.customerCode,
                name: p.name,
                namePinyin: p.namePinyin,
                ownerUserId: p.ownerUserId,
              },
            }),
          ),
        );
        distractorIds.push(...slice.map((s) => s.id));
      }

      // 等一下让 updatedAt 顺序稳定（干扰客户 updatedAt 都晚于王晓明）。
      const parsed = action!.parseInput({ spokenName: "王小明" });
      const output = await action!.execute(
        { actor: { userId: admin.id, role: "ADMIN", name: "Admin", email: admin.email }, invocation: { channel: "agent" as const } },
        parsed,
      ) as {
        query: string;
        queryPinyin: string;
        candidates: Array<{ profileId: string; name: string; matchType: string; score: number }>;
        total: number;
      };

      console.log(
        "    top candidates:",
        output.candidates.slice(0, 3).map((c) => `${c.name}:${c.matchType}:${c.score}`),
      );
      const wxmCandidate = output.candidates.find((c) => c.profileId === wxm.id);
      assert(!!wxmCandidate, "王晓明 被召回（不依赖时间窗口）");
      assert(wxmCandidate?.matchType === "exact-homophone", `matchType="exact-homophone"（实际 ${wxmCandidate?.matchType}）`);
      assert(output.query === "王小明", "query 原样回显");
      assert(output.queryPinyin === toPinyinToneless("王小明"), "queryPinyin 等于 spoken 的去声调全拼");

      // 清理干扰 + 目标。
      await prisma.crmCustomerProfile.deleteMany({ where: { id: { in: [...distractorIds, wxm.id] } } });
    }

    // ── 2. 同音两人：周舟 + 周州，查「周舟」→ 两个候选都返回，不判 UNIQUE ────────
    console.log("\n[2] 同音两人（周舟 / 周州）：查「周舟」返回两候选，matchType 标注正确");
    {
      const zz1 = await prisma.crmCustomerProfile.create({
        data: {
          customerCode: `${PREFIX}-zz1`,
          name: "周舟",
          namePinyin: toPinyinToneless("周舟"),
          ownerUserId: admin.id,
        },
      });
      const zz2 = await prisma.crmCustomerProfile.create({
        data: {
          customerCode: `${PREFIX}-zz2`,
          name: "周州",
          namePinyin: toPinyinToneless("周州"),
          ownerUserId: admin.id,
        },
      });

      const parsed = action!.parseInput({ spokenName: "周舟", limit: 10 });
      const output = await action!.execute(
        { actor: { userId: admin.id, role: "ADMIN", name: "Admin", email: admin.email }, invocation: { channel: "agent" as const } },
        parsed,
      ) as {
        resolution: string;
        candidates: Array<{ profileId: string; name: string; matchType: string }>;
        total: number;
      };

      console.log("    candidates:", output.candidates.map((c) => `${c.name}:${c.matchType}`));
      const ids = output.candidates.map((c) => c.profileId);
      assert(ids.includes(zz1.id) && ids.includes(zz2.id), "两个同音候选都被召回");
      assert(output.candidates.length >= 2, "candidates.length >= 2");
      assert(output.total >= 2, "total >= 2");
      // 周舟（精确，name-contains）+ 周州（同音，exact-homophone）。
      const zz1Type = output.candidates.find((c) => c.profileId === zz1.id)?.matchType;
      const zz2Type = output.candidates.find((c) => c.profileId === zz2.id)?.matchType;
      assert(zz2Type === "exact-homophone", `周州 matchType="exact-homophone"（实际 ${zz2Type}）`);
      // review P2#4：工具现在输出 resolution（基于完整候选结论，不再被 limit 截断误判）。
      // 同音两人 → AMBIGUOUS（不会被当作唯一命中自动进入名片）。
      assert(output.resolution === "AMBIGUOUS", `同音两人 resolution="AMBIGUOUS"（实际 ${output.resolution}）`);

      await prisma.crmCustomerProfile.deleteMany({ where: { id: { in: [zz1.id, zz2.id] } } });
    }

    // ── 2b. 正确姓名匹配 → resolution=UNIQUE（review P2#4 正向修复）──────────────
    //
    // 旧实现下 route 用 matchType==="exact-homophone" 推断唯一性，导致「正确姓名命中
    // (name-contains, 100分)」反而被判 name-contains 展示确认卡，而 88 分的同音命中却
    // 自动展开。修复后两个 route 统一消费 resolution=UNIQUE，正确姓名命中也应 UNIQUE。
    console.log("\n[2b] 正确姓名匹配（周舟查周舟，唯一候选）→ resolution=UNIQUE");
    {
      const zz = await prisma.crmCustomerProfile.create({
        data: {
          customerCode: `${PREFIX}-zz-unique`,
          name: "周舟",
          namePinyin: toPinyinToneless("周舟"),
          ownerUserId: admin.id,
        },
      });

      const parsed = action!.parseInput({ spokenName: "周舟", limit: 5 });
      const output = await action!.execute(
        { actor: { userId: admin.id, role: "ADMIN", name: "Admin", email: admin.email }, invocation: { channel: "agent" as const } },
        parsed,
      ) as { resolution: string; candidates: Array<{ profileId: string; matchType: string; name?: string }> };

      console.log("    resolution:", output.resolution, "candidates:", output.candidates.map((c) => `${c.name ?? c.profileId}:${c.matchType}`));
      assert(output.resolution === "UNIQUE", `正确姓名唯一匹配 resolution="UNIQUE"（实际 ${output.resolution}）`);

      await prisma.crmCustomerProfile.deleteMany({ where: { id: zz.id } });
    }

    // ── 3. scope 隔离：REP-A 的客户对 REP-B 不可见 ──────────────────────────────
    console.log("\n[3] scope 隔离：REP-A 查询时 REP-B 的客户不被召回");
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

      // repB 的客户「赵六」。
      const profileZl = await prisma.crmCustomerProfile.create({
        data: {
          customerCode: `${PREFIX}-zl`,
          name: "赵六",
          namePinyin: toPinyinToneless("赵六"),
          ownerUserId: repB.id,
        },
      });

      const parsed = action!.parseInput({ spokenName: "赵六" });
      const output = await action!.execute(
        { actor: { userId: repA.id, role: "REPRESENTATIVE", name: "RepA", email: repA.email }, invocation: { channel: "agent" as const } },
        parsed,
      ) as { candidates: Array<{ profileId: string }>; total: number };

      const ids = output.candidates.map((c) => c.profileId);
      assert(!ids.includes(profileZl.id), "repB 的客户「赵六」未被 repA 召回（scope 隔离）");
      // 不返回 scope 外候选数量（防侧信道）——total 只反映 scope 内召回数。
      assert(output.total === output.candidates.length, "total 等于 candidates 数量（不泄漏 scope 外）");

      await prisma.crmCustomerProfile.deleteMany({ where: { id: profileZl.id } });
      await prisma.user.deleteMany({ where: { id: { in: [repA.id, repB.id] } } });
    }

    // ── 4. limit clamp：limit=50 → 10；limit=2 → 2（下界 1，不再被抬到 5）；默认 5 ─
    console.log("\n[4] limit clamp：limit=50 夹到 10；limit=2 保持 2；默认 5");
    {
      // 建 15 个同名候选，远超 limit。
      const sameNameIds: string[] = [];
      for (let i = 0; i < 15; i += 50) {
        const slice = Array.from({ length: Math.min(50, 15 - i) }, (_, j) => {
          const idx = i + j;
          return {
            id: `${PREFIX}-sn${idx}`,
            customerCode: `${PREFIX}-snc${idx}`,
            name: "同名客户",
            namePinyin: toPinyinToneless("同名客户"),
            ownerUserId: admin.id,
          };
        });
        await prisma.$transaction(
          slice.map((p) =>
            prisma.crmCustomerProfile.create({
              data: {
                id: p.id,
                customerCode: p.customerCode,
                name: p.name,
                namePinyin: p.namePinyin,
                ownerUserId: p.ownerUserId,
              },
            }),
          ),
        );
        sameNameIds.push(...slice.map((s) => s.id));
      }

      // parseInput 直接断言 clamp 后的 limit 值，避免 gather/score 副作用干扰。
      const parsed50 = action!.parseInput({ spokenName: "同名客户", limit: 50 }) as { limit: number };
      assert(parsed50.limit === 10, `limit=50 被 clamp 到 10（实际 ${parsed50.limit}）`);

      const parsed2 = action!.parseInput({ spokenName: "同名客户", limit: 2 }) as { limit: number };
      assert(parsed2.limit === 2, `limit=2 保持 2（clamp 1..10 下界=1，实际 ${parsed2.limit}）`);

      const parsed1 = action!.parseInput({ spokenName: "同名客户", limit: 1 }) as { limit: number };
      assert(parsed1.limit === 1, `limit=1 保持 1（下界，实际 ${parsed1.limit}）`);

      const parsedDefault = action!.parseInput({ spokenName: "同名客户" }) as { limit: number };
      assert(parsedDefault.limit === 5, `不传 limit 默认 5（实际 ${parsedDefault.limit}）`);

      // 顺便校验 execute 路径不会超过 clamp 后的 limit。
      const output50 = await action!.execute(
        { actor: { userId: admin.id, role: "ADMIN", name: "Admin", email: admin.email }, invocation: { channel: "agent" as const } },
        parsed50,
      ) as { candidates: unknown[]; total: number };
      assert(output50.candidates.length <= 10, `limit=50 执行结果 ≤10（实际 ${output50.candidates.length}）`);

      await prisma.crmCustomerProfile.deleteMany({ where: { id: { in: sameNameIds } } });
    }

    // ── 5. 拼音首字母：query「zsy」→ 召回「张三阳」（matchType=pinyin-initial）───
    console.log("\n[5] 拼音首字母：query=zsy → 召回 张三阳，matchType=pinyin-initial");
    {
      const profileZsy = await prisma.crmCustomerProfile.create({
        data: {
          customerCode: `${PREFIX}-zsy`,
          name: "张三阳",
          namePinyin: toPinyinToneless("张三阳"),
          organization: "E所",
          ownerUserId: admin.id,
        },
      });

      // ADMIN（null scope）走 namePinyin 精确 + 最近 500 条内存 pinyin-match fallback。
      const parsed = action!.parseInput({ spokenName: "zsy" });
      const output = await action!.execute(
        { actor: { userId: admin.id, role: "ADMIN", name: "Admin", email: admin.email }, invocation: { channel: "agent" as const } },
        parsed,
      ) as { candidates: Array<{ profileId: string; name: string; matchType: string; score: number }> };

      console.log("    candidates:", output.candidates.map((c) => `${c.name}:${c.matchType}:${c.score}`));
      const zsyCandidate = output.candidates.find((c) => c.profileId === profileZsy.id);
      assert(!!zsyCandidate, "张三阳 被 zsy 召回（拼音首字母路径存活）");
      assert(
        zsyCandidate?.matchType === "pinyin-initial",
        `matchType="pinyin-initial"（实际 ${zsyCandidate?.matchType}）`,
      );

      await prisma.crmCustomerProfile.deleteMany({ where: { id: profileZsy.id } });
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("❌ 拼音搜索 smoke 失败");
    process.exit(1);
  }
  console.log("✅ 拼音搜索 smoke 通过");
}

void main().catch((err) => {
  console.error("smoke-test-pinyin-search crashed:", err);
  process.exit(2);
});
