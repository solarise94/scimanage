/**
 * FallbackSpeechProvider — 可链式的 ASR provider 包装。
 *
 * 稳定优先：默认链仅挂腾讯云 SentenceRecognition（单一云端源）。
 * LocalAsrProvider / tryReady 机制仍保留在本模块，便于测试或以后再挂回本地档，
 * 但生产默认不探活远端 asr-fast。
 *
 * ── 链式语义 ────────────────────────────────────────────────────────────────
 * 给定一组候选 provider（按优先级排序）：
 *   1. 对每个候选，先问 `tryReady()`（若提供）：false 则直接跳过该档，不打网络。
 *   2. 就绪则调用 transcribe：成功 → console.log served by <name> 后立即返回；
 *      任何异常/超时 → console.warn 记录失败原因，继续尝试下一档。
 *   3. 所有候选都跳过或失败 → 抛出「最后一个真实抛错的 provider 的错误」；
 *      若没有任何 provider 真正抛错，抛出描述性错误。
 *
 * 依赖方向：tencent-asr.ts / local-asr.ts 均不反向 import 本文件，无环。
 */

import type { SpeechProvider } from "./types";
import { TencentAsrProvider } from "./tencent-asr";

/** 命名候选，便于日志识别是哪一档在响应/失败。 */
export interface NamedProvider {
  name: string;
  provider: SpeechProvider;
  /** 可选的就绪探测：返回 false 时直接跳过该 provider（不打网络）。 */
  tryReady?: () => Promise<boolean>;
}

export class FallbackSpeechProvider implements SpeechProvider {
  private readonly candidates: NamedProvider[];

  constructor(candidates: NamedProvider[]) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error("FallbackSpeechProvider requires at least one candidate provider");
    }
    this.candidates = candidates;
  }

  async transcribe(params: {
    data: Buffer;
    mimeType: string;
    language?: string;
    signal?: AbortSignal;
  }): Promise<{
    text: string;
    durationMs?: number;
    words?: Array<{ startMs: number; endMs: number; word: string }>;
  }> {
    let lastError: Error | null = null;
    // 真正调用过 transcribe 的次数（排除 tryReady=false 跳过的）。
    let attempted = 0;

    for (const candidate of this.candidates) {
      // 1. 就绪探测：未就绪直接跳过（不打网络），不算「失败」也不记 lastError。
      if (candidate.tryReady) {
        let ready: boolean;
        try {
          ready = await candidate.tryReady();
        } catch (err) {
          // 探活本身异常按「未就绪」处理，继续下一档。
          console.warn(
            `[asr] ${candidate.name} readiness probe threw; skipping:`,
            err instanceof Error ? err.message : err,
          );
          continue;
        }
        if (!ready) {
          console.log(`[asr] ${candidate.name} not ready; skipping`);
          continue;
        }
      }

      // 2. 调用 transcribe：成功即返回并记录 served by；失败则记录并尝试下一档。
      attempted++;
      try {
        const result = await candidate.provider.transcribe(params);
        console.log(`[asr] served by ${candidate.name}`);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(
          `[asr] ${candidate.name} failed; trying next candidate:`,
          lastError.message,
        );
      }
    }

    // 3. 全部候选都没能成功返回。
    if (lastError) {
      // 有真实抛错的 provider → 抛最后一个错误（上层路由会按其特征映射 504/500）。
      throw lastError;
    }
    // 所有候选都被 tryReady 跳过（没有任何 provider 真正尝试）。
    throw new Error("语音识别服务不可用（腾讯云未配置或全部候选未就绪）");
  }
}

/**
 * 构造默认链：仅腾讯云。
 * - 无 tryReady：配置缺失时 TencentAsrProvider 在 transcribe 内抛错。
 * - LocalAsrProvider 代码仍保留（local-asr.ts），但不进入默认链。
 *
 * 暴露 candidates 数组便于测试构造自定义链。
 */
export function buildDefaultAsrChain(): NamedProvider[] {
  return [
    {
      name: "tencent",
      provider: new TencentAsrProvider(),
    },
  ];
}
