/**
 * ASR 链式降级 smoke — FallbackSpeechProvider + LocalAsrProvider。
 *
 * 运行: npx tsx scripts/smoke-test-asr-fallback.ts
 *
 * 三段：
 *  [A] mock provider 验证 FallbackSpeechProvider 链式语义 4 场景
 *      （依赖 FallbackSpeechProvider 本身，不触碰 LocalAsrProvider 的进程内 health 缓存）：
 *        1. local 成功 → 不触 tencent；
 *        2. local 抛 → tencent 顶上；
 *        3. 全部失败 → 抛最后一个真实错误；
 *        4. local 未就绪（tryReady=false）→ 直接走 tencent，不打 local 网络。
 *  [B] 真实集成：本机 asr-fast @ 127.0.0.1:8102 在线时，ffmpeg 生成 2s 440Hz wav，
 *      调 LocalAsrProvider.transcribe，断言 text 字段存在、耗时合理。
 *      本段在新模块作用域内动态 import LocalAsrProvider，避免 [A]/[C] 的探活污染缓存。
 *  [C] 降级：ASR_LOCAL_BASE_URL=http://127.0.0.1:9（不可用端口）下，子进程跑一次
 *      isLocalAsrReady，断言返回 false（并校验 60s 缓存不会把 [B] 的 ready=true 带过来）。
 *      必须子进程：local-asr.ts 的 healthCache 是模块级单例，60s TTL，主进程一旦探活
 *      成功就锁死 true，无法用改 env 的方式在本进程内复现 false。
 *
 * 退出码：0 = 全绿；非 0 = 有失败。
 */

import { execFileSync } from "child_process";
import { createServer } from "http";
import { join } from "path";
import { tmpdir } from "os";
import { writeFileSync } from "fs";
import { unlink } from "fs/promises";
import type { SpeechProvider } from "../src/lib/draft/providers/types";

/** 仓库根，用于子进程 tsx 解析 @/* tsconfig paths 别名。 */
const REPO_DIR = join(__dirname, "..");

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

// ── mock provider 工具 ──────────────────────────────────────────────────────

type MockBehavior =
  | { kind: "ok"; text: string }
  | { kind: "throw"; error: string };

interface MockRecorder {
  transcribeCalls: number;
}

function makeMockProvider(behavior: MockBehavior, rec: MockRecorder): SpeechProvider {
  return {
    async transcribe(params) {
      rec.transcribeCalls++;
      // 触摸 signal 以证明签名兼容（与真实 provider 一致地接受 signal）。
      if (params.signal?.aborted) throw new Error("PROVIDER_TIMEOUT");
      if (behavior.kind === "throw") throw new Error(behavior.error);
      return { text: behavior.text };
    },
  };
}

// FallbackSpeechProvider 延迟 import：[A] 阶段尚未探活，模块状态干净。
const FallbackImport = import("../src/lib/draft/providers/fallback-asr");

// ── [A] mock 链式语义 ──────────────────────────────────────────────────────

