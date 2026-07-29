"use client";

/**
 * Client helpers for Agent 通用附件（docs §3.1）。
 * 文件选择 / 拖放 / 粘贴共用同一上传与队列；服务端为最终校验者。
 * 每消息最多 5 个、总计 30 MB；仅接受白名单类型。
 */

import { DEFAULT_ATTACHMENT_ONLY_MESSAGE } from "@/lib/agent-attachments/constants";
import type { AgentChatMessageAttachment } from "@/lib/agent-runtime/types";

export const AGENT_ATTACHMENT_MAX_FILES = 5;
export const AGENT_ATTACHMENT_MAX_TOTAL_BYTES = 30 * 1024 * 1024;

/** 首期白名单（仅改善 UX；服务端以真实 bytes 为准）。 */
export const AGENT_ATTACHMENT_ACCEPT = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".pdf",
  ".txt",
  ".csv",
  ".docx",
  ".xlsx",
].join(",");

export type AgentGenericAttachment = {
  stagingFileId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
  version: number;
  expiresAt: string;
  /** 客户端队列状态。 */
  queueStatus?: "uploading" | "uploaded" | "failed";
  uploadError?: string;
};

export type VerifiedAgentAttachmentMessageContext = {
  verifiedAgentAttachments?: Array<{
    stagingFileId: string;
    sha256: string;
    version: number;
    fileName: string;
    mimeType: string;
  }>;
};

const NATIVE_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

export function isImageAttachment(mimeType: string): boolean {
  return NATIVE_IMAGE_MIME.has(mimeType);
}

export function buildAgentAttachmentMessageContext(
  attachments: AgentGenericAttachment[],
): VerifiedAgentAttachmentMessageContext {
  const files = attachments
    .filter((a) => a.stagingFileId && !a.uploadError)
    .map((a) => ({
      stagingFileId: a.stagingFileId,
      sha256: a.sha256,
      version: a.version,
      fileName: a.fileName,
      mimeType: a.mimeType,
    }));
  if (files.length === 0) return {};
  return { verifiedAgentAttachments: files };
}

/**
 * 解析发送内容：有草稿用草稿；只有附件时用统一默认文本（集中常量，便于本地化）。
 * 无草稿且无附件返回 null（不可发送）。
 */
export function resolveSendMessageWithAgentAttachments(opts: {
  draft: string;
  attachments: AgentGenericAttachment[];
}): { content: string; messageContext?: VerifiedAgentAttachmentMessageContext } | null {
  const draft = opts.draft.trim();
  const attachments = (opts.attachments || []).filter((a) => a.stagingFileId && !a.uploadError);
  if (!draft && attachments.length === 0) return null;
  const content = draft || DEFAULT_ATTACHMENT_ONLY_MESSAGE;
  return {
    content,
    ...(attachments.length > 0
      ? { messageContext: buildAgentAttachmentMessageContext(attachments) }
      : {}),
  };
}

export async function uploadAgentAttachment(
  file: File,
  opts?: { agentRunId?: string | null; chatSessionId?: string | null },
): Promise<AgentGenericAttachment> {
  const formData = new FormData();
  formData.append("file", file);
  if (opts?.agentRunId) formData.append("agentRunId", opts.agentRunId);
  if (opts?.chatSessionId) formData.append("chatSessionId", opts.chatSessionId);

  const res = await fetch("/api/agent/attachments", { method: "POST", body: formData });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "附件上传失败");
  }
  const staging = data.stagingFile;
  if (!staging || typeof staging !== "object") {
    throw new Error("附件上传响应无效");
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
    throw new Error("附件上传响应缺少必要字段");
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

/** 顺序上传多个文件；部分成功保留。强制数量与总量上限。 */
export async function uploadAgentAttachments(
  files: File[],
  opts?: { agentRunId?: string | null; chatSessionId?: string | null },
): Promise<{
  attachments: AgentGenericAttachment[];
  failures: Array<{ fileName: string; error: string }>;
}> {
  const attachments: AgentGenericAttachment[] = [];
  const failures: Array<{ fileName: string; error: string }> = [];
  let totalBytes = 0;

  for (const file of files) {
    if (attachments.length >= AGENT_ATTACHMENT_MAX_FILES) {
      failures.push({ fileName: file.name, error: `每条消息最多 ${AGENT_ATTACHMENT_MAX_FILES} 个附件` });
      continue;
    }
    if (totalBytes + file.size > AGENT_ATTACHMENT_MAX_TOTAL_BYTES) {
      failures.push({ fileName: file.name, error: "附件总大小超过 30 MB" });
      continue;
    }
    try {
      const staging = await uploadAgentAttachment(file, opts);
      totalBytes += staging.fileSize;
      attachments.push(staging);
    } catch (err) {
      failures.push({ fileName: file.name, error: err instanceof Error ? err.message : "上传失败" });
    }
  }

  return { attachments, failures };
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 乐观 UI：发送瞬间把队列附件映射为消息内文件卡片数据（刚上传，未过期）。 */
export function toOptimisticMessageAttachments(
  attachments: AgentGenericAttachment[],
): AgentChatMessageAttachment[] {
  return attachments
    .filter((a) => a.stagingFileId && !a.uploadError)
    .map((a) => ({
      stagingFileId: a.stagingFileId,
      fileName: a.fileName,
      mimeType: a.mimeType,
      fileSize: a.fileSize,
      status: "UPLOADED",
      expired: false,
    }));
}
