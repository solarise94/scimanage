import assert from "node:assert";
import { normalizeOrderInput, scoreCandidate, normalizeText, type ScoringCandidate } from "@/lib/orders/match-scoring";
import { resolveImportRowMatch, toScoringCandidate } from "@/lib/orders/source-order-match";

// Helper: build a minimal ScoringCandidate for pure-function tests.
function makeCandidate(overrides: Partial<ScoringCandidate>): ScoringCandidate {
  return {
    profileId: "p1",
    name: "",
    customerCodeNorm: "",
    nameVariantsNorm: [],
    trustedAliasVariantsNorm: [],
    commonAliasVariantsNorm: [],
    wechatNorm: "",
    miniProgramIdNorm: "",
    phones: [],
    orgVariantsNorm: [],
    addressNorm: "",
    ...overrides,
  };
}

// 1. buyerCustomerCode exact match -> score 99 / customer_code_exact_match
const input = normalizeOrderInput({ buyerCustomerCode: "CUST-123" });
const candidate = makeCandidate({ customerCodeNorm: "cust-123", nameVariantsNorm: ["test"] });
const result = scoreCandidate(input, candidate);
assert.deepStrictEqual(result, { score: 99, reason: "customer_code_exact_match" });

// 2. toScoringCandidate: name comes from MatchCandidate.name only (Profile.name).
// profileName field has been removed; MatchCandidate.name IS the Profile display name.
const matchCandidate = {
  profileId: "p2",
  name: "林宇",
  customerCode: null,
  wechat: null,
  phone: null,
  principal: null,
  miniProgramId: null,
  organization: null,
  address: null,
  orgCanonicalName: null,
  orgNormalizedName: null,
  orgAliases: [],
  orgSiteNames: [],
  customerSiteName: null,
};
const scoringCand = toScoringCandidate(matchCandidate);
assert.strictEqual(scoringCand.name, "林宇");
assert.strictEqual(scoringCand.nameVariantsNorm.includes(normalizeText("林宇")), true);
const resolution = resolveImportRowMatch({ buyerName: "林宇" }, [matchCandidate]);
assert.strictEqual(resolution.best?.name, "林宇");
assert.strictEqual(resolution.best?.profileId, "p2");
assert.strictEqual(resolution.best?.score, 55);

// 3. normalizeText ignores whitespace so "张三" and "张 三" are equivalent
assert.strictEqual(normalizeText("张三"), normalizeText("张 三"));

// 4. Customer 旧姓名命中、Profile 姓名不命中 -> 不召回（nameVariantsNorm 只含 Profile name）
//    模拟 Customer.name="旧名"、Profile.name="林宇"。输入"旧名"时 scoreCandidate 应返回 null。
const profileOnlyCandidate = makeCandidate({
  nameVariantsNorm: [normalizeText("林宇")], // 只含 Profile name，旧 Customer name "旧名" 不在内
  orgVariantsNorm: [normalizeText("浙江大学")],
});
const oldNameInput = normalizeOrderInput({ buyerName: "旧名", buyerOrgName: "浙江大学" });
const oldNameResult = scoreCandidate(oldNameInput, profileOnlyCandidate);
assert.strictEqual(oldNameResult, null, "旧 Customer 姓名不应命中（Profile name 才参与评分）");

// 5. Customer 旧编号命中、Profile 编号不命中 -> 不召回
//    模拟 Customer.customerCode="OLD-CODE"、Profile.customerCode="NEW-CODE"。输入"OLD-CODE"时不应命中。
const profileCodeCandidate = makeCandidate({
  customerCodeNorm: normalizeText("NEW-CODE"),
});
const oldCodeInput = normalizeOrderInput({ buyerCustomerCode: "OLD-CODE" });
const oldCodeResult = scoreCandidate(oldCodeInput, profileCodeCandidate);
assert.strictEqual(oldCodeResult, null, "旧 Customer 编号不应命中（Profile customerCode 才参与评分）");

console.log("smoke-test-match-scoring passed");