async function sectionA() {
  console.log("=== [A] FallbackSpeechProvider 链式降级（mock）===\n");
  const { FallbackSpeechProvider } = await FallbackImport;

  const params = {
    data: Buffer.from("fake-audio"),
    mimeType: "audio/wav",
  };

  // 1. local 成功 → 不触 tencent
  {
    const localRec: MockRecorder = { transcribeCalls: 0 };
    const tencentRec: MockRecorder = { transcribeCalls: 0 };
    const chain = new FallbackSpeechProvider([
      {
        name: "local",
        provider: makeMockProvider({ kind: "ok", text: "来自本地" }, localRec),
        tryReady: async () => true,
      },
      {
        name: "tencent",
        provider: makeMockProvider({ kind: "ok", text: "来自腾讯云" }, tencentRec),
      },
    ]);
    const result = await chain.transcribe(params);
    assert(result.text === "来自本地", "[1] local 成功时返回 local 文本");
    assert(localRec.transcribeCalls === 1, "[1] local 被调用 1 次");
    assert(tencentRec.transcribeCalls === 0, "[1] tencent 未被触发");
  }

  // 2. local 抛 → tencent 顶上
  {
    const localRec: MockRecorder = { transcribeCalls: 0 };
    const tencentRec: MockRecorder = { transcribeCalls: 0 };
    const chain = new FallbackSpeechProvider([
      {
        name: "local",
        provider: makeMockProvider({ kind: "throw", error: "本地 ASR 空文本" }, localRec),
        tryReady: async () => true,
      },
      {
        name: "tencent",
        provider: makeMockProvider({ kind: "ok", text: "腾讯云兜底" }, tencentRec),
      },
    ]);
    const result = await chain.transcribe(params);
    assert(result.text === "腾讯云兜底", "[2] local 失败时返回 tencent 文本");
    assert(localRec.transcribeCalls === 1, "[2] local 尝试过 1 次");
    assert(tencentRec.transcribeCalls === 1, "[2] tencent 顶上 1 次");
  }

  // 3. 全部失败 → 抛最后一个真实错误
  {
    const chain = new FallbackSpeechProvider([
      {
        name: "local",
        provider: makeMockProvider({ kind: "throw", error: "本地 500" }, { transcribeCalls: 0 }),
        tryReady: async () => true,
      },
      {
        name: "tencent",
        provider: makeMockProvider({ kind: "throw", error: "腾讯云 503" }, { transcribeCalls: 0 }),
      },
    ]);
    let thrown: Error | null = null;
    try {
      await chain.transcribe(params);
    } catch (err) {
      thrown = err instanceof Error ? err : new Error(String(err));
    }
    assert(thrown !== null, "[3] 全败时抛错");
    assert(
      thrown?.message === "腾讯云 503",
      "[3] 抛的是最后一个真实尝试 provider 的错误（tencent 503）",
    );
  }

  // 4. local 未就绪（tryReady=false）→ 直接 tencent，不打 local 网络
  {
    const localRec: MockRecorder = { transcribeCalls: 0 };
    const tencentRec: MockRecorder = { transcribeCalls: 0 };
    const chain = new FallbackSpeechProvider([
      {
        name: "local",
        provider: makeMockProvider({ kind: "ok", text: "不该返回" }, localRec),
        tryReady: async () => false,
      },
      {
        name: "tencent",
        provider: makeMockProvider({ kind: "ok", text: "腾讯云" }, tencentRec),
      },
    ]);
    const result = await chain.transcribe(params);
    assert(result.text === "腾讯云", "[4] local 未就绪时返回 tencent 文本");
    assert(localRec.transcribeCalls === 0, "[4] local 未就绪时不打网络（transcribe 0 次）");
    assert(tencentRec.transcribeCalls === 1, "[4] tencent 被调用 1 次");
  }

  // 补充场景：所有候选都被 tryReady 跳过（无人真正尝试）→ 抛描述性错误而非 lastError。
  {
    const chain = new FallbackSpeechProvider([
      {
        name: "local",
        provider: makeMockProvider({ kind: "ok", text: "x" }, { transcribeCalls: 0 }),
        tryReady: async () => false,
      },
      {
        name: "tencent",
        provider: makeMockProvider({ kind: "ok", text: "y" }, { transcribeCalls: 0 }),
        tryReady: async () => false,
      },
    ]);
    let thrown: Error | null = null;
    try {
      await chain.transcribe(params);
    } catch (err) {
      thrown = err instanceof Error ? err : new Error(String(err));
    }
    assert(thrown !== null, "[5] 全部未就绪时抛错");
    const thrownMessage = thrown!.message;
    assert(
      thrownMessage.includes("全部不可用") || thrownMessage.includes("不可用"),
      "[5] 抛的是「服务全部不可用」描述性错误（而非空 lastError）",
    );
  }
}

// ── [B] 真实集成（本机 asr-fast） ───────────────────────────────────────────

function generateWav(): string {
  const wavPath = join(tmpdir(), `asr-smoke-${Date.now()}.wav`);
  // 2s 440Hz 正弦波 16kHz mono wav —— 几乎纯音，无语义；服务端会返回 text（可能为空串，
  // 但 services 路径通常返回一个占位或 VAD 后的输出）。我们只校验「text 字段是字符串」
  // 与「请求在合理时间内完成」，不校验文本内容（纯音无明确语义）。
  execFileSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ar", "16000", "-ac", "1", wavPath],
    { stdio: "ignore" },
  );
  return wavPath;
}

