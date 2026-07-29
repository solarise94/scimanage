/**
 * 梦境记忆 D1 · 向量服务客户端（TEI 接入）。
 *
 * ── TEI 接入约定 ────────────────────────────────────────────────────────────
 * Base URL: AGENT_VECTOR_BASE_URL（默认 http://127.0.0.1:8103，本机直连；
 *           生产 Hub 网关示例 http://your-vector-gateway:48202/api/vector）。
 * - GET  /health/ready           → {"ready": true}
 * - POST /v1/embeddings          body { model, input: string[] }   // OpenAI 格式
 *                                   → { data: [{ embedding: number[1024], index }] }
 * - POST /v1/rerank              body { model, query, documents }  // 注意：documents，≤64 条
 *                                   → { results: [{ index, relevance_score }] }
 * 默认模型：embed = BAAI/bge-m3（1024 维），rerank = BAAI/bge-reranker-v2-m3。
 *
 * ── 鉴权（D4 接线）──────────────────────────────────────────────────────────
 * AGENT_VECTOR_API_KEY 设置时，所有请求（/health/ready、/v1/embeddings、/v1/rerank）
 * 携带 `Authorization: Bearer <key>`；未设置时不加（本机直连 TEI 无需 key）。
 * 该 key 只从 env 读取，绝不硬编码进源码/脚本/git（见 AGENTS.md 安全规范）。
 *
 * ── 降级语义（核心约束）──────────────────────────────────────────────────────
 * 向量服务是"夜间整理 + 召回增强"链路，**不是主链路**。任何网络/解析/超时错误
 * 都必须优雅降级为返回 null（并 console.warn），严禁抛出异常打断调用方业务。
 * 唯一的失败后果是"本次没有向量召回"，主链路照常返回。
 *
 * ── 批次与超时 ───────────────────────────────────────────────────────────────
 * - embed/rerank 单次 batch ≤ 64（TEI 上限），调用方传入更多时内部按 64 分块拼回。
 * - 每次 fetch 使用 AbortSignal.timeout(10s)，避免悬挂。
 * - health 结果在进程内缓存 60s（避免热路径反复探活）。
 */

// ── env 解析 ────────────────────────────────────────────────────────────────

function baseUrl(): string {
  return (
    process.env.AGENT_VECTOR_BASE_URL || "http://127.0.0.1:8103"
  ).replace(/\/+$/, "");
}

function embedModel(): string {
  return process.env.AGENT_EMBED_MODEL || "BAAI/bge-m3";
}

function rerankModel(): string {
  return process.env.AGENT_RERANK_MODEL || "BAAI/bge-reranker-v2-m3";
}

/**
 * 可选 Bearer key（生产 Hub 网关需要；本机直连 TEI 不需要）。仅从 env 读取。
 * trim 后为空字符串视为「未设置」。
 */
function vectorApiKey(): string {
  return (process.env.AGENT_VECTOR_API_KEY || "").trim();
}

/**
 * 构造请求 headers：始终带 content-type；设置 key 时追加 Authorization。
 * `includeContentType=false` 用于 GET /health/ready（无 body）。
 */
function vectorHeaders(includeContentType = true): Record<string, string> {
  const headers: Record<string, string> = {};
  if (includeContentType) headers["content-type"] = "application/json";
  const key = vectorApiKey();
  if (key) headers["Authorization"] = `Bearer ${key}`;
  return headers;
}

// ── 常量 ─────────────────────────────────────────────────────────────────────

/** 单次请求最大条数（TEI 上限）。 */
const MAX_BATCH = 64;
/** fetch 超时（毫秒）。 */
const FETCH_TIMEOUT_MS = 10_000;
/** health 探活进程内缓存（毫秒）。 */
const HEALTH_CACHE_MS = 60_000;

// ── health（带 60s 缓存） ───────────────────────────────────────────────────

let healthCache: { ready: boolean; expiresAt: number } | null = null;

/**
 * 探活向量服务是否就绪。结果在进程内缓存 60s。
 * 任何错误降级为 false（不抛）。
 */
