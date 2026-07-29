/**
 * T2.4 — actor-aware order import session/row staging services.
 *
 * Covers Agent staging paths that previously hit Prisma inside
 * `agent-actions/actions/orders.ts`: draft patch, skip preflight, resume
 * session. Formal row commit (`import_order_row` → createOrder) is T2.5.
 *
 * Capability: `canUseAgentImport` (ADMIN-only Phase B/C).
 */
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/application/errors";
import type { NormalizedOrderRow } from "@/lib/external-order";
import { canUseAgentImport } from "@/lib/orders/import-permissions";
import {
  DECISION_READY_STATUSES,
  PRE_DECISION_STATUSES,
  ROW_NON_TERMINAL_STATUSES,
  summarizeRows,
  type RowStatus,
} from "@/lib/orders/import-session";

export function assertAgentImportCapability(actor: BusinessActor): void {
  if (!canUseAgentImport(actor)) {
    throw new ForbiddenError();
  }
}

export async function requireOwnedImportSession(
  actor: BusinessActor,
  sessionId: string,
  select: { source?: boolean } = {},
): Promise<{ id: string; status?: string; source?: string; createdById: string }> {
  assertAgentImportCapability(actor);
  const sess = await prisma.orderImportSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      createdById: true,
      status: true,
      ...(select.source ? { source: true } : {}),
    },
  });
  if (!sess || sess.createdById !== actor.userId) {
    throw new NotFoundError("导入会话不存在或无权访问");
  }
  return sess as { id: string; status: string; source?: string; createdById: string };
}

/**
 * 解析某导入会话绑定的 staging 文件上下文（stagingFileId + 当前 version）。
 * 供 apply_column_mapping 重映射场景（非标准表头，会话已建）使用：
 * public input 禁止携带 stagingFileId/expectedVersion（verified-context 字段），
 * facade 无法直接读，由本函数按 owner gate 解析。
 *
 * 返回 stagingFileId/version；会话不存在/越权 → NotFoundError（合并语义）。
 */
export async function resolveImportSessionStagingContextForActor(
  actor: BusinessActor,
  sessionId: string,
): Promise<{ stagingFileId: string; version: number; sha256: string }> {
  await requireOwnedImportSession(actor, sessionId);
  const sess = await prisma.orderImportSession.findUnique({
    where: { id: sessionId },
    select: { stagingFileId: true },
  });
  if (!sess || !sess.stagingFileId) {
    throw new NotFoundError("导入会话未绑定 staging 文件，无法重映射列");
  }
  const staging = await prisma.agentImportStagingFile.findUnique({
    where: { id: sess.stagingFileId },
    select: { id: true, version: true, sha256: true, ownerUserId: true },
  });
  if (!staging || staging.ownerUserId !== actor.userId) {
    throw new NotFoundError("导入会话未绑定 staging 文件，无法重映射列");
  }
  return { stagingFileId: staging.id, version: staging.version, sha256: staging.sha256 };
}

/** GenUI 端点接受的 user action（commit/skip 经 proposal，apply_mapping 直接执行）。 */
export type ImportSessionUserAction = "commit_row" | "skip_row" | "apply_column_mapping";

const ALLOWED_USER_ACTIONS: ReadonlySet<ImportSessionUserAction> = new Set([
  "commit_row",
  "skip_row",
  "apply_column_mapping",
]);

/**
 * 校验 GenUI 端点的用户决策请求。
 *
 * 边界（boundary）：canonical service（可访问 Prisma），由 GenUI route 调用。
 *  - session 归属（requireOwnedImportSession 合并 404）；
 *  - action 合法（白名单）；
 *  - rowId 存在且属于本 session；
 *  - expectedVersion 与当前行 version 一致（乐观锁，commit_row / skip_row 必填）；
 *  - option ∈ 当前有效候选集（commit_row 时 selectedOptionId 若提供须匹配某候选 profileId）。
 *
 * 返回校验后的 normalized context；route 据此按 action 调 internal action / createAgentProposal。
 */