async function sectionB() {
  console.log("\n=== [B] 真实本地 ASR 集成（asr-fast @ 127.0.0.1:8102）===\n");

  // 先探活；服务未跑就跳过本段（不判失败，避免 CI 环境强依赖）。
  let ready = false;
  try {
    const res = await fetch("http://127.0.0.1:8102/health/ready", {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const json = (await res.json()) as { ready?: unknown };
      ready = json?.ready === true;
    }
  } catch {
    ready = false;
  }

  if (!ready) {
    console.log("  ⚠ asr-fast 服务未就绪，跳过 [B] 真实集成段（不计数失败）");
    return;
  }

  // 动态 import：独立的模块作用域，[A] 阶段没有触碰 LocalAsrProvider，
  // 这里拿到的 healthCache 是干净的（即便 [A] 探过也是 fallback-asr 内部的事）。
  const { LocalAsrProvider } = await import("../src/lib/draft/providers/local-asr");
  const { readFile } = await import("fs/promises");

  let wavPath: string | null = null;
  try {
    wavPath = generateWav();
    const data = await readFile(wavPath);
    assert(data.length > 0, "[B] ffmpeg 生成 wav 非空");

    const provider = new LocalAsrProvider();
    const start = Date.now();
    const result = await provider.transcribe({ data, mimeType: "audio/wav" });
    const elapsed = Date.now() - start;

    assert(typeof result.text === "string", "[B] 返回 text 字段为 string");
    assert(elapsed > 0 && elapsed < 30_000, `[B] 耗时合理（${elapsed}ms，< 30s）`);
    console.log(`    text=${JSON.stringify(result.text).slice(0, 80)}  elapsed=${elapsed}ms`);
  } finally {
    if (wavPath) {
      const { unlink } = await import("fs/promises");
      await unlink(wavPath).catch(() => {});
    }
  }
}

// ── [C] 降级（不可达端口 → isLocalAsrReady false） ─────────────────────────

async function sectionC() {
  console.log("\n=== [C] 降级：ASR_LOCAL_BASE_URL 指向不可达端口 ===\n");

  // 127.0.0.1:9 是 discard 端口，连接会被立刻拒绝 → fetch 抛 → isLocalAsrReady 返回 false。
  // 必须用子进程：local-asr.ts 的 healthCache 是模块级单例、60s TTL。
  // 主进程 [B] 段已探活 ready=true 并缓存，改 env 在本进程内无效（缓存锁死 true 60s）。
  // 子进程拿到全新模块实例 + 全新 healthCache，env 在 import 前就位。
  const tmpTs = join(tmpdir(), `asr-smoke-degrade-${Date.now()}.ts`);
  writeFileSync(
    tmpTs,
    `import { isLocalAsrReady } from "@/lib/draft/providers/local-asr";\n` +
      `(async () => {\n` +
      `  const ready = await isLocalAsrReady();\n` +
      `  console.log(ready ? "READY_TRUE" : "READY_FALSE");\n` +
      `  process.exit(ready ? 1 : 0); // 期望 false → exit 0\n` +
      `})();\n`,
  );

  let stdout = "";
  let exitCode = -1;
  try {
    try {
      stdout = execFileSync(
        "npx",
        ["tsx", "--tsconfig", "tsconfig.json", tmpTs],
        {
          cwd: REPO_DIR,
          env: {
            ...process.env,
            ASR_LOCAL_BASE_URL: "http://127.0.0.1:9",
          },
          timeout: 30_000,
          encoding: "utf8",
        },
      );
      exitCode = 0;
    } catch (err: unknown) {
      const e = err as { stdout?: string; status?: number };
      stdout = e.stdout ?? "";
      exitCode = e.status ?? -1;
    }
  } finally {
    await unlink(tmpTs).catch(() => {});
  }

  const trimmed = stdout.trim();
  assert(
    trimmed.includes("READY_FALSE"),
    `[C] 不可达端口下 isLocalAsrReady 返回 false（stdout: ${trimmed || "<empty>"}）`,
  );
  assert(
    exitCode === 0,
    `[C] 降级子进程退出码 0（期望 false → exit 0；实际 ${exitCode}）`,
  );
}

async function sectionD() {
  console.log("\n=== [D] 腾讯云输入格式规范化 ===\n");
  const { needsTencentWavConversion } = await import("../src/lib/draft/providers/tencent-asr");
  assert(needsTencentWavConversion("audio/ogg;codecs=opus"), "[D] ogg/opus 先转 WAV");
  assert(needsTencentWavConversion("audio/mp4"), "[D] mp4/m4a 先转 WAV");
  assert(needsTencentWavConversion("audio/webm;codecs=opus"), "[D] webm/opus 先转 WAV");
  assert(!needsTencentWavConversion("audio/wav"), "[D] WAV 无需重复转换");
}

async function sectionE() {
  console.log("\n=== [E] SenseVoice 超时快速降级腾讯云档 ===\n");
  const server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "不应返回" }));
    }, 500);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock ASR server failed to bind");

  const previousBase = process.env.ASR_LOCAL_BASE_URL;
  const previousTimeout = process.env.ASR_LOCAL_TIMEOUT_MS;
  process.env.ASR_LOCAL_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.ASR_LOCAL_TIMEOUT_MS = "100";
  try {
    const { LocalAsrProvider } = await import("../src/lib/draft/providers/local-asr");
    const { FallbackSpeechProvider } = await FallbackImport;
    const cloudCalls: MockRecorder = { transcribeCalls: 0 };
    const chain = new FallbackSpeechProvider([
      { name: "local", provider: new LocalAsrProvider() },
      { name: "tencent", provider: makeMockProvider({ kind: "ok", text: "腾讯兜底" }, cloudCalls) },
    ]);
    const started = Date.now();
    const result = await chain.transcribe({ data: Buffer.from("audio"), mimeType: "audio/wav" });
    const elapsed = Date.now() - started;
    assert(result.text === "腾讯兜底", "[E] SenseVoice 超时后返回腾讯云结果");
    assert(cloudCalls.transcribeCalls === 1, "[E] 腾讯云档只调用一次");
    assert(elapsed >= 90 && elapsed < 450, `[E] 在本地档预算后快速降级（${elapsed}ms）`);
  } finally {
    if (previousBase === undefined) delete process.env.ASR_LOCAL_BASE_URL;
    else process.env.ASR_LOCAL_BASE_URL = previousBase;
    if (previousTimeout === undefined) delete process.env.ASR_LOCAL_TIMEOUT_MS;
    else process.env.ASR_LOCAL_TIMEOUT_MS = previousTimeout;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  await sectionA();
  await sectionB();
  await sectionC();
  await sectionD();
  await sectionE();

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  if (fail > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("smoke 异常退出：", err);
  process.exit(1);
});