export async function checkVectorServiceReady(): Promise<boolean> {
  const now = Date.now();
  if (healthCache && healthCache.expiresAt > now) {
    return healthCache.ready;
  }
  try {
    const res = await fetch(`${baseUrl()}/health/ready`, {
      method: "GET",
      headers: vectorHeaders(false),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(
        `[vector] /health/ready returned status ${res.status}; treating as not ready`,
      );
      healthCache = { ready: false, expiresAt: now + HEALTH_CACHE_MS };
      return false;
    }
    const json = (await res.json()) as { ready?: unknown };
    const ready = json?.ready === true;
    healthCache = { ready, expiresAt: now + HEALTH_CACHE_MS };
    return ready;
  } catch (err) {
    console.warn(
      `[vector] /health/ready failed; treating as not ready:`,
      err instanceof Error ? err.message : err,
    );
    healthCache = { ready: false, expiresAt: now + HEALTH_CACHE_MS };
    return false;
  }
}

// ── embeddings ──────────────────────────────────────────────────────────────

type EmbeddingResponse = {
  data?: Array<{ embedding?: number[]; index?: number }>;
};

/**
 * 批量文本向量。返回与 texts 等长的 Float32 向量数组（每条 1024 维）。
 * - 不就绪/失败 → 返回 null（不抛）。
 * - 输入超过 64 条时按 64 分块请求，再按原顺序拼回。
 * - 输入空数组 → 直接返回 []（不打网络）。
 */
export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const ready = await checkVectorServiceReady();
  if (!ready) return null;

  const out: number[][] = new Array(texts.length);
  try {
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const chunk = texts.slice(i, i + MAX_BATCH);
      const res = await fetch(`${baseUrl()}/v1/embeddings`, {
        method: "POST",
        headers: vectorHeaders(),
        body: JSON.stringify({ model: embedModel(), input: chunk }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.warn(
          `[vector] /v1/embeddings returned status ${res.status} for chunk @${i}; aborting embedTexts`,
        );
        return null;
      }
      const json = (await res.json()) as EmbeddingResponse;
      const data = json?.data;
      if (!Array.isArray(data) || data.length !== chunk.length) {
        console.warn(
          `[vector] /v1/embeddings returned malformed data (expected ${chunk.length}, got ${Array.isArray(data) ? data.length : "non-array"}); aborting embedTexts`,
        );
        return null;
      }
      // TEI/OpenAI 返回 index 与请求顺序对齐；防御性按 index 落位。
      for (const item of data) {
        const idx = typeof item.index === "number" ? item.index : -1;
        if (idx < 0 || idx >= chunk.length) {
          console.warn(
            `[vector] /v1/embeddings returned out-of-range index ${idx}; aborting embedTexts`,
          );
          return null;
        }
        if (!Array.isArray(item.embedding)) {
          console.warn(
            `[vector] /v1/embeddings item index=${idx} missing embedding array`,
          );
          return null;
        }
        out[i + idx] = item.embedding;
      }
    }
    // 校验每个 slot 都被填充
    for (let i = 0; i < out.length; i++) {
      if (!out[i]) {
        console.warn(`[vector] embedTexts: slot ${i} not filled`);
        return null;
      }
    }
    return out;
  } catch (err) {
    console.warn(
      `[vector] embedTexts failed; returning null:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ── rerank ──────────────────────────────────────────────────────────────────

type RerankResponse = {
  results?: Array<{ index?: number; relevance_score?: number }>;
};

/**
 * 对 documents 按 query 重排，返回与 documents 等长的 relevance_score 数组（顺序对齐原始 documents）。
 * - 不就绪/失败 → 返回 null（不抛）。
 * - 超过 64 条时按 64 分块请求，再按原始位置拼回（每块独立打分，跨块分数仅做相对比较需谨慎；
 *   调用方约定 documents ≤ 64；超过时返回 null 以避免误导性跨块比较）。
 * - 缺位补 0。
 */
export async function rerankDocuments(
  query: string,
  documents: string[],
): Promise<number[] | null> {
  if (!Array.isArray(documents) || documents.length === 0) return [];

  if (documents.length > MAX_BATCH) {
    console.warn(
      `[vector] rerankDocuments received ${documents.length} > ${MAX_BATCH}; refusing to avoid misleading cross-batch scores`,
    );
    return null;
  }

  const ready = await checkVectorServiceReady();
  if (!ready) return null;

  try {
    const res = await fetch(`${baseUrl()}/v1/rerank`, {
      method: "POST",
      headers: vectorHeaders(),
      body: JSON.stringify({
        model: rerankModel(),
        query,
        documents,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(
        `[vector] /v1/rerank returned status ${res.status}; returning null`,
      );
      return null;
    }
    const json = (await res.json()) as RerankResponse;
    const results = json?.results;
    if (!Array.isArray(results)) {
      console.warn(`[vector] /v1/rerank returned malformed results`);
      return null;
    }
    const scores = new Array<number>(documents.length).fill(0);
    for (const r of results) {
      const idx = typeof r.index === "number" ? r.index : -1;
      if (idx < 0 || idx >= documents.length) continue;
      const score = typeof r.relevance_score === "number" ? r.relevance_score : 0;
      scores[idx] = score;
    }
    return scores;
  } catch (err) {
    console.warn(
      `[vector] rerankDocuments failed; returning null:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ── 编码 / 解码（Float32 LE） ───────────────────────────────────────────────

/**
 * 将 Float32 向量编码为小端字节 Buffer，用于存入 Prisma Bytes 字段。
 */
export function encodeEmbedding(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i], i * 4);
  }
  return buf;
}

/**
 * 将 Float32 LE 字节 Buffer 解码回 number 数组。null/空 → null。
 */
export function decodeEmbedding(buf: Buffer | null): number[] | null {
  if (!buf || buf.length === 0) return null;
  if (buf.length % 4 !== 0) {
    console.warn(
      `[vector] decodeEmbedding: buffer length ${buf.length} not divisible by 4`,
    );
    return null;
  }
  const out = new Array<number>(buf.length / 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = buf.readFloatLE(i * 4);
  }
  return out;
}

// ── 相似度 ──────────────────────────────────────────────────────────────────

/**
 * 余弦相似度。两向量长度不等或全 0 → 返回 0。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (!Number.isFinite(denom) || denom === 0) return 0;
  return dot / denom;
}