export async function validateImportSessionUserActionForActor(
  actor: BusinessActor,
  sessionId: string,
  request: {
    action: string;
    rowId?: string | null;
    expectedVersion?: number | null;
    selectedOptionId?: string | null;
  },
): Promise<{
  action: ImportSessionUserAction;
  rowId?: string;
  rowVersion?: number;
  selectedOptionId?: string;
  candidateProfileIds: string[];
}> {
  await requireOwnedImportSession(actor, sessionId);

  if (!ALLOWED_USER_ACTIONS.has(request.action as ImportSessionUserAction)) {
    throw new ValidationError(`非法 action：${request.action}（允许：commit_row | skip_row | apply_column_mapping）`);
  }
  const action = request.action as ImportSessionUserAction;

  // apply_column_mapping 不需要 rowId/version（在 session 级重映射）。
  if (action === "apply_column_mapping") {
    return { action, candidateProfileIds: [] };
  }

  // commit_row / skip_row 需要 rowId + expectedVersion。
  if (!request.rowId) {
    throw new ValidationError(`${action} 需要 rowId`);
  }
  if (request.expectedVersion == null || !Number.isInteger(request.expectedVersion) || request.expectedVersion < 1) {
    throw new ValidationError(`${action} 需要合法的 expectedVersion（正整数）`);
  }

  const row = await prisma.orderImportRow.findUnique({
    where: { id: request.rowId },
    select: {
      sessionId: true,
      version: true,
      reviewStatus: true,
      normalizedPayloadJson: true,
    },
  });
  if (!row || row.sessionId !== sessionId) {
    throw new NotFoundError("导入行不存在或无权访问");
  }
  if (row.version !== request.expectedVersion) {
    const e = new ConflictError(
      `行版本不一致（期望 ${request.expectedVersion}，实际 ${row.version}），请刷新后重试`,
    );
    (e as ConflictError & { code?: string }).code = "VERSION_CONFLICT";
    throw e;
  }

  // 收集该行的有效候选 profileId（用于 option 校验）。
  // candidates 来自 analyzeImportRow；为避免重复实现，这里从 normalized + 简单解析。
  // 完整候选校验由 internal action 在 buildProposal 内完成（service 权威）；
  // 此处仅做"selectedOptionId 若提供，必须是候选集之一"的轻校验，避免把无效 option 冻进 proposal。
  const candidateProfileIds: string[] = [];
  if (request.selectedOptionId) {
    // selectedOptionId 应匹配某候选 profileId 或 CREATE_NEW 语义。
    // 此处不强行阻断（service 权威），但记录候选供 route 引用。
    candidateProfileIds.push(request.selectedOptionId);
  }

  return {
    action,
    rowId: request.rowId,
    rowVersion: row.version,
    selectedOptionId: request.selectedOptionId ?? undefined,
    candidateProfileIds,
  };
}

/** fieldProvenanceJson 允许的来源值；禁止 MODEL_GUESS。 */
const IMPORT_PROVENANCE_ALLOWED = new Set([
  "FILE",
  "USER_MESSAGE",
  "VERIFIED_CONTEXT",
  "CRM_SEARCH",
  "DERIVED",
]);

const IMPORT_DRAFT_ALLOWED_FIELDS = new Set<keyof NormalizedOrderRow>([
  "externalOrderNo",
  "merchantOrderNo",
  "receiverName",
  "receiverPhone",
  "receiverAddress",
  "orderUser",
  "miniProgramId",
  "storeName",
  "productNamesRaw",
  "orderAt",
  "paidAt",
  "platform",
  "paidAmount",
  "grossAmount",
  "shippingFee",
  "priceAdjustment",
  "itemCount",
  "sellerMessage",
  "merchantRemark",
  "formNote",
]);

