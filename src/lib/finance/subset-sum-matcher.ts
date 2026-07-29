/**
 * 共享子集和 / 组合匹配引擎。
 *
 * 从 `src/app/api/finance/payment-vouchers/match/route.ts` 抽取的纯函数版本：
 * DP 精确子集和（带内存守卫）→ 内存超限时 MITM 兜底 → 候选过多时降级为贪心参考 + 最近邻。
 * 不依赖 Prisma / Next.js，可被 API route 与 agent action 共用。
 */

// ─── Constants ──────────────────────────────────────────────────

/** DFS 先尽量枚举再排序截断；避免「先到先截」丢掉更优组合 */
const MAX_ENUMERATED = 1_000;
const MAX_N_FOR_EXACT = 40;
/** 与 200MB 守卫自洽：200_000_000 / (MAX_N+1) ≈ 4.88M 分 ≈ ¥4.88 万 */
const MAX_DP_BYTES = 200_000_000;
const MAX_T_FOR_DP = Math.floor(MAX_DP_BYTES / (MAX_N_FOR_EXACT + 1));
/** nearest 路径为单行 DP，单独限制数组长度，避免 extendedTarget OOM */
const MAX_NEAREST_CELLS = 200_000_000;

const DEFAULT_MAX_COMBINATIONS = 10;
const DEFAULT_MAX_ITEMS = MAX_N_FOR_EXACT;

// ─── Public types ───────────────────────────────────────────────

export type SubsetSumInput = {
  items: Array<{ id: string; amountCents: number }>;
  targetCents: number;
  /** 返回组合数上限，默认 10 */
  maxCombinations?: number;
  /** 精确子集和最大候选数，超出走 greedy 降级，默认 40 */
  maxItems?: number;
};

export type SubsetSumResult = {
  status: "MATCHED" | "NO_EXACT_MATCH";
  combinations: Array<Array<{ id: string; amountCents: number }>>;
  /** 单位：分。仅金额，不含 ids */
  nearestBelow?: number;
  /** 单位：分。仅金额，不含 ids */
  nearestAbove?: number;
  degraded?: boolean;
  reason?: "SUM_SHORTFALL" | "NO_SUBSET_EQUALS" | "TOO_MANY_CANDIDATES";
  truncated?: boolean;
  totalFound?: number;
  heuristicReference?: {
    ids: string[];
    amounts: number[];
    sum: number;
    method: "GREEDY_LARGEST_FIRST";
  };
};

// ─── Internal helpers ───────────────────────────────────────────

type Item = { id: string; amount: number };

function canAllocateSuffixDp(n: number, targetCents: number): boolean {
  if (n > MAX_N_FOR_EXACT || targetCents > MAX_T_FOR_DP || targetCents < 0) return false;
  return (n + 1) * (targetCents + 1) <= MAX_DP_BYTES;
}

/**
 * Meet-in-the-middle 精确子集和：n≤40 时 2×2^20 ≈ 200 万，可在 DP 内存超限时兜底精确解。
 */
function findExactCombinationsMitm(
  items: Item[],
  targetCents: number,
): { combinations: string[][]; truncated: boolean; totalFound: number } {
  const n = items.length;
  if (n === 0 || n > MAX_N_FOR_EXACT) {
    return { combinations: [], truncated: false, totalFound: 0 };
  }

  const mid = Math.floor(n / 2);
  const left = items.slice(0, mid);
  const right = items.slice(mid);

  // sum → 若干子集（每 sum 最多保留几条，避免组合爆炸）
  const PER_SUM_CAP = 8;
  const leftMap = new Map<number, string[][]>();
  const leftN = left.length;
  for (let mask = 0; mask < 1 << leftN; mask++) {
    let sum = 0;
    const ids: string[] = [];
    for (let i = 0; i < leftN; i++) {
      if (mask & (1 << i)) {
        sum += left[i].amount;
        ids.push(left[i].id);
      }
    }
    if (sum > targetCents) continue;
    const bucket = leftMap.get(sum);
    if (!bucket) leftMap.set(sum, [ids]);
    else if (bucket.length < PER_SUM_CAP) bucket.push(ids);
  }

  const results: string[][] = [];
  let truncated = false;
  const rightN = right.length;
  for (let mask = 0; mask < 1 << rightN; mask++) {
    if (results.length >= MAX_ENUMERATED) {
      truncated = true;
      break;
    }
    let sum = 0;
    const ids: string[] = [];
    for (let i = 0; i < rightN; i++) {
      if (mask & (1 << i)) {
        sum += right[i].amount;
        ids.push(right[i].id);
      }
    }
    if (sum > targetCents) continue;
    const leftCombos = leftMap.get(targetCents - sum);
    if (!leftCombos) continue;
    for (const lc of leftCombos) {
      results.push(lc.length === 0 ? [...ids] : ids.length === 0 ? [...lc] : [...lc, ...ids]);
      if (results.length >= MAX_ENUMERATED) {
        truncated = true;
        break;
      }
    }
  }

  return { combinations: results, truncated, totalFound: results.length };
}

