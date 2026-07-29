/**
 * Bank-flow workspace manifest types shared by canonical services and Agent adapters.
 */
import type { BankFlowEncoding, BankFlowColumnMapping } from "@/lib/finance/bank-flow-parser";
import type { BankFlowMatchResult, BankFlowRowStatus } from "@/lib/finance/bank-flow-matcher";
import { ConflictError } from "@/lib/application/errors";

export type BankFlowPhase =
  | "PARSED"
  | "MAPPED"
  | "OCR_PENDING"
  | "MATCHING"
  | "MATCHED"
  | "EXECUTING"
  | "PARTIAL_FAILED"
  | "CONFIRMED";

export type BankFlowManifest = {
  stagingFileId: string;
  /** OCR/多文件批次；缺省时回退为 [stagingFileId] */
  stagingFileIds?: string[];
  phase: BankFlowPhase;
  boundProposalId?: string;
  matchJobId?: string | null;
  headers: string[];
  rowCount: number;
  encoding: BankFlowEncoding;
  mapping: Partial<BankFlowColumnMapping> & {
    payerName?: string;
    amount?: string;
  };
  rows: Array<{
    index: number;
    payerName: string;
    amountCents: number;
    date?: string;
    remark?: string;
    status: BankFlowRowStatus;
  }>;
  matchResults?: BankFlowMatchResult[];
  executionResults?: Array<{
    rowIndex: number;
    receiptId?: string;
    error?: string;
  }>;
  source?: "file" | "ocr";
  ocrProgress?: {
    completed: Array<{
      stagingFileId: string;
      row: {
        index: number;
        payerName: string;
        amountCents: number;
        date?: string;
        remark?: string;
        status: BankFlowRowStatus;
      };
    }>;
    warnings: string[];
  };
};

export const BANK_FLOW_FROZEN_PHASES: BankFlowPhase[] = ["MATCHING", "EXECUTING", "CONFIRMED"];

export function parseBankFlowManifest(raw: string | null | undefined): BankFlowManifest {
  if (!raw) throw new Error("workspace manifest 为空");
  try {
    return JSON.parse(raw) as BankFlowManifest;
  } catch {
    throw new Error("workspace manifest 解析失败");
  }
}

export function previewBankFlowRows(rows: BankFlowManifest["rows"], limit = 20) {
  return rows.slice(0, limit).map((r) => ({
    index: r.index,
    payerName: r.payerName,
    amountCents: r.amountCents,
    date: r.date ?? null,
    remark: r.remark ?? null,
    status: r.status,
  }));
}

function assertNotFrozenPhase(phase: BankFlowPhase): void {
  if (BANK_FLOW_FROZEN_PHASES.includes(phase)) {
    if (phase === "MATCHING") {
      throw new Error("WORKSPACE_FROZEN：异步匹配进行中，请等待完成或取消任务");
    }
    throw new Error("WORKSPACE_FROZEN：工作区已冻结，不可修改");
  }
  if (phase === "PARTIAL_FAILED") {
    throw new Error("WORKSPACE_FROZEN：部分失败态请先 reopen_bank_flow_rows");
  }
}

export function assertBankFlowMappingPhase(phase: BankFlowPhase): void {
  assertNotFrozenPhase(phase);
  if (phase !== "PARSED" && phase !== "MAPPED") {
    throw new Error(`当前 phase=${phase}，无法改映射`);
  }
}

export function assertBankFlowMatchPhase(phase: BankFlowPhase): void {
  assertNotFrozenPhase(phase);
  if (phase !== "MAPPED" && phase !== "MATCHED") {
    throw new Error(`当前 phase=${phase}，请先完成列映射`);
  }
}

export function assertBankFlowSelectionPhase(phase: BankFlowPhase): void {
  assertNotFrozenPhase(phase);
  if (phase !== "MATCHED") {
    throw new Error(`当前 phase=${phase}，仅 MATCHED 可改选择`);
  }
}

export function assertBankFlowReopenPhase(phase: BankFlowPhase): void {
  if (BANK_FLOW_FROZEN_PHASES.includes(phase)) {
    if (phase === "MATCHING") {
      throw new Error("WORKSPACE_FROZEN：异步匹配进行中，请等待完成或取消任务");
    }
    throw new Error("WORKSPACE_FROZEN：工作区已冻结，不可修改");
  }
  if (phase !== "PARTIAL_FAILED") {
    throw new Error(`仅 PARTIAL_FAILED 可 reopen（当前 phase=${phase}）`);
  }
}

/** Map phase assertion errors to application ConflictError in canonical services. */
export function mapBankFlowPhaseError(err: unknown): never {
  if (err instanceof Error) {
    if (
      err.message.startsWith("WORKSPACE_FROZEN") ||
      err.message.startsWith("当前 phase=") ||
      err.message.startsWith("仅 PARTIAL_FAILED")
    ) {
      throw new ConflictError(err.message);
    }
  }
  throw err;
}
