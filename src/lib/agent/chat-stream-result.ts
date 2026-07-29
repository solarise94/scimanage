/**
 * chat-stream 409 分类与回滚算法（docs Part 1 §1.3）。
 *
 * 纯函数、无 React 依赖、可单测。双端（桌面 `agent-workbench.tsx` / 移动
 * `agent-mobile-shell.tsx`）的 `runPiStream` / `sendMessage` 共用本模块，杜绝
 * 409 分类与回滚逻辑再次漂移。
 *
 * 设计要点：
 * - `classifyChatStream409` 是 409 分类的唯一权威实现；`undefined` 与
 *   `RUNTIME_NOT_PI` → `runtime_not_pi`（兼容旧服务端无 code 的 A 类 409），
 *   其余一切（含未知 code）→ `attachment_conflict`（fail-closed）。
 * - `removeOptimisticTurn` / `restoreGenericQueueAfterConflict` 只做"删哪些 /
 *   标哪些"的纯算法，React setState 由各端 sendMessage 自行执行。
 */

// 入参仅依赖结构子集，避免从组件文件 import 类型造成循环依赖。
export interface ChatStreamMessageLike {
  id: string;
  role: "user" | "assistant";
}

export interface ChatStreamGenericAttachmentLike {
  stagingFileId: string;
  uploadError?: string;
}

/** 409 分类结果。 */
export type ChatStream409Class = "runtime_not_pi" | "attachment_conflict";

/**
 * 把 chat-stream 409 的 `code` 字段映射为两类语义。
 *
 * @param code 服务端 409 响应体里的 `code`（可能为 undefined）。
 * @returns `"runtime_not_pi"` 表示 runtime 未配置，可回退 legacy；
 *          `"attachment_conflict"` 表示附件冲突 / 未知，fail-closed 不回退。
 */
export function classifyChatStream409(code: string | undefined): ChatStream409Class {
  if (code === "RUNTIME_NOT_PI" || code === undefined) {
    return "runtime_not_pi";
  }
  return "attachment_conflict";
}

/**
 * `runPiStream` 的判别式返回类型。`runPiStream` 只解析、不回滚；回滚由持有
 * 快照的 `sendMessage` 执行。
 */
export type PiStreamResult =
  | { kind: "streamed"; shouldAdvanceQueue: boolean }
  | { kind: "runtime_unavailable" }
  | { kind: "conflict"; code: string | undefined; message: string };

/**
 * 从乐观追加的 user + assistant 消息中双删本轮占位。
 *
 * 幂等：任一 id 不存在时仍安全（只删存在的）。
 */
export function removeOptimisticTurn<T extends ChatStreamMessageLike>(
  messages: readonly T[],
  userMessageId: string,
  assistantMessageId: string,
): T[] {
  return messages.filter(
    (message) => message.id !== userMessageId && message.id !== assistantMessageId,
  );
}

/**
 * 409 冲突后恢复通用附件队列快照：本轮发出项置 `uploadError`，其余项（含原有
 * error 项与未发出项）原样保留。
 *
 * @param previousQueue 清空队列前的全量快照（含原有 error 项）。
 * @param pendingStagingFileIds 本轮实际发出（stagingFileId 存在且原本无 error）
 *        的附件 stagingFileId 集合。
 * @param errorMessage 标记到本轮发出项上的 uploadError 文案。
 */
export function restoreGenericQueueAfterConflict<T extends ChatStreamGenericAttachmentLike>(
  previousQueue: readonly T[],
  pendingStagingFileIds: ReadonlySet<string>,
  errorMessage: string,
): T[] {
  return previousQueue.map((item) =>
    pendingStagingFileIds.has(item.stagingFileId)
      ? { ...item, uploadError: errorMessage }
      : item,
  );
}
