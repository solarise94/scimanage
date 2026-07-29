/**
 * Canonical actor-aware invoice staging analysis command (T6.6 facade).
 *
 * Wraps `analyzeStagedInvoice` with capability checks and AgentActionLog audit.
 * Shared by Agent `finance.analyze_invoice_file`.
 */
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import { ForbiddenError, ValidationError } from "@/lib/application/errors";
import { writeAgentActionLog } from "@/lib/application/agent-action-logs";
import {
  analyzeStagedInvoice,
  InvoiceOcrError,
  type AnalyzeStagedInvoiceResult,
} from "@/lib/finance/invoice-ocr";
import { GlmOcrClientError, isGlmOcrConfigured } from "@/lib/finance/glm-ocr-client";

export type AnalyzeInvoiceFileInput = {
  stagingFileId: string;
  expectedSha256: string;
  expectedStagingVersion: number;
  forceRetry?: boolean;
};

function assertAnalyzeCapability(actor: BusinessActor, workerIngest: boolean): void {
  if (!workerIngest && actor.role !== "ADMIN") {
    throw new ForbiddenError("仅管理员可分析发票附件");
  }
  if (!isGlmOcrConfigured()) {
    throw new ValidationError("未启用发票 OCR（缺少 ZHIPU_API_KEY）");
  }
}

function auditInput(input: AnalyzeInvoiceFileInput) {
  return {
    stagingFileId: input.stagingFileId,
    expectedSha256Prefix: input.expectedSha256.slice(0, 12),
    expectedStagingVersion: input.expectedStagingVersion,
    forceRetry: input.forceRetry ?? false,
  };
}

function successAuditOutput(
  result: AnalyzeStagedInvoiceResult,
  started: number,
) {
  return {
    stagingFileId: result.staging.id,
    version: result.staging.version,
    mimeHint: true,
    sha256Prefix: result.staging.sha256.slice(0, 12),
    elapsedMs: Date.now() - started,
    provider: "zhipu",
    model: "glm-ocr",
    fieldsPresent: {
      invoiceNumber: Boolean(result.extracted.invoiceNumber),
      issuedAt: Boolean(result.extracted.issuedAt),
      totalAmountCents: result.extracted.totalAmountCents != null,
      buyerTaxId: Boolean(result.extracted.buyerTaxIdMasked),
      sellerTaxId: Boolean(result.extracted.sellerTaxIdMasked),
      invoiceType: result.extracted.invoiceType !== "UNKNOWN",
    },
    matchStatus: result.match.status,
    candidateCount: result.match.candidates.length,
    topScore: result.match.candidates[0]?.score ?? null,
  };
}

function errorAuditOutput(err: unknown, started: number) {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: string }).code)
      : "INVOICE_OCR_PROVIDER_ERROR";
  return {
    elapsedMs: Date.now() - started,
    errorCode: code,
  };
}

export type AnalyzeInvoiceFileOptions = {
  signal?: AbortSignal;
  invocation?: InvocationContext;
  /** INVOICE_INGEST background worker: real owner actor; staging ownership enforced downstream. */
  workerIngest?: boolean;
};

export async function analyzeInvoiceFileForActor(
  actor: BusinessActor,
  input: AnalyzeInvoiceFileInput,
  opts: AnalyzeInvoiceFileOptions = {},
): Promise<AnalyzeStagedInvoiceResult> {
  assertAnalyzeCapability(actor, opts.workerIngest === true);
  const started = Date.now();
  const agentRunId = opts.invocation?.agentRunId ?? null;

  try {
    const result = await analyzeStagedInvoice({
      userId: actor.userId,
      stagingFileId: input.stagingFileId,
      expectedSha256: input.expectedSha256,
      expectedStagingVersion: input.expectedStagingVersion,
      forceRetry: input.forceRetry ?? false,
      signal: opts.signal,
    });

    await writeAgentActionLog({
      userId: actor.userId,
      agentRunId,
      actionKey: "finance.analyze_invoice_file",
      riskLevel: "safe",
      status: "SUCCESS",
      input: auditInput(input),
      output: successAuditOutput(result, started),
      target: { type: "invoice_staging", id: result.staging.id },
    }).catch(() => undefined);

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "分析失败";
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: string }).code)
        : "INVOICE_OCR_PROVIDER_ERROR";

    await writeAgentActionLog({
      userId: actor.userId,
      agentRunId,
      actionKey: "finance.analyze_invoice_file",
      riskLevel: "safe",
      status: "ERROR",
      input: auditInput(input),
      error: `${code}: ${message}`.slice(0, 400),
      output: errorAuditOutput(err, started),
      target: { type: "invoice_staging", id: input.stagingFileId },
    }).catch(() => undefined);

    throw err;
  }
}

export { InvoiceOcrError, GlmOcrClientError };
