/**
 * Agent 语音客户名解析 smoke test —— 纯函数层（不碰 DB）。
 *
 * 仅测试 scoreAndResolve：用合成候选覆盖以下场景：
 *  1. ASR 同音错字（"王小明" → 唯一候选 "王晓明"）→ UNIQUE，reasons 含发音原因。
 *  2. 两个同音候选（周舟 / 周州）→ AMBIGUOUS，不擅自唯一。
 *  3. 同名跨机构 + organizationHint → 正确候选排第一。
 *  4. 拼音首字母（zsy）命中张三阳但不越过阈值 → AMBIGUOUS（按实际阈值行为断言）。
 *  5. 无候选 → NO_MATCH。
 *
 * 运行: npx tsx scripts/smoke-test-customer-name-resolver.ts
 */

import {
  scoreAndResolve,
  UNIQUE_MIN_SCORE,
  UNIQUE_MARGIN,
  type GatheredCandidate,
  type NameResolutionHints,
} from "@/lib/crm/customer-name-resolver";

let pass = 0;
let fail = 0;

function ok(msg: string) {
  console.log(`  ✓ ${msg}`);
  pass++;
}

function failMsg(msg: string) {
  console.log(`  ✗ ${msg}`);
  fail++;
}

function check(cond: boolean, msg: string) {
  if (cond) ok(msg);
  else failMsg(msg);
}

function makeCandidate(overrides: Partial<GatheredCandidate>): GatheredCandidate {
  const { namePinyin, ...rest } = overrides;
  return {
    profileId: "p1",
    name: "",
    organization: null,
    ownerName: null,
    principal: null,
    lastInteractionAt: null,
    aliases: [],
    ...rest,
    // Partial 可能带入 undefined；GatheredCandidate 要求 string | null。
    namePinyin: namePinyin ?? null,
  };
}

// ── 1. ASR 同音错字：王小明（转写）→ 王晓明（候选）→ UNIQUE ────────────────
console.log("[1] ASR 同音错字（王小明 → 王晓明）应判 UNIQUE 且 reasons 含发音原因");
{
  const candidates = [
    makeCandidate({ profileId: "p-wxm", name: "王晓明", organization: "中科院A所" }),
    // 一个明显不相关的候选，确保不干扰
    makeCandidate({ profileId: "p-other", name: "李四", organization: "B 大学" }),
  ];
  const result = scoreAndResolve("王小明", candidates);
  console.log("    resolution:", result.resolution, "candidates:", result.candidates.map((c) => `${c.name}:${c.score}`));
  check(result.resolution === "UNIQUE", "resolution === UNIQUE");
  check(result.candidates[0]?.profileId === "p-wxm", "王晓明 排第一");
  check(result.candidates[0]?.score >= UNIQUE_MIN_SCORE, `第一名得分 ≥ ${UNIQUE_MIN_SCORE}（实际 ${result.candidates[0]?.score}）`);
  const hasPinyinReason = result.candidates[0]?.reasons.some((r) => r.includes("发音相同")) ?? false;
  check(hasPinyinReason, "reasons 含「发音相同（同音错字）」");
}

