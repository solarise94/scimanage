/**
 * Agent 通用附件：白名单、限额与路由映射常量。
 *
 * 见 docs/agent-attachment-routing-design-2026-07-24.md §3.1 / §6.3.1。
 * 服务端是最终校验者：accept 只改善 UX，真实 bytes（magic/MIME/扩展名一致性）为准。
 */

// ─── 单文件家族限额（bytes）─────────────────────────────────
export const ATTACHMENT_MAX_BYTES_IMAGE = 10 * 1024 * 1024; // JPEG/PNG/WebP 10 MB
export const ATTACHMENT_MAX_BYTES_PDF = 15 * 1024 * 1024; // PDF 15 MB
export const ATTACHMENT_MAX_BYTES_OFFICE = 10 * 1024 * 1024; // DOCX/XLSX 10 MB
export const ATTACHMENT_MAX_BYTES_TEXT = 2 * 1024 * 1024; // TXT/CSV 2 MB

// ─── 每消息限额 ─────────────────────────────────────────────
export const ATTACHMENT_MAX_FILES_PER_MESSAGE = 5;
export const ATTACHMENT_MAX_TOTAL_BYTES_PER_MESSAGE = 30 * 1024 * 1024; // 30 MB

// ─── inspect 限额 ───────────────────────────────────────────
export const ATTACHMENT_INSPECT_MAX_ITEMS = 5;

// ─── analysisJson 上限 ──────────────────────────────────────
export const ATTACHMENT_ANALYSIS_JSON_MAX_BYTES = 32 * 1024; // 32 KiB

// ─── 解析重试上限 ───────────────────────────────────────────
export const ATTACHMENT_MAX_ANALYSIS_ATTEMPTS = 3;

// ─── 白名单：MIME / 扩展名 / 家族 ───────────────────────────
export type AttachmentFamily = "IMAGE" | "PDF" | "OFFICE" | "TEXT";

export const ATTACHMENT_ALLOWED_MIME = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export const ATTACHMENT_ALLOWED_EXT = new Set<string>([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".pdf",
  ".txt",
  ".csv",
  ".docx",
  ".xlsx",
]);

/** 文本类没有可靠魔数，走扩展名 + 可解码判定（staging-common.looksLikeText）。 */
export const ATTACHMENT_TEXT_EXT = new Set<string>([".txt", ".csv"]);

/** OOXML ZIP 容器扩展名：需要中央目录 + [Content_Types].xml + 解压总量校验。 */
export const ATTACHMENT_OOXML_EXT = new Set<string>([".docx", ".xlsx"]);

export const ATTACHMENT_EXT_TO_MIME = new Map<string, string>([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain"],
  [".csv", "text/csv"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
]);

/** 扩展名 → 单文件大小上限。 */
export function attachmentMaxBytesForExt(ext: string): number {
  switch (ext) {
    case ".jpg":
    case ".jpeg":
    case ".png":
    case ".webp":
      return ATTACHMENT_MAX_BYTES_IMAGE;
    case ".pdf":
      return ATTACHMENT_MAX_BYTES_PDF;
    case ".docx":
    case ".xlsx":
      return ATTACHMENT_MAX_BYTES_OFFICE;
    case ".txt":
    case ".csv":
      return ATTACHMENT_MAX_BYTES_TEXT;
    default:
      return 0;
  }
}

export function attachmentFamilyForMime(mimeType: string): AttachmentFamily {
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType === "text/plain" || mimeType === "text/csv") return "TEXT";
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    || mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return "OFFICE";
  }
  return "IMAGE";
}

// ─── 分类与路由（§6.3.1）────────────────────────────────────
export type AttachmentClassification = "INVOICE" | "PROJECT_NOTE" | "UNSUPPORTED" | "UNKNOWN";
export type AttachmentRouteTarget = "INVOICE_STAGING" | "PROJECT_NOTE";

/** 发票可接受的 MIME：仅 PDF/JPEG/PNG（WebP 不可作为发票）。 */
export const INVOICE_ADOPTABLE_MIME = new Set<string>([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

/**
 * allowedRoutes 只能由服务端依据"已验证的真实 MIME"计算；分类/文件名/OCR 结论不得扩大它。
 * - PDF/JPEG/PNG 可路由到发票 + 项目备注；
 * - WebP/TXT/CSV/DOCX/XLSX 只能路由到项目备注。
 */
export function allowedRoutesForMime(mimeType: string): AttachmentRouteTarget[] {
  if (INVOICE_ADOPTABLE_MIME.has(mimeType)) {
    return ["INVOICE_STAGING", "PROJECT_NOTE"];
  }
  if (ATTACHMENT_ALLOWED_MIME.has(mimeType)) {
    return ["PROJECT_NOTE"];
  }
  return [];
}

// ─── 纯附件消息默认文本（§3.1）──────────────────────────────
/** 只上传附件不输入文字时，客户端发送的统一默认文本；集中管理便于本地化。 */
export const DEFAULT_ATTACHMENT_ONLY_MESSAGE = "请整理并说明这些附件可以如何处理。";