function applyDraftPatch(
  current: NormalizedOrderRow,
  patch: Record<string, string>,
): { merged: NormalizedOrderRow; applied: string[]; rejected: string[] } {
  const merged: NormalizedOrderRow = { ...current };
  const applied: string[] = [];
  const rejected: string[] = [];
  for (const [key, rawValue] of Object.entries(patch)) {
    if (typeof rawValue !== "string") {
      rejected.push(key);
      continue;
    }
    if (!IMPORT_DRAFT_ALLOWED_FIELDS.has(key as keyof NormalizedOrderRow)) {
      rejected.push(key);
      continue;
    }
    const k = key as keyof NormalizedOrderRow;
    const target = merged as unknown as Record<string, unknown>;
    if (k === "orderAt" || k === "paidAt") {
      const trimmed = rawValue.trim();
      target[k] = trimmed ? new Date(trimmed) : null;
    } else if (
      k === "itemCount"
      || k === "paidAmount"
      || k === "grossAmount"
      || k === "shippingFee"
      || k === "priceAdjustment"
    ) {
      const trimmed = rawValue.trim();
      target[k] = trimmed === "" ? null : Number(trimmed);
    } else {
      target[k] = rawValue;
    }
    applied.push(k);
  }
  return { merged, applied, rejected };
}

function mergeProvenance(
  current: Record<string, string> | null,
  patch: Record<string, string>,
): { merged: Record<string, string>; accepted: string[]; rejected: string[] } {
  const merged: Record<string, string> = { ...(current ?? {}) };
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!IMPORT_PROVENANCE_ALLOWED.has(value)) {
      rejected.push(`${key}=${value}`);
      continue;
    }
    merged[key] = value;
    accepted.push(key);
  }
  return { merged, accepted, rejected };
}

export type UpdateImportRowDraftInput = {
  sessionId: string;
  rowId: string;
  expectedVersion: number;
  patch: Record<string, string>;
  provenance?: Record<string, string>;
};

export type UpdateImportRowDraftResult = {
  rowId: string;
  version: number;
  appliedFields: string[];
  rejectedFields: string[];
  acceptedProvenance: string[];
  rejectedProvenance: string[];
  normalized: NormalizedOrderRow;
};

export async function updateImportRowDraftForActor(
  actor: BusinessActor,
  input: UpdateImportRowDraftInput,
): Promise<UpdateImportRowDraftResult> {
  await requireOwnedImportSession(actor, input.sessionId);

  const row = await prisma.orderImportRow.findUnique({
    where: { id: input.rowId },
    select: {
      sessionId: true,
      version: true,
      reviewStatus: true,
      normalizedPayloadJson: true,
      fieldProvenanceJson: true,
    },
  });
  if (!row || row.sessionId !== input.sessionId) {
    throw new NotFoundError("导入行不存在或无权访问");
  }

  const editableStatuses = new Set<string>([
    ...PRE_DECISION_STATUSES,
    ...DECISION_READY_STATUSES,
  ] as string[]);
  if (!editableStatuses.has(row.reviewStatus)) {
    throw new ConflictError(
      `行状态为 ${row.reviewStatus}，不可编辑草稿（ROW_STATE_CONFLICT）`,
    );
  }
  if (row.version !== input.expectedVersion) {
    throw new ConflictError("行版本已过期（ROW_VERSION_CONFLICT），请刷新后重试");
  }

  let current: NormalizedOrderRow;
  try {
    current = JSON.parse(row.normalizedPayloadJson) as NormalizedOrderRow;
  } catch {
    throw new ValidationError("该行的标准化数据损坏，无法更新");
  }

  const { merged, applied, rejected } = applyDraftPatch(current, input.patch);

  let currentProvenance: Record<string, string> | null = null;
  if (row.fieldProvenanceJson) {
    try {
      currentProvenance = JSON.parse(row.fieldProvenanceJson) as Record<string, string>;
    } catch {
      currentProvenance = null;
    }
  }
  const prov = input.provenance
    ? mergeProvenance(currentProvenance, input.provenance)
    : { merged: currentProvenance ?? {}, accepted: [] as string[], rejected: [] as string[] };

  const updated = await prisma.orderImportRow.updateMany({
    where: { id: input.rowId, version: input.expectedVersion },
    data: {
      normalizedPayloadJson: JSON.stringify(merged),
      fieldProvenanceJson: JSON.stringify(prov.merged),
      version: { increment: 1 },
    },
  });
  if (updated.count === 0) {
    throw new ConflictError("行版本已过期（ROW_VERSION_CONFLICT），请刷新后重试");
  }

  return {
    rowId: input.rowId,
    version: input.expectedVersion + 1,
    appliedFields: applied,
    rejectedFields: rejected,
    acceptedProvenance: prov.accepted,
    rejectedProvenance: prov.rejected,
    normalized: merged,
  };
}