// ── 2. 两个同音候选（周舟 / 周州）→ AMBIGUOUS，不擅自唯一 ────────────────────
//
// 说明：转写「周舟」精确命中候选 周舟（100），候选 周州 同音（PINYIN_EXACT 88）。
// 差值 12 刚好等于 base UNIQUE_MARGIN，但第二名已进入同音档（≥ PINYIN_EXACT），
// 决策会用更大的 margin（+5=17），因此 12 < 17 → AMBIGUOUS，避免同音误唯一化。
console.log("\n[2] 两个同音候选（周舟 / 周州）应判 AMBIGUOUS");
{
  const candidates = [
    makeCandidate({ profileId: "p-zhou1", name: "周舟", organization: "C 所" }),
    makeCandidate({ profileId: "p-zhou2", name: "周州", organization: "D 大学" }),
  ];
  const result = scoreAndResolve("周舟", candidates);
  console.log("    resolution:", result.resolution, "candidates:", result.candidates.map((c) => `${c.name}:${c.score}`));
  check(result.resolution === "AMBIGUOUS", "resolution === AMBIGUOUS（同音候选存在时不擅自唯一）");
  check(result.candidates.length >= 2, "至少返回 2 个候选");
  if (result.candidates.length >= 2) {
    const diff = result.candidates[0].score - result.candidates[1].score;
    const secondScore = result.candidates[1].score;
    check(
      secondScore >= 88 && diff < UNIQUE_MARGIN + 5,
      `第二名进入同音档(≥88)且差值 ${diff} < margin+5(${UNIQUE_MARGIN + 5})`,
    );
  }
}

// ── 2b. 两个同音候选 + limit=1 应判 AMBIGUOUS（review P1#1 复现场景）──────────────
//
// 这是 review 点名的核心 bug：旧实现先 `filtered.slice(0, limit)` 再用 truncated[1]
// 判歧义，limit=1 时第二名被截掉，两个同音客户（周舟/周州）会被错误判为 UNIQUE，
// 进而自动进入客户名片。修复后 resolution 始终基于完整候选前两名，limit 只截断展示。
console.log("\n[2b] 两个同音候选 + limit=1 应判 AMBIGUOUS（不被 limit 截断误判唯一）");
{
  const candidates = [
    makeCandidate({ profileId: "p-zhou1", name: "周舟", organization: "C 所" }),
    makeCandidate({ profileId: "p-zhou2", name: "周州", organization: "D 大学" }),
  ];
  const result = scoreAndResolve("周舟", candidates, {}, { limit: 1 });
  console.log("    resolution:", result.resolution, "candidates:", result.candidates.length, "(limit=1)");
  // 展示候选被截断到 1，但 resolution 必须反映完整候选的歧义结论。
  check(result.candidates.length === 1, "candidates 被 limit=1 截断到 1（仅展示）");
  check(result.resolution === "AMBIGUOUS", "resolution === AMBIGUOUS（limit 不影响唯一性结论）");
}

// ── 3. 同名跨机构 + organizationHint → 正确候选排第一 ──────────────────────────
//
// tieBreaker 修复后：两人姓名完全匹配（score=100），机构 hint 命中累加到
// tieBreaker（+8）而非 score，因此 score 相等时按 tieBreaker 排序，A所候选胜出。
console.log("\n[3] 同名跨机构 + organizationHint 应让匹配机构的候选排第一（tieBreaker 打破平局）");
{
  const candidates = [
    makeCandidate({ profileId: "p-zhang-A", name: "张三", organization: "中科院A所" }),
    makeCandidate({ profileId: "p-zhang-B", name: "张三", organization: "B 大学" }),
  ];
  const hints: NameResolutionHints = { organizationHint: "A所" };
  const result = scoreAndResolve("张三", candidates, hints);
  console.log("    resolution:", result.resolution, "candidates:", result.candidates.map((c) => `${c.name}@${c.organization}:${c.score}:tb=${c.tieBreaker ?? 0}`));
  // 强断言：tieBreaker 让机构命中的候选排第一（之前因 clamp 平局被弱化成「存在」）。
  check(result.candidates[0]?.profileId === "p-zhang-A", "A所 候选排第一（tieBreaker 打破同名平局）");
  check(result.candidates[0]?.score === 100, "A所 候选 score=100（姓名精确）");
  check((result.candidates[0]?.tieBreaker ?? 0) > 0, "A所 候选 tieBreaker > 0（机构命中）");
  check((result.candidates[0]?.reasons ?? []).some((r) => r.includes("机构线索")), "A所 候选 reasons 含机构线索命中");

  // 补一个更强的对比场景：姓名非精确（拼音接近），机构 hint 决定排序。
  const candidates2 = [
    makeCandidate({ profileId: "p-li-A", name: "李四一", organization: "中科院A所" }),
    makeCandidate({ profileId: "p-li-B", name: "李四二", organization: "B 大学" }),
  ];
  const result2 = scoreAndResolve("李四", candidates2, { organizationHint: "A所" });
  console.log("    resolution2:", result2.resolution, "candidates:", result2.candidates.map((c) => `${c.name}@${c.organization}:${c.score}:tb=${c.tieBreaker ?? 0}`));
  check(result2.candidates[0]?.profileId === "p-li-A", "含机构 hint 时 A所 候选排第一");
}

