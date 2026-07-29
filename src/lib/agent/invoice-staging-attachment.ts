"use client";

/**
 * Client helpers for Agent invoice staging attachments (ADMIN).
 * Supports 1～10 files; each file is an independent staging upload.
 */

export const AGENT_INVOICE_STAGING_MAX_FILES = 10;
export const AGENT_INVOICE_STAGING_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export type AgentInvoiceStagingAttachment = {
  stagingFileId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
  version: number;
  expiresAt: string;
  /** Client-side queue status for UI progress. */
  queueStatus?:
    | "uploaded"
    | "analyzing"
    | "analyzed"
    | "pending_confirm"
    | "registered"
    | "failed"
    | "skipped";
  uploadError?: string;
};

export type VerifiedInvoiceStagingMessageContext = {
  /** @deprecated Prefer verifiedInvoiceStagingFiles for multi-file. Kept for single-file compat. */
  verifiedInvoiceStaging?: {
    stagingFileId: string;
    sha256: string;
    version: number;
    fileName: string;
  };
  verifiedInvoiceStagingFiles?: Array<{
    stagingFileId: string;
    sha256: string;
    version: number;
    fileName: string;
  }>;
};

const DEFAULT_REGISTER_MESSAGE_ONE = "请识别并登记这张已开发票";
const DEFAULT_REGISTER_MESSAGE_MANY = "请按上传顺序逐张识别并登记这些已开发票";

export function buildInvoiceStagingMessageContext(
  attachments: AgentInvoiceStagingAttachment | AgentInvoiceStagingAttachment[],
): VerifiedInvoiceStagingMessageContext {
  const list = Array.isArray(attachments) ? attachments : [attachments];
  const files = list.map((attachment) => ({
    stagingFileId: attachment.stagingFileId,
    sha256: attachment.sha256,
    version: attachment.version,
    fileName: attachment.fileName,
  }));
  if (files.length === 0) return {};
  if (files.length === 1) {
    return {
      verifiedInvoiceStaging: files[0],
      verifiedInvoiceStagingFiles: files,
    };
  }
  return { verifiedInvoiceStagingFiles: files };
}

export function resolveSendMessageWithInvoiceStaging(opts: {
  draft: string;
  attachments: AgentInvoiceStagingAttachment[] | null;
  /** When true, include attachments even if draft is a continuation/voice override. */
  includeAttachments?: boolean;
}): { content: string; messageContext?: VerifiedInvoiceStagingMessageContext } | null {
  const draft = opts.draft.trim();
  const attachments = (opts.attachments || []).filter((a) => a.stagingFileId && !a.uploadError);
  if (!draft && attachments.length === 0) return null;
  const content =
    draft
    || (attachments.length > 1
      ? DEFAULT_REGISTER_MESSAGE_MANY
      : attachments.length === 1
        ? DEFAULT_REGISTER_MESSAGE_ONE
        : "");
  if (!content) return null;
  const attachForContext = opts.includeAttachments === false ? [] : attachments;
  return {
    content,
    ...(attachForContext.length > 0
      ? { messageContext: buildInvoiceStagingMessageContext(attachForContext) }
      : {}),
  };
}

export async function uploadAgentInvoiceStagingFile(
  file: File,
  opts?: { agentRunId?: string | null },
): Promise<AgentInvoiceStagingAttachment> {
  const formData = new FormData();
  formData.append("file", file);
  if (opts?.agentRunId) {
    formData.append("agentRunId", opts.agentRunId);
  }
  const res = await fetch("/api/agent/invoice-staging", {
    method: "POST",
    body: formData,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof data.error === "string" ? data.error : "发票文件上传失败",
    );
  }
  const staging = data.stagingFile;
  if (!staging || typeof staging !== "object") {
    throw new Error("发票文件上传响应无效");
  }
  const record = staging as Record<string, unknown>;
  if (
    typeof record.id !== "string"
    || typeof record.fileName !== "string"
    || typeof record.mimeType !== "string"
    || typeof record.fileSize !== "number"
    || typeof record.sha256 !== "string"
    || typeof record.version !== "number"
    || typeof record.expiresAt !== "string"
  ) {
    throw new Error("发票文件上传响应缺少必要字段");
  }
  return {
    stagingFileId: record.id,
    fileName: record.fileName,
    mimeType: record.mimeType,
    fileSize: record.fileSize,
    sha256: record.sha256,
    version: record.version,
    expiresAt: record.expiresAt,
    queueStatus: "uploaded",
  };
}

/**
 * Upload up to 10 files sequentially. Partial success is kept.
 */
export async function uploadAgentInvoiceStagingFiles(
  files: File[],
  opts?: { agentRunId?: string | null },
): Promise<{
  attachments: AgentInvoiceStagingAttachment[];
  failures: Array<{ fileName: string; error: string }>;
}> {
  const selected = files.slice(0, AGENT_INVOICE_STAGING_MAX_FILES);
  let totalBytes = 0;
  const attachments: AgentInvoiceStagingAttachment[] = [];
  const failures: Array<{ fileName: string; error: string }> = [];

  for (const file of selected) {
    if (totalBytes + file.size > AGENT_INVOICE_STAGING_MAX_TOTAL_BYTES) {
      failures.push({ fileName: file.name, error: "附件总大小超过 100 MB" });
      continue;
    }
    try {
      const staging = await uploadAgentInvoiceStagingFile(file, opts);
      totalBytes += staging.fileSize;
      attachments.push(staging);
    } catch (err) {
      failures.push({
        fileName: file.name,
        error: err instanceof Error ? err.message : "上传失败",
      });
    }
  }

  return { attachments, failures };
}

export function formatInvoiceQueueProgress(attachments: AgentInvoiceStagingAttachment[]): string {
  const total = attachments.length;
  if (total === 0) return "";
  const done = attachments.filter((a) =>
    a.queueStatus === "registered" || a.queueStatus === "skipped" || a.queueStatus === "failed"
  ).length;
  const current = Math.min(done + 1, total);
  return `已处理 ${done}/${total}，当前第 ${current} 张`;
}
