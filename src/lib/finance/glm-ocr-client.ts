/**
 * 智谱 GLM-OCR 共享传输层（layout_parsing）。
 *
 * 银行回单与发票业务 parser 只复用本模块的鉴权、base64 传输与原文解析，
 * 不共享字段抽取规则。
 *
 * 文档：https://docs.bigmodel.cn/cn/guide/models/vlm/glm-ocr
 */

const DEFAULT_BASE = "https://open.bigmodel.cn/api/paas/v4";
export const GLM_OCR_MODEL = "glm-ocr";

/** 银行回单路由兼容：单图 10MB；PDF 50MB。发票 staging 仍由 20MB 门禁约束。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PDF_BYTES = 50 * 1024 * 1024;

/** 发票 OCR 建议原文上限；截断时由调用方写 warning。 */
export const GLM_OCR_RAW_TEXT_MAX_CHARS = 200_000;

export class GlmOcrClientError extends Error {
  code: string;
  httpStatus: number;

  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.name = "GlmOcrClientError";
  }
}

export function isGlmOcrConfigured(): boolean {
  return !!(process.env.ZHIPU_API_KEY || "").trim();
}

function getApiKey(): string {
  const key = (process.env.ZHIPU_API_KEY || "").trim();
  if (!key) {
    throw new GlmOcrClientError("INVOICE_OCR_NOT_CONFIGURED", "ZHIPU_API_KEY 未配置", 503);
  }
  return key;
}

function getBaseUrl(): string {
  const raw = (process.env.ZHIPU_API_BASE || DEFAULT_BASE).trim().replace(/\/+$/, "");
  return raw || DEFAULT_BASE;
}

function assertFileSize(mimeType: string, byteLength: number, opts?: { maxBytes?: number }) {
  if (byteLength <= 0) {
    throw new GlmOcrClientError("INVOICE_OCR_EMPTY_RESULT", "空文件", 422);
  }
  if (opts?.maxBytes != null) {
    if (byteLength > opts.maxBytes) {
      throw new GlmOcrClientError(
        "INVOICE_FILE_INVALID",
        `文件超过 ${Math.round(opts.maxBytes / 1024 / 1024)}MB 上限`,
        400,
      );
    }
    return;
  }
  const isPdf = mimeType === "application/pdf" || mimeType.endsWith("/pdf");
  const max = isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
  if (byteLength > max) {
    throw new GlmOcrClientError(
      "INVOICE_FILE_INVALID",
      isPdf
        ? `PDF 超过 ${MAX_PDF_BYTES / 1024 / 1024}MB 上限`
        : `图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 上限`,
      400,
    );
  }
}

function extractMdResults(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const obj = data as Record<string, unknown>;
  if (typeof obj.md_results === "string") return obj.md_results;
  const nested = obj.data;
  if (nested && typeof nested === "object") {
    const n = nested as Record<string, unknown>;
    if (typeof n.md_results === "string") return n.md_results;
  }
  const details = obj.layout_details;
  if (Array.isArray(details)) {
    const parts: string[] = [];
    for (const page of details) {
      if (!Array.isArray(page)) continue;
      for (const block of page) {
        if (block && typeof block === "object") {
          const content = (block as Record<string, unknown>).content;
          if (typeof content === "string" && content.trim()) parts.push(content.trim());
        }
      }
    }
    return parts.join("\n");
  }
  return "";
}

export type ParseDocumentWithGlmOcrResult = {
  rawText: string;
  truncated: boolean;
  usage?: unknown;
  model: typeof GLM_OCR_MODEL;
};

/**
 * 调用 GLM-OCR layout_parsing，返回 markdown 全文。
 * 不记录 base64、完整响应正文或 API key。
 *
 * 计费语义：供应商未提供 idempotency / request key 去重能力（响应里的 request_id
 * 仅用于追踪）。同一内容重复 POST 会重复计费；上层须自行缩小重试窗口。
 */
export async function parseDocumentWithGlmOcr(
  buffer: Buffer,
  mimeType: string,
  signal?: AbortSignal,
  opts?: { maxBytes?: number; maxRawTextChars?: number },
): Promise<ParseDocumentWithGlmOcrResult> {
  assertFileSize(mimeType, buffer.byteLength, { maxBytes: opts?.maxBytes });
  const key = getApiKey();
  const base = getBaseUrl();
  const file = buffer.toString("base64");
  const started = Date.now();

  let res: Response;
  try {
    res = await fetch(`${base}/layout_parsing`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: GLM_OCR_MODEL,
        file,
      }),
      signal,
    });
  } catch (err) {
    if (err && typeof err === "object" && (err as { name?: string }).name === "AbortError") {
      throw new GlmOcrClientError("INVOICE_OCR_TIMEOUT", "GLM-OCR 请求已取消或超时", 504);
    }
    const elapsedMs = Date.now() - started;
    console.warn(`[glm-ocr] provider network error elapsedMs=${elapsedMs}`);
    throw new GlmOcrClientError("INVOICE_OCR_PROVIDER_ERROR", "GLM-OCR 网络请求失败", 502);
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const elapsedMs = Date.now() - started;
    console.warn(`[glm-ocr] provider HTTP ${res.status} elapsedMs=${elapsedMs}`);
    if (res.status === 408 || res.status === 504) {
      throw new GlmOcrClientError("INVOICE_OCR_TIMEOUT", "GLM-OCR 请求超时", 504);
    }
    throw new GlmOcrClientError(
      "INVOICE_OCR_PROVIDER_ERROR",
      `GLM-OCR 请求失败 (${res.status})`,
      502,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new GlmOcrClientError("INVOICE_OCR_PROVIDER_ERROR", "GLM-OCR 返回非 JSON", 502);
  }

  if (data && typeof data === "object" && "error" in data) {
    const err = (data as { error?: { message?: string; code?: string } }).error;
    const code = err?.code ? String(err.code) : "unknown";
    console.warn(`[glm-ocr] provider error code=${code}`);
    throw new GlmOcrClientError(
      "INVOICE_OCR_PROVIDER_ERROR",
      `GLM-OCR 错误${err?.code ? ` [${err.code}]` : ""}`,
      502,
    );
  }

  let rawText = extractMdResults(data).trim();
  if (!rawText) {
    throw new GlmOcrClientError("INVOICE_OCR_EMPTY_RESULT", "GLM-OCR 未返回可解析文本", 422);
  }

  const maxChars = opts?.maxRawTextChars ?? GLM_OCR_RAW_TEXT_MAX_CHARS;
  let truncated = false;
  if (rawText.length > maxChars) {
    rawText = rawText.slice(0, maxChars);
    truncated = true;
  }

  return {
    rawText,
    truncated,
    usage: data && typeof data === "object" ? (data as Record<string, unknown>).usage : undefined,
    model: GLM_OCR_MODEL,
  };
}