// ── 4. 拼音首字母（zsy）命中张三阳但不越过阈值 → AMBIGUOUS ───────────────────
//
// 说明：scoreAndResolve 对纯拼音/首字母输入走 PINYIN_MATCH 档（65 分），低于
// UNIQUE_MIN_SCORE（85）。只要有候选（score>0）但不达 UNIQUE 条件，resolution
// 即为 AMBIGUOUS（不判 NO_MATCH，因为有命中信号；也不判 UNIQUE，因分数不够）。
// 这里不 mock pinyin-match，用真实库行为断言。
console.log("\n[4] 拼音首字母（zsy）命中张三阳但不越阈值 → AMBIGUOUS");
{
  const candidates = [
    makeCandidate({ profileId: "p-zsy", name: "张三阳", organization: "E 所" }),
  ];
  const result = scoreAndResolve("zsy", candidates);
  console.log("    resolution:", result.resolution, "candidates:", result.candidates.map((c) => `${c.name}:${c.score}:${c.reasons.join("|")}`));
  check(result.candidates.length >= 1, "至少有 1 个候选（pinyin-match 命中）");
  check(result.candidates[0].score < UNIQUE_MIN_SCORE, `得分 < ${UNIQUE_MIN_SCORE}（实际 ${result.candidates[0].score}）`);
  check(result.resolution === "AMBIGUOUS", "resolution === AMBIGUOUS（分数不足，不擅自唯一）");
}

// ── 5. 无候选 → NO_MATCH ────────────────────────────────────────────────────
console.log("\n[5] 无候选 → NO_MATCH");
{
  const result = scoreAndResolve("不存在的客户名", []);
  console.log("    resolution:", result.resolution, "candidates:", result.candidates.length);
  check(result.resolution === "NO_MATCH", "resolution === NO_MATCH");
  check(result.candidates.length === 0, "candidates 为空");
}

// ── 6. 边界：limit clamp 与决策阈值导出常量 ──────────────────────────────────
console.log("\n[6] limit clamp（1-10）与阈值常量已导出");
{
  const many = Array.from({ length: 20 }, (_, i) =>
    makeCandidate({ profileId: `p${i}`, name: `同名${i}`, organization: `org${i}` }),
  );
  const r5 = scoreAndResolve("同名", many, {}, { limit: 5 });
  check(r5.candidates.length <= 5, "limit=5 截断到 ≤5");

  const rClamped = scoreAndResolve("同名", many, {}, { limit: 999 });
  check(rClamped.candidates.length <= 10, "limit=999 被 clamp 到 ≤10");

  const r0 = scoreAndResolve("同名", many, {}, { limit: 0 });
  check(r0.candidates.length >= 1, "limit=0 被 clamp 到 ≥1");

  check(typeof UNIQUE_MIN_SCORE === "number" && UNIQUE_MIN_SCORE > 0, "UNIQUE_MIN_SCORE 已导出且为正数");
  check(typeof UNIQUE_MARGIN === "number" && UNIQUE_MARGIN > 0, "UNIQUE_MARGIN 已导出且为正数");
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("❌ 客户名解析 smoke 测试失败");
  process.exit(1);
}
console.log("✅ 客户名解析 smoke 测试通过");
