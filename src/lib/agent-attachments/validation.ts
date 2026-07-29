/**
 * Agent 通用附件服务端校验（§7.2.3）。
 *
 * 服务端是最终校验者：扩展名 / 声明 MIME / magic 三者一致，且满足家族大小上限；
 * OOXML（DOCX/XLSX）额外校验 ZIP 中央目录、[Content_Types].xml 与解压总量（zip bomb 防护）。
 * 拒绝 SVG/HTML/脚本/ZIP/RAR/可执行文件/docm/xlsm/空文件/双扩展和所有未列格式——
 * 这些都不在白名单内，或 magic 与扩展名不一致。
 */

import path from "path";
import {
  assertFileSignature,
  assertSafeZipContainer,
  StagingError,
} from "@/lib/staging-common";
import {
  ATTACHMENT_ALLOWED_EXT,
  ATTACHMENT_ALLOWED_MIME,
  ATTACHMENT_EXT_TO_MIME,
  ATTACHMENT_OOXML_EXT,
  ATTACHMENT_TEXT_EXT,
  attachmentMaxBytesForExt,
} from "./constants";

export interface ValidatedAgentAttachment {
  mimeType: string;
  ext: string;
  sha256: string;
  displayName: string;
  sizeBytes: number;
}

/**
 * 校验一份待上传的通用附件 buffer。
 * 失败抛 StagingError（httpStatus 400）。
 */
export function validateAgentAttachmentPayload(opts: {
  originalFileName: string;
  declaredMime: string;
  buffer: Buffer;
}): ValidatedAgentAttachment {
  const ext = path.extname(opts.originalFileName || "").toLowerCase();

  // 先做扩展名白名单：未列格式（含 .svg/.html/.js/.zip/.rar/.exe/.docm/.xlsm 与双扩展尾缀）直接拒绝，
  // 避免未知扩展名走到 size 检查时给出误导性"超过上限"错误。
  if (!ATTACHMENT_ALLOWED_EXT.has(ext)) {
    throw new StagingError(
      "ATTACHMENT_FILE_INVALID",
      `不支持的文件类型: ${ext || "(无扩展名)"}`,
      400,
    );
  }

  const maxBytes = attachmentMaxBytesForExt(ext);

  const validated = assertFileSignature({
    originalFileName: opts.originalFileName,
    declaredMime: opts.declaredMime,
    buffer: opts.buffer,
    allowedMime: ATTACHMENT_ALLOWED_MIME,
    allowedExt: ATTACHMENT_ALLOWED_EXT,
    extToMime: ATTACHMENT_EXT_TO_MIME,
    maxBytes,
    textExtensions: ATTACHMENT_TEXT_EXT,
  });

  // OOXML 容器级校验：中央目录条目数、解压总量、[Content_Types].xml 存在性。
  // 不真正解压；macro 文档（.docm/.xlsm）扩展名不在白名单，已在上面被拒绝。
  if (ATTACHMENT_OOXML_EXT.has(ext)) {
    assertSafeZipContainer(opts.buffer);
  }

  return {
    mimeType: validated.mimeType,
    ext: validated.ext,
    sha256: validated.sha256,
    displayName: validated.displayName,
    sizeBytes: opts.buffer.length,
  };
}