/** 贪心最大票优先：不超过 target 的参考组合（非精确）。 */
function findGreedyReference(
  items: Item[],
  targetCents: number,
): { ids: string[]; sum: number } | null {
  if (items.length === 0 || targetCents <= 0) return null;
  const sorted = [...items].sort((a, b) => b.amount - a.amount);
  const ids: string[] = [];
  let sum = 0;
  for (const it of sorted) {
    if (it.amount <= targetCents - sum) {
      ids.push(it.id);
      sum += it.amount;
    }
  }
  if (ids.length === 0) return null;
  return { ids, sum };
}

function findExactCombinations(
  items: Item[],
  targetCents: number,
): { combinations: string[][]; degraded: boolean; truncated: boolean; totalFound: number } {
  const n = items.length;
  if (n === 0) return { combinations: [], degraded: false, truncated: false, totalFound: 0 };

  const amounts = items.map((it) => it.amount);

  // suffixSum[i] = sum of items[i..n)
  const suffixSum = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    suffixSum[i] = suffixSum[i + 1] + amounts[i];
  }

  // suffixPossible[i][s] = can we make sum s from items[i..)?
  let suffixPossible: Uint8Array[] | null = null;

  if (canAllocateSuffixDp(n, targetCents)) {
    suffixPossible = new Array(n + 1);
    suffixPossible[n] = new Uint8Array(targetCents + 1);
    suffixPossible[n][0] = 1;

    for (let i = n - 1; i >= 0; i--) {
      const cur = new Uint8Array(targetCents + 1);
      const next = suffixPossible[i + 1]!;
      const amt = amounts[i];
      for (let s = 0; s <= targetCents; s++) {
        if (next[s]) {
          cur[s] = 1;
        } else if (s >= amt && next[s - amt]) {
          cur[s] = 1;
        }
      }
      suffixPossible[i] = cur;
    }
  } else if (n <= MAX_N_FOR_EXACT) {
    // DP 内存超限但 n 可控：MITM 精确兜底（非 degraded）
    const mitm = findExactCombinationsMitm(items, targetCents);
    return {
      combinations: mitm.combinations,
      degraded: false,
      truncated: mitm.truncated,
      totalFound: mitm.totalFound,
    };
  } else {
    // n 过大：无法精确枚举，标记 degraded，由调用方附贪心参考
    return { combinations: [], degraded: true, truncated: false, totalFound: 0 };
  }

  const results: string[][] = [];
  let truncated = false;
  const path: string[] = [];

  function dfs(i: number, remain: number) {
    if (remain === 0) {
      results.push([...path]);
      if (results.length >= MAX_ENUMERATED) truncated = true;
      return;
    }
    if (truncated) return;
    if (i >= n) return;
    if (suffixSum[i] < remain) return;

    if (suffixPossible && !suffixPossible[i]![remain]) return;

    // Skip items[i]
    dfs(i + 1, remain);

    // Take items[i]
    if (remain >= amounts[i]) {
      path.push(items[i].id);
      dfs(i + 1, remain - amounts[i]);
      path.pop();
    }
  }

  dfs(0, targetCents);

  return { combinations: results, degraded: false, truncated, totalFound: results.length };
}

function findNearestCombinations(
  items: Item[],
  targetCents: number,
): { below: { ids: string[]; sum: number } | null; above: { ids: string[]; sum: number } | null } {
  const n = items.length;
  if (n === 0) return { below: null, above: null };
  if (targetCents < 0 || targetCents + 1 > MAX_NEAREST_CELLS) {
    return { below: null, above: null };
  }

  const amounts = items.map((it) => it.amount);

  // 1D DP to find best "at most" and "at least"
  const dp = new Uint8Array(targetCents + 1);
  dp[0] = 1;

  for (let i = 0; i < n; i++) {
    const amt = amounts[i];
    for (let s = targetCents; s >= amt; s--) {
      if (dp[s - amt]) dp[s] = 1;
    }
  }

  // Find "nearest below" — when called from NO_SUBSET_EQUALS, target is unreachable so below < target
  let belowSum = 0;
  for (let s = targetCents; s >= 0; s--) {
    if (dp[s]) {
      belowSum = s;
      break;
    }
  }

  // Find "nearest above" - extend DP past target, hard-capped to avoid OOM
  const totalSum = amounts.reduce((a, b) => a + b, 0);
  const extendedTarget = Math.min(totalSum, targetCents * 2, MAX_NEAREST_CELLS - 1);
  let aboveSum = -1;
  if (extendedTarget >= targetCents) {
    const edp = new Uint8Array(extendedTarget + 1);
    edp[0] = 1;
    for (let i = 0; i < n; i++) {
      const amt = amounts[i];
      for (let s = extendedTarget; s >= amt; s--) {
        if (edp[s - amt]) edp[s] = 1;
      }
    }

    for (let s = targetCents; s <= extendedTarget; s++) {
      if (edp[s]) {
        aboveSum = s;
        break;
      }
    }
  }

  return {
    below: belowSum > 0 ? extractOneCombination(items, belowSum) : null,
    above: aboveSum > 0 ? extractOneCombination(items, aboveSum) : null,
  };
}

