/**
 * 梦境记忆 D4 · 自动压缩阈值决策 smoke（纯函数，不打网络、不依赖 LLM）。
 *
 * 校验 `shouldAutoCompact`（agent-runtime/src/pi-runtime.ts）的边界语义：
 *  1. trigger=400000 时：
 *     - tokenCount=399999 → 不触发（严格 < 阈值）；
 *     - tokenCount=400000 → 触发（边界含等号）；
 *     - tokenCount=400001 → 触发。
 *  2. 防抖：alreadyCompacted=true → 永远不触发（即使远超阈值）。
 *  3. trigger 非正数 / NaN → 视为禁用自动压缩，永远不触发。
 *  4. tokenCount 非正 / NaN → 不触发（防御性）。
 *
 * 运行: npx tsx scripts/smoke-test-auto-compact-threshold.ts
 *
 * 依赖说明：pi-runtime.ts 引用了 @earendil-works/pi-agent-core / pi-ai，
 * 这两个包只在 agent-runtime/node_modules 下解析，故脚本运行时需把
 * agent-runtime/node_modules 挂到 NODE_PATH（脚本顶部会用 tsx 子进程设置）。
 * 因为本测试只导入纯函数 shouldAutoCompact，pi-runtime 模块顶层的
 * registerBuiltInApiProviders() / getRuntimeConfig() 副作用都是纯本地操作，
 * 不会发起网络请求。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import url from "node:url";

const SCRIPT_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const AGENT_RUNTIME_DIR = path.join(REPO_ROOT, "agent-runtime");
const PI_RUNTIME_SRC = path.join(AGENT_RUNTIME_DIR, "src", "pi-runtime.ts");

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

/**
 * 在子进程里 import pi-runtime.ts 并执行回调，避免本脚本因 NODE_PATH 不全
 * 而无法解析 @earendil-works/*。回调体被字符串化后注入子进程。
 */
function withShouldAutoCompact<T>(
  body: (fn: (tokenCount: number, opts: { triggerTokens: number; alreadyCompacted: boolean }) => boolean) => T,
): T {
  // 把回调源码序列化成可注入的字符串：Function.prototype.toString 保留字面量，
  // 但闭包变量无法跨进程——所以 body 必须自包含（不能引用外部变量）。
  const bodySrc = body.toString();
  const inline = `
    import(${JSON.stringify(`file://${PI_RUNTIME_SRC}`)}).then((mod) => {
      const fn = mod.shouldAutoCompact;
      const body = (${bodySrc});
      try {
        const out = body(fn);
        process.stdout.write(JSON.stringify({ ok: true, value: out }) + "\\n");
      } catch (e) {
        process.stdout.write(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }) + "\\n");
        process.exitCode = 1;
      }
    }).catch((e) => {
      process.stderr.write("import failed: " + (e && e.stack ? e.stack : e) + "\\n");
      process.exitCode = 2;
    });
  `;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", "--eval", inline],
    {
      cwd: AGENT_RUNTIME_DIR,
      env: {
        ...process.env,
        // 让 @earendil-works/* 从 agent-runtime/node_modules 解析。
        NODE_PATH: path.join(AGENT_RUNTIME_DIR, "node_modules"),
      },
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `tsx subprocess exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  // 子进程只写一行 JSON；parse 最后一行（前面可能有 console.log 噪音）。
  const lines = (result.stdout || "").trim().split(/\r?\n/);
  const jsonLine = lines[lines.length - 1];
  const parsed = JSON.parse(jsonLine) as { ok: boolean; value?: T; error?: string };
  if (!parsed.ok) {
    throw new Error(`subprocess body threw: ${parsed.error}`);
  }
  return parsed.value as T;
}

function main() {
  console.log("=== 自动压缩阈值决策 smoke (shouldAutoCompact) ===\n");

  // ── 1. 边界触发：trigger=400000 ────────────────────────────────────────────
  console.log("[1] trigger=400000 边界（< 阈值不触发，>= 阈值触发）");
  {
    const r399999 = withShouldAutoCompact((fn) =>
      fn(399999, { triggerTokens: 400000, alreadyCompacted: false }),
    );
    const r400000 = withShouldAutoCompact((fn) =>
      fn(400000, { triggerTokens: 400000, alreadyCompacted: false }),
    );
    const r400001 = withShouldAutoCompact((fn) =>
      fn(400001, { triggerTokens: 400000, alreadyCompacted: false }),
    );
    assertEq(r399999, false, "399999 → 不触发（严格小于阈值）");
    assertEq(r400000, true, "400000 → 触发（边界含等号）");
    assertEq(r400001, true, "400001 → 触发");
  }

  // ── 2. 防抖：alreadyCompacted=true → 永不触发 ───────────────────────────────
  console.log("\n[2] 防抖：alreadyCompacted=true 时即便远超阈值也不触发");
  {
    const r = withShouldAutoCompact((fn) =>
      fn(1_000_000, { triggerTokens: 400000, alreadyCompacted: true }),
    );
    assertEq(r, false, "已压过一次 → 不再触发（单次请求最多一次自动压缩）");
  }

  // ── 3. trigger 非正 / NaN → 禁用 ────────────────────────────────────────────
  console.log("\n[3] trigger 非正/NaN → 视为禁用，不触发");
  {
    const r0 = withShouldAutoCompact((fn) =>
      fn(1_000_000, { triggerTokens: 0, alreadyCompacted: false }),
    );
    const rNeg = withShouldAutoCompact((fn) =>
      fn(1_000_000, { triggerTokens: -1, alreadyCompacted: false }),
    );
    const rNaN = withShouldAutoCompact((fn) =>
      fn(1_000_000, { triggerTokens: Number.NaN, alreadyCompacted: false }),
    );
    assertEq(r0, false, "trigger=0 → 不触发");
    assertEq(rNeg, false, "trigger=-1 → 不触发");
    assertEq(rNaN, false, "trigger=NaN → 不触发");
  }

  // ── 4. tokenCount 非正 / NaN → 防御性不触发 ─────────────────────────────────
  console.log("\n[4] tokenCount 非正/NaN → 防御性不触发");
  {
    const r0 = withShouldAutoCompact((fn) =>
      fn(0, { triggerTokens: 400000, alreadyCompacted: false }),
    );
    const rNeg = withShouldAutoCompact((fn) =>
      fn(-5, { triggerTokens: 400000, alreadyCompacted: false }),
    );
    const rNaN = withShouldAutoCompact((fn) =>
      fn(Number.NaN, { triggerTokens: 400000, alreadyCompacted: false }),
    );
    assertEq(r0, false, "tokenCount=0 → 不触发");
    assertEq(rNeg, false, "tokenCount=-5 → 不触发");
    assertEq(rNaN, false, "tokenCount=NaN → 不触发");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("❌ 自动压缩阈值决策 smoke 失败");
    process.exit(1);
  }
  console.log("✅ 自动压缩阈值决策 smoke 通过");
}

try {
  main();
} catch (err) {
  console.error("smoke-test-auto-compact-threshold crashed:", err);
  process.exit(2);
}