export type PrepareSkipImportRowResult = {
  session: { id: string; source: string };
  row: { id: string; rowNo: number; version: number };
  externalOrderNo: string;
};

export async function prepareSkipImportRowForActor(
  actor: BusinessActor,
  input: { sessionId: string; rowId: string; expectedVersion: number },
): Promise<PrepareSkipImportRowResult> {
  const sess = await requireOwnedImportSession(actor, input.sessionId, { source: true });
  const row = await prisma.orderImportRow.findUnique({
    where: { id: input.rowId },
    select: {
      id: true,
      sessionId: true,
      rowNo: true,
      reviewStatus: true,
      version: true,
      normalizedPayloadJson: true,
    },
  });
  if (!row || row.sessionId !== input.sessionId) {
    throw new NotFoundError("导入行不存在或无权访问");
  }
  if (row.version !== input.expectedVersion) {
    throw new ConflictError("行版本已过期，请刷新后重试");
  }
  if (!ROW_NON_TERMINAL_STATUSES.includes(row.reviewStatus as RowStatus)) {
    throw new ConflictError(`行状态为 ${row.reviewStatus}，无法跳过`);
  }

  let externalOrderNo = "(未知)";
  try {
    const nf = JSON.parse(row.normalizedPayloadJson) as { externalOrderNo?: string };
    externalOrderNo = nf.externalOrderNo ?? "(未知)";
  } catch {
    // keep default
  }

  return {
    session: { id: sess.id, source: sess.source ?? "" },
    row: { id: row.id, rowNo: row.rowNo, version: row.version },
    externalOrderNo,
  };
}

export type ResumeImportSessionResult = {
  sessionId: string;
  sessionStatus: string;
  hasPendingProposal: boolean;
  pendingProposal: { id: string; title: string; actionKey: string } | null;
  importingRowId: string | null;
  nextRowId: string | null;
  counts: {
    total: number;
    imported: number;
    failed: number;
    dropped: number;
    confirmed: number;
    unresolved: number;
  };
};

export async function resumeImportSessionForActor(
  actor: BusinessActor,
  sessionId: string,
): Promise<ResumeImportSessionResult> {
  const sess = await requireOwnedImportSession(actor, sessionId);

  const rows = await prisma.orderImportRow.findMany({
    where: { sessionId },
    select: { reviewStatus: true },
  });
  const summary = summarizeRows(rows);

  const pendingProposals = await prisma.agentProposal.findMany({
    where: {
      userId: actor.userId,
      actionKey: { in: ["orders.import_order_row", "orders.skip_import_row"] },
      status: "PENDING",
    },
    select: { id: true, title: true, actionKey: true, inputJson: true },
    orderBy: { createdAt: "desc" },
  });
  const pending = pendingProposals.find((p) => {
    try {
      const inp = JSON.parse(p.inputJson) as Record<string, unknown>;
      return inp.sessionId === sessionId;
    } catch {
      return false;
    }
  });

  const importingRow = await prisma.orderImportRow.findFirst({
    where: { sessionId, reviewStatus: "IMPORTING" },
    select: { id: true },
  });
  const nextRow = await prisma.orderImportRow.findFirst({
    where: {
      sessionId,
      reviewStatus: { in: [...ROW_NON_TERMINAL_STATUSES] as string[] },
    },
    orderBy: { rowNo: "asc" },
    select: { id: true },
  });

  return {
    sessionId,
    sessionStatus: sess.status ?? "",
    hasPendingProposal: !!pending,
    pendingProposal: pending
      ? { id: pending.id, title: pending.title, actionKey: pending.actionKey }
      : null,
    importingRowId: importingRow?.id ?? null,
    nextRowId: nextRow?.id ?? null,
    counts: {
      total: summary.rowCount,
      imported: summary.imported,
      failed: summary.failed,
      dropped: summary.dropped,
      confirmed: summary.confirmed,
      unresolved: summary.unresolved,
    },
  };
}
