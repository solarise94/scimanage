/**
 * Agent 通用附件的 PDF 文本提取（docs/agent-attachment-routing-design-2026-07-24.md §6.2）。
 *
 * 本地提取（unpdf / pdfjs），无外部调用、无成本，覆盖电子发票等内嵌文本 PDF。
 * 扫描件无内嵌文本时返回空串，由调用方决定是否走 GLM-OCR 兜底。
 * 提取结果属于 untrusted attachment content，仅供模型理解业务背景。
 */

import { extractText, getDocumentProxy } from "unpdf";

/**
 * inspect 输出 extractedText 上限。
 *
 * analysisJson 按 UTF-8 字节数限制为 32 KiB；7,000 个字符即使全部为四字节字符，
 * 也会为 JSON 外层、摘要与字段预留足够空间。
 */
export const PDF_INSPECT_TEXT_MAX_CHARS = 7000;

/** 提取 PDF 内嵌文本；无文本层（扫描件）返回空串。解析失败由调用方捕获。 */
export async function extractPdfText(
  buffer: Buffer,
  maxChars: number = PDF_INSPECT_TEXT_MAX_CHARS,
): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  try {
    const { text } = await extractText(pdf, { mergePages: true });
    const merged = (Array.isArray(text) ? text.join("\n") : String(text || ""))
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return merged.slice(0, maxChars);
  } finally {
    await pdf.destroy();
  }
}
