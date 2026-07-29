import type { ChatProvider, VisionProvider, SearchProvider, SpeechProvider } from "./types";
import { MinimaxChatProvider } from "./minimax-chat";
import { MinimaxVisionProvider } from "./minimax-vision";
import { MinimaxSearchProvider } from "./minimax-search";
import { FallbackSpeechProvider, buildDefaultAsrChain } from "./fallback-asr";

export function getChatProvider(): ChatProvider {
  return new MinimaxChatProvider();
}

export function getVisionProvider(): VisionProvider {
  return new MinimaxVisionProvider();
}

export function getSearchProvider(): SearchProvider {
  return new MinimaxSearchProvider();
}

/**
 * 返回 ASR provider：稳定优先，默认仅腾讯云 SentenceRecognition。
 * 5 个消费路由（/api/agent/asr-draft、/api/draft-media/asr、
 * /api/crm/interactions/asr-draft、/api/crm/checkins/[id]/asr、
 * /api/crm/interactions/[id]/asr）均经此入口。
 *
 * 实现上仍包一层 FallbackSpeechProvider，便于测试构造自定义链；
 * 默认链不含本地 asr-fast。
 */
export function getSpeechProvider(): SpeechProvider {
  return new FallbackSpeechProvider(buildDefaultAsrChain());
}

export function isDraftAIConfigured(): boolean {
  return !!(process.env.MINIMAX_API_KEY);
}

/** 腾讯云 ASR 是否已配置。 */
export function isAsrConfigured(): boolean {
  return !!(process.env.TENCENTCLOUD_SECRET_ID && process.env.TENCENTCLOUD_SECRET_KEY);
}

/**
 * ASR 是否可用（当前 = 腾讯云已配置）。
 * ui-config 的 asrConfigured 使用本函数；未配置时前端不展示录音按钮。
 *
 * 保持 async 以兼容既有 await 调用方。
 */
export async function isAnyAsrConfigured(): Promise<boolean> {
  return isAsrConfigured();
}