/**
 * Extract ONE combination that sums to `target` using proper DP backtracking.
 * Uses a parent-link array during DP to guarantee reconstruction always succeeds
 * for any reachable sum. Avoids the greedy-approximation bug where valid sums
 * like [4,3,3] → 6 would fail to extract.
 */
function extractOneCombination(items: Item[], target: number): { ids: string[]; sum: number } | null {
  if (target <= 0) return null;
  if (target + 1 > MAX_NEAREST_CELLS) return null;
  const n = items.length;
  // parent[s] = index i of the item that was last added to reach sum s, or -1
  const parent = new Int32Array(target + 1).fill(-1);
  const dp = new Uint8Array(target + 1);
  dp[0] = 1;

  for (let i = 0; i < n; i++) {
    const amt = items[i].amount;
    for (let s = target; s >= amt; s--) {
      if (dp[s - amt] && !dp[s]) {
        dp[s] = 1;
        parent[s] = i;
      }
    }
    if (dp[target]) break; // early exit once reachable
  }

  if (!dp[target]) return null;

  // Reconstruct
  const ids: string[] = [];
  let s = target;
  while (s > 0) {
    const i = parent[s];
    if (i < 0) break; // shouldn't happen for reachable sums
    ids.push(items[i].id);
    s -= items[i].amount;
  }
  return { ids, sum: target };
}

// ─── Public API ─────────────────────────────────────────────────

export function subsetSumMatch(input: SubsetSumInput): SubsetSumResult {
  const targetCents = input.targetCents;
  const maxCombinations = input.maxCombinations ?? DEFAULT_MAX_COMBINATIONS;
  const maxItems = input.maxItems ?? DEFAULT_MAX_ITEMS;

  const items: Item[] = input.items.map((it) => ({ id: it.id, amount: it.amountCents }));
  const itemAmountById = new Map(items.map((it) => [it.id, it.amount]));
  const candidateTotal = items.reduce((s, it) => s + it.amount, 0);

  // 1. SUM_SHORTFALL：候选合计不足，无需跑组合算法
  if (candidateTotal < targetCents) {
    return {
      status: "NO_EXACT_MATCH",
      combinations: [],
      reason: "SUM_SHORTFALL",
      nearestBelow: candidateTotal,
      degraded: false,
    };
  }

  const sortedItems = [...items].sort((a, b) => a.amount - b.amount);

  // 2. n 过大：跳过精确枚举，直接进入 degraded 分支
  const exactResult =
    sortedItems.length > maxItems
      ? { combinations: [] as string[][], degraded: true, truncated: false, totalFound: 0 }
      : findExactCombinations(sortedItems, targetCents);

  // 3. MATCHED：找到至少一个精确组合
  if (exactResult.combinations.length > 0) {
    const combos = exactResult.combinations
      .map((ids) => ids.map((id) => ({ id, amountCents: itemAmountById.get(id)! })))
      .sort((a, b) => a.length - b.length);

    let truncated = exactResult.truncated;
    if (combos.length > maxCombinations) {
      truncated = true;
      combos.length = maxCombinations;
    }

    return {
      status: "MATCHED",
      combinations: combos,
      degraded: exactResult.degraded,
      truncated,
      totalFound: exactResult.totalFound,
    };
  }

  // 4. NO_EXACT_MATCH：计算最近邻 + degraded 时附贪心参考
  const result: SubsetSumResult = {
    status: "NO_EXACT_MATCH",
    combinations: [],
    degraded: exactResult.degraded,
  };

  let heuristicReference: SubsetSumResult["heuristicReference"];
  const buildHeuristicReference = () => {
    if (heuristicReference) return;
    const greedy = findGreedyReference(sortedItems, targetCents);
    if (greedy) {
      heuristicReference = {
        ids: greedy.ids,
        amounts: greedy.ids.map((id) => itemAmountById.get(id)!),
        sum: greedy.sum,
        method: "GREEDY_LARGEST_FIRST",
      };
    }
  };

  if (exactResult.degraded) {
    buildHeuristicReference();
  }

  const totalSum = sortedItems.reduce((s, it) => s + it.amount, 0);
  const extendedTarget = Math.min(totalSum, targetCents * 2, MAX_NEAREST_CELLS - 1);
  const nearestFeasible =
    sortedItems.length <= MAX_N_FOR_EXACT &&
    targetCents + 1 <= MAX_NEAREST_CELLS &&
    extendedTarget + 1 <= MAX_NEAREST_CELLS;

  if (!nearestFeasible) {
    result.degraded = true;
    // nearest 也不可行时，若尚无启发式参考则补一条
    buildHeuristicReference();
  } else {
    const nearest = findNearestCombinations(sortedItems, targetCents);
    if (nearest.below) result.nearestBelow = nearest.below.sum;
    if (nearest.above) result.nearestAbove = nearest.above.sum;
  }

  if (heuristicReference) result.heuristicReference = heuristicReference;
  result.reason = result.degraded ? "TOO_MANY_CANDIDATES" : "NO_SUBSET_EQUALS";

  return result;
}
