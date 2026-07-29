/**
 * 登记已开发票附件并推进订单发票申请为 ISSUED。
 *
 * 页面 route 与 Agent action 共用本领域服务，禁止互相 HTTP 调用。
 */

import fs from "fs/promises";
import path from "path";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { syncOrderInvoiceStatus } from "@/lib/external-order";
import { assertOrderInvoiceReadable, resolveInvoiceTouchedOrderIds } from "@/lib/finance/order-invoice-access";
import { canWriteFinance } from "@/lib/finance/permissions";
import {
  claimIssuedInvoiceFileHash,
  claimIssuedInvoiceNumber,
} from "@/lib/finance/invoice-claims";
import {
  computeSha256,
  deleteStagingFileQuietly,
  InvoiceStagingError,
  sanitizeDisplayFileName,
  verifyStagingFileIntegrity,
} from "@/lib/finance/invoice-staging";

/** 冲红或重开后的原发票不再参与有效发票判重，也不能再登记附件。 */
const INACTIVE_INVOICE_ADJUSTMENT_KINDS = ["RED", "REISSUE"] as const;

export class RegisterIssuedInvoiceError extends Error {
  code: string;
  httpStatus: number;

  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.name = "RegisterIssuedInvoiceError";
  }
}

export type RegisterIssuedInvoiceOcrFacts = {
  amountCents?: number | null;
  buyerTaxId?: string | null;
  sellerTaxId?: string | null;
  invoiceType?: string | null;
};

export type RegisterIssuedInvoiceOptions = {
  /** Page: ADMIN + USER. Agent MVP: ADMIN only (caller enforces). */
  allowUserRole?: boolean;
  /** Page: promote DRAFT → REQUESTED before register. Agent: false. */
  allowDraftPromotion?: boolean;
  /** Page: allow ISSUED + no ACTUAL_INVOICE attachment (recovery). Agent: false. */
  allowIssuedWithoutDocument?: boolean;
  /** Agent MVP: actualInvoiceNo required. Page: optional. */
  requireActualInvoiceNo?: boolean;
  /** Optional OCR hard checks against the request. */
  ocrFacts?: RegisterIssuedInvoiceOcrFacts | null;
  /** T6.4: canonical application service already enforced full touched-order scope. */
  skipLegacyAccessCheck?: boolean;
};

export type RegisterIssuedInvoiceStagedFile = {
  id: string;
  storageKey: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
  version: number;
  status: string;
  expiresAt: Date;
  createdById: string;
  extractedJson?: string | null;
};

export type RegisterIssuedInvoiceResult = {
  invoice: {
    id: string;
    status: "ISSUED";
    actualInvoiceNo: string | null;
    actualIssuedAt: string | null;
  };
  document: {
    id: string;
    fileName: string;
    fileUrl: string;
    mimeType: string;
    fileSize: number;
    sha256: string;
  };
  touchedOrderIds: string[];
};

function mapAccessError(err: unknown): never {
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status?: number }).status;
    if (status === 403) {
      throw new RegisterIssuedInvoiceError("INVOICE_REQUEST_FORBIDDEN", "无权操作该发票", 403);
    }
    if (status === 404) {
      throw new RegisterIssuedInvoiceError("INVOICE_REQUEST_NOT_FOUND", "目标申请不存在", 404);
    }
  }
  throw err;
}

function normalizeInvoiceNo(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function parseIssuedAt(value: string | null | undefined): Date | null {
  if (value == null || value === "") return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new RegisterIssuedInvoiceError("INVOICE_FILE_INVALID", "开票日期必须为 YYYY-MM-DD", 400);
  }
  const [year, month, day] = trimmed.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new RegisterIssuedInvoiceError("INVOICE_FILE_INVALID", "开票日期无效", 400);
  }
  return date;
}

function normalizeTaxId(value: string | null | undefined): string {
  return (value || "").replace(/\s+/g, "").toUpperCase();
}

export function parseOcrFactsFromStaging(extractedJson: string | null | undefined): RegisterIssuedInvoiceOcrFacts | null {
  // 确实没有 OCR 结果 → null（正常路径，跳过验证）
  if (!extractedJson || !extractedJson.trim()) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extractedJson) as Record<string, unknown>;
  } catch {
    // JSON 损坏 → 不能静默跳过验证，否则登记金额可能与 OCR 不一致而无告警
    throw new RegisterIssuedInvoiceError(
      "OCR_FACTS_CORRUPT",
      "OCR 识别结果 JSON 损坏，无法验证发票数据完整性",
      400,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RegisterIssuedInvoiceError(
      "OCR_FACTS_CORRUPT",
      "OCR 识别结果格式异常（非对象），无法验证发票数据完整性",
      400,
    );
  }

  // Phase C extractedJson may nest fields under `extracted`.
  // 严格校验：extracted 必须是非数组对象（拒绝 [] 等非法形状）
  let source: Record<string, unknown>;
  if (parsed.extracted != null) {
    if (typeof parsed.extracted !== "object" || Array.isArray(parsed.extracted)) {
      throw new RegisterIssuedInvoiceError(
        "OCR_FACTS_CORRUPT",
        `OCR extracted 字段格式异常（${Array.isArray(parsed.extracted) ? "array" : typeof parsed.extracted}），无法验证`,
        400,
      );
    }
    source = parsed.extracted as Record<string, unknown>;
  } else {
    source = parsed;
  }

  const amountRaw = source.amountCents ?? source.totalAmountCents ?? source.totalAmount;
  let amountCents: number | null = null;
  if (amountRaw != null) {
    if (typeof amountRaw === "number" && Number.isFinite(amountRaw)) {
      amountCents = Math.round(amountRaw);
    } else {
      throw new RegisterIssuedInvoiceError(
        "OCR_FACTS_CORRUPT",
        `OCR 金额字段类型异常（${typeof amountRaw}），无法验证发票数据完整性`,
        400,
      );
    }
  }

  // 严格校验：字段存在但类型错误 → 数据损坏（不静默转 null）
  const buyerTaxId = source.buyerTaxId != null
    ? (typeof source.buyerTaxId === "string"
      ? source.buyerTaxId
      : (() => { throw new RegisterIssuedInvoiceError("OCR_FACTS_CORRUPT", `OCR buyerTaxId 类型异常（${typeof source.buyerTaxId}）`, 400); })())
    : null;
  const sellerTaxId = source.sellerTaxId != null
    ? (typeof source.sellerTaxId === "string"
      ? source.sellerTaxId
      : (() => { throw new RegisterIssuedInvoiceError("OCR_FACTS_CORRUPT", `OCR sellerTaxId 类型异常（${typeof source.sellerTaxId}）`, 400); })())
    : null;
  const invoiceType = source.invoiceType != null
    ? (typeof source.invoiceType === "string"
      ? source.invoiceType
      : (() => { throw new RegisterIssuedInvoiceError("OCR_FACTS_CORRUPT", `OCR invoiceType 类型异常（${typeof source.invoiceType}）`, 400); })())
    : null;

  return {
    amountCents,
    buyerTaxId,
    sellerTaxId,
    invoiceType: invoiceType && invoiceType.toUpperCase() !== "UNKNOWN" ? invoiceType : null,
  };
}

function assertOcrFactsMatch(
  invoice: {
    totalAmount: number;
    buyerTaxId: string | null;
    sellerTaxId: string | null;
    invoiceType: string;
  },
  facts: RegisterIssuedInvoiceOcrFacts,
) {
  if (facts.amountCents != null && facts.amountCents !== invoice.totalAmount) {
    throw new RegisterIssuedInvoiceError(
      "INVOICE_FACT_CONFLICT",
      `发票金额与申请不一致：OCR ${(facts.amountCents / 100).toFixed(2)} / 申请 ${(invoice.totalAmount / 100).toFixed(2)}`,
      400,
    );
  }
  if (facts.buyerTaxId && invoice.buyerTaxId) {
    if (normalizeTaxId(facts.buyerTaxId) !== normalizeTaxId(invoice.buyerTaxId)) {
      throw new RegisterIssuedInvoiceError("INVOICE_FACT_CONFLICT", "购方税号与申请不一致", 400);
    }
  }
  if (facts.sellerTaxId && invoice.sellerTaxId) {
    if (normalizeTaxId(facts.sellerTaxId) !== normalizeTaxId(invoice.sellerTaxId)) {
      throw new RegisterIssuedInvoiceError("INVOICE_FACT_CONFLICT", "销方税号与申请不一致", 400);
    }
  }
  if (facts.invoiceType) {
    const upper = facts.invoiceType.toUpperCase();
    // UNKNOWN 不能默认成 NORMAL；缺失可靠票种时跳过硬校验。
    if (upper === "UNKNOWN") {
      // skip
    } else {
      const normalized = upper === "SPECIAL" ? "SPECIAL" : upper === "NORMAL" ? "NORMAL" : null;
      if (normalized && normalized !== invoice.invoiceType) {
        throw new RegisterIssuedInvoiceError("INVOICE_FACT_CONFLICT", "票种与申请不一致", 400);
      }
    }
  }
}

function formalRelativeDir(invoiceRequestId: string): string {
  return path.posix.join("uploads", "invoices", "order", invoiceRequestId);
}

function formalAbsoluteDir(invoiceRequestId: string): string {
  return path.join(process.cwd(), "public", "uploads", "invoices", "order", invoiceRequestId);
}

function formalFileName(sha256: string, originalFileName: string): string {
  const safe = sanitizeDisplayFileName(originalFileName).replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${sha256.slice(0, 16)}_${safe}`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function promoteStagingBufferToFormal(opts: {
  buffer: Buffer;
  sha256: string;
  originalFileName: string;
  invoiceRequestId: string;
  proposalId: string | null;
}): Promise<{ fileUrl: string; absolutePath: string; createdNewFile: boolean }> {
  const dir = formalAbsoluteDir(opts.invoiceRequestId);
  await fs.mkdir(dir, { recursive: true });

  const finalName = formalFileName(opts.sha256, opts.originalFileName);
  const finalPath = path.join(dir, finalName);
  const fileUrl = `/${formalRelativeDir(opts.invoiceRequestId)}/${finalName}`;

  if (await fileExists(finalPath)) {
    const existing = await fs.readFile(finalPath);
    if (computeSha256(existing) === opts.sha256) {
      return { fileUrl, absolutePath: finalPath, createdNewFile: false };
    }
    throw new RegisterIssuedInvoiceError(
      "INVOICE_REGISTRATION_CONFLICT",
      "正式路径已存在不同内容的文件",
      409,
    );
  }

  const tmpName = `.tmp-${opts.proposalId || "page"}-${opts.sha256.slice(0, 12)}`;
  const tmpPath = path.join(dir, tmpName);
  await fs.writeFile(tmpPath, opts.buffer);
  try {
    const tmpHash = computeSha256(await fs.readFile(tmpPath));
    if (tmpHash !== opts.sha256) {
      throw new RegisterIssuedInvoiceError("INVOICE_FILE_INVALID", "正式文件写入后哈希校验失败", 400);
    }
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }

  return { fileUrl, absolutePath: finalPath, createdNewFile: true };
}

async function assertInvoiceNumberAvailable(
  invoiceRequestId: string,
  actualInvoiceNo: string | null,
) {
  if (!actualInvoiceNo) return;
  const conflict = await prisma.externalOrderInvoiceRequest.findFirst({
    where: {
      id: { not: invoiceRequestId },
      actualInvoiceNo,
      status: { not: "CANCELLED" },
      adjustmentsAsOriginal: { none: { kind: { in: [...INACTIVE_INVOICE_ADJUSTMENT_KINDS] } } },
    },
    select: { id: true },
  });
  if (conflict) {
    throw new RegisterIssuedInvoiceError("INVOICE_NUMBER_DUPLICATE", "发票号已在其他有效发票中登记", 409);
  }
}

async function assertFileHashNotRegisteredElsewhere(
  invoiceRequestId: string,
  sha256: string,
) {
  const sameRequest = await prisma.invoiceDocument.findFirst({
    where: {
      externalOrderInvoiceRequestId: invoiceRequestId,
      sha256,
      kind: "ACTUAL_INVOICE",
    },
    select: { id: true },
  });
  if (sameRequest) {
    throw new RegisterIssuedInvoiceError("INVOICE_FILE_DUPLICATE", "该文件已登记到本申请", 409);
  }

  const other = await prisma.invoiceDocument.findFirst({
    where: {
      sha256,
      kind: "ACTUAL_INVOICE",
      externalOrderInvoiceRequestId: { not: invoiceRequestId },
      externalOrderInvoiceRequest: {
        status: { not: "CANCELLED" },
        adjustmentsAsOriginal: { none: { kind: { in: [...INACTIVE_INVOICE_ADJUSTMENT_KINDS] } } },
      },
    },
    select: { id: true },
  });
  if (other) {
    throw new RegisterIssuedInvoiceError("INVOICE_FILE_DUPLICATE", "该文件已登记到其他有效发票", 409);
  }
}

async function loadInvoiceForRegistration(invoiceRequestId: string) {
  const invoice = await prisma.externalOrderInvoiceRequest.findUnique({
    where: { id: invoiceRequestId },
    select: {
      id: true,
      status: true,
      totalAmount: true,
      buyerOrganizationName: true,
      buyerTaxId: true,
      sellerTaxId: true,
      sellerName: true,
      invoiceType: true,
      actualInvoiceNo: true,
      actualIssuedAt: true,
      orderId: true,
      adjustmentsAsOriginal: { select: { kind: true } },
      documents: {
        where: { kind: "ACTUAL_INVOICE" },
        select: { id: true },
      },
      orderCoverage: {
        select: {
          orderId: true,
          order: { select: { id: true, orderNo: true, title: true, legacyExternalOrderId: true } },
        },
      },
      order: { select: { id: true, orderNo: true, title: true, legacyExternalOrderId: true } },
    },
  });
  if (!invoice) {
    throw new RegisterIssuedInvoiceError("INVOICE_REQUEST_NOT_FOUND", "目标申请不存在", 404);
  }
  return invoice;
}

export async function validateRegisterIssuedInvoicePreconditions(opts: {
  actor: { userId: string; role: string; department?: string };
  invoiceRequestId: string;
  stagedFile: RegisterIssuedInvoiceStagedFile;
  expectedSha256?: string;
  expectedStagingVersion?: number;
  actualInvoiceNo?: string | null;
  actualIssuedAt?: string | null;
  options?: RegisterIssuedInvoiceOptions;
}) {
  const options = opts.options ?? {};
  if (!canWriteFinance(opts.actor.role)) {
    throw new RegisterIssuedInvoiceError("INVOICE_REQUEST_FORBIDDEN", "无权登记发票", 403);
  }
  if (!options.allowUserRole && opts.actor.role !== "ADMIN") {
    throw new RegisterIssuedInvoiceError("INVOICE_REQUEST_FORBIDDEN", "仅管理员可通过 Agent 登记发票", 403);
  }
  if (opts.stagedFile.createdById !== opts.actor.userId) {
    throw new RegisterIssuedInvoiceError("INVOICE_STAGING_NOT_FOUND", "staging 不存在或不可见", 404);
  }
  if (opts.stagedFile.expiresAt.getTime() <= Date.now() || opts.stagedFile.status === "EXPIRED") {
    throw new RegisterIssuedInvoiceError("INVOICE_STAGING_EXPIRED", "staging 已过期", 410);
  }
  if (opts.stagedFile.status !== "UPLOADED" && opts.stagedFile.status !== "ANALYZED") {
    throw new RegisterIssuedInvoiceError(
      "INVOICE_STAGING_CHANGED",
      `staging 状态不可用: ${opts.stagedFile.status}`,
      409,
    );
  }

  await verifyStagingFileIntegrity({
    staging: opts.stagedFile,
    expectedSha256: opts.expectedSha256,
    expectedVersion: opts.expectedStagingVersion,
  });

  if (!options.skipLegacyAccessCheck) {
    try {
      // Fail-closed（设计 §6.1）：actor.department 缺失时传 undefined，由下游从 DB 实时解析；
      // 不再兜底 FIELD_SALES（会在用户部门异常时静默归错部门）。
      await assertOrderInvoiceReadable(opts.invoiceRequestId, opts.actor.userId, opts.actor.role, opts.actor.department);
    } catch (err) {
      mapAccessError(err);
    }
  }

  const invoice = await loadInvoiceForRegistration(opts.invoiceRequestId);

  if (invoice.adjustmentsAsOriginal.some((a) => a.kind === "RED")) {
    throw new RegisterIssuedInvoiceError("INVOICE_RED_ADJUSTED", "已冲红的发票不能登记附件", 400);
  }
  if (invoice.adjustmentsAsOriginal.some((a) => a.kind === "REISSUE")) {
    throw new RegisterIssuedInvoiceError("INVOICE_STATE_CHANGED", "已重开的原发票不能再登记附件", 409);
  }

  if (invoice.status === "DRAFT") {
    if (!options.allowDraftPromotion) {
      throw new RegisterIssuedInvoiceError(
        "INVOICE_STATE_CHANGED",
        "草稿状态不能直接登记已开发票，请先提交申请",
        409,
      );
    }
  } else if (invoice.status === "CANCELLED") {
    throw new RegisterIssuedInvoiceError("INVOICE_STATE_CHANGED", "已取消的发票不能登记已开票", 409);
  } else if (invoice.status === "ISSUED") {
    if (!options.allowIssuedWithoutDocument || invoice.documents.length > 0) {
      throw new RegisterIssuedInvoiceError(
        "INVOICE_STATE_CHANGED",
        invoice.documents.length > 0 ? "该发票已登记过附件" : "发票状态已变化",
        409,
      );
    }
  } else if (invoice.status !== "REQUESTED") {
    throw new RegisterIssuedInvoiceError("INVOICE_STATE_CHANGED", "只有待开票状态的发票才能登记已开票", 409);
  }

  if (invoice.status === "REQUESTED" && invoice.documents.length > 0) {
    throw new RegisterIssuedInvoiceError("INVOICE_STATE_CHANGED", "该申请已有真实发票附件", 409);
  }

  const actualInvoiceNo = normalizeInvoiceNo(opts.actualInvoiceNo);
  if (options.requireActualInvoiceNo && !actualInvoiceNo) {
    throw new RegisterIssuedInvoiceError("INVOICE_FILE_INVALID", "真实发票号必填", 400);
  }
  parseIssuedAt(opts.actualIssuedAt);
  await assertInvoiceNumberAvailable(opts.invoiceRequestId, actualInvoiceNo);
  await assertFileHashNotRegisteredElsewhere(opts.invoiceRequestId, opts.stagedFile.sha256);

  const ocrFacts = options.ocrFacts ?? parseOcrFactsFromStaging(opts.stagedFile.extractedJson);
  if (ocrFacts) {
    assertOcrFactsMatch(invoice, ocrFacts);
  }

  return {
    invoice,
    actualInvoiceNo,
    actualIssuedAt: parseIssuedAt(opts.actualIssuedAt),
    ocrFacts,
  };
}

export async function registerIssuedInvoiceDocument(params: {
  actor: { userId: string; role: string; department?: string };
  invoiceRequestId: string;
  stagedFile: RegisterIssuedInvoiceStagedFile;
  actualInvoiceNo?: string | null;
  actualIssuedAt?: string | null;
  expectedSha256?: string;
  expectedStagingVersion?: number;
  sourceAgentProposalId?: string | null;
  options?: RegisterIssuedInvoiceOptions;
  /**
   * Phase E：Agent channel 在最终写事务内复核 technicalOwner（防 TOCTOU）。
   * Web channel 不传。
   */
  agentOwnerRecheck?: {
    actor: { userId: string; role: string; department?: string };
    invocation: { channel: string; proposalId?: string | null };
    orderIds: string[];
  };
}): Promise<RegisterIssuedInvoiceResult> {
  const options = params.options ?? {};

  // Idempotent re-entry: same proposal already created the document.
  if (params.sourceAgentProposalId) {
    const existing = await prisma.invoiceDocument.findUnique({
      where: { sourceAgentProposalId: params.sourceAgentProposalId },
      include: {
        externalOrderInvoiceRequest: {
          select: { id: true, status: true, actualInvoiceNo: true, actualIssuedAt: true },
        },
      },
    });
    if (existing?.externalOrderInvoiceRequest) {
      const touchedOrderIds = await resolveInvoiceTouchedOrderIds(existing.externalOrderInvoiceRequest.id);
      return {
        invoice: {
          id: existing.externalOrderInvoiceRequest.id,
          status: "ISSUED",
          actualInvoiceNo: existing.externalOrderInvoiceRequest.actualInvoiceNo,
          actualIssuedAt: existing.externalOrderInvoiceRequest.actualIssuedAt
            ? existing.externalOrderInvoiceRequest.actualIssuedAt.toISOString().slice(0, 10)
            : null,
        },
        document: {
          id: existing.id,
          fileName: existing.fileName,
          fileUrl: existing.fileUrl,
          mimeType: existing.mimeType,
          fileSize: existing.fileSize,
          sha256: existing.sha256 || params.stagedFile.sha256,
        },
        touchedOrderIds,
      };
    }
  }

  const pre = await validateRegisterIssuedInvoicePreconditions({
    actor: params.actor,
    invoiceRequestId: params.invoiceRequestId,
    stagedFile: params.stagedFile,
    expectedSha256: params.expectedSha256,
    expectedStagingVersion: params.expectedStagingVersion,
    actualInvoiceNo: params.actualInvoiceNo,
    actualIssuedAt: params.actualIssuedAt,
    options,
  });

  const buffer = await verifyStagingFileIntegrity({
    staging: params.stagedFile,
    expectedSha256: params.expectedSha256 ?? params.stagedFile.sha256,
    expectedVersion: params.expectedStagingVersion ?? params.stagedFile.version,
  });

  const promoted = await promoteStagingBufferToFormal({
    buffer,
    sha256: params.stagedFile.sha256,
    originalFileName: params.stagedFile.originalFileName,
    invoiceRequestId: params.invoiceRequestId,
    proposalId: params.sourceAgentProposalId ?? null,
  });

  let invoiceId = params.invoiceRequestId;
  const expectedSha256 = params.expectedSha256 ?? params.stagedFile.sha256;
  const expectedVersion = params.expectedStagingVersion ?? params.stagedFile.version;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Phase E：Agent channel 技术负责人最终写事务内复核（防 TOCTOU）。
      if (params.agentOwnerRecheck && params.agentOwnerRecheck.orderIds.length > 0) {
        const { assertAgentCanWriteOrders } = await import(
          "@/lib/orders/application/technical-owner-gate"
        );
        await assertAgentCanWriteOrders(
          params.agentOwnerRecheck.actor as import("@/lib/application/actor").BusinessActor,
          params.agentOwnerRecheck.invocation as import("@/lib/application/actor").InvocationContext,
          params.agentOwnerRecheck.orderIds,
          { tx },
        );
      }

      // 1) Atomically claim staging — only one registration may win.
      const claimedStaging = await tx.agentInvoiceStagingFile.updateMany({
        where: {
          id: params.stagedFile.id,
          createdById: params.actor.userId,
          version: expectedVersion,
          sha256: expectedSha256,
          status: { in: ["UPLOADED", "ANALYZED"] },
        },
        data: {
          status: "REGISTERED",
          registeredInvoiceRequestId: params.invoiceRequestId,
        },
      });
      if (claimedStaging.count !== 1) {
        throw new RegisterIssuedInvoiceError(
          "INVOICE_STAGING_CHANGED",
          "staging 已被使用或已变化，无法登记",
          409,
        );
      }

      // 2) Re-check invoice state inside the same transaction.
      const fresh = await tx.externalOrderInvoiceRequest.findUnique({
        where: { id: params.invoiceRequestId },
        select: {
          id: true,
          status: true,
          adjustmentsAsOriginal: { select: { kind: true } },
          documents: {
            where: { kind: "ACTUAL_INVOICE" },
            select: { id: true },
          },
        },
      });
      if (!fresh) {
        throw new RegisterIssuedInvoiceError("INVOICE_REQUEST_NOT_FOUND", "目标申请不存在", 404);
      }
      if (fresh.adjustmentsAsOriginal.some((a) => a.kind === "RED")) {
        throw new RegisterIssuedInvoiceError("INVOICE_RED_ADJUSTED", "已冲红的发票不能登记附件", 400);
      }
      if (fresh.adjustmentsAsOriginal.some((a) => a.kind === "REISSUE")) {
        throw new RegisterIssuedInvoiceError("INVOICE_STATE_CHANGED", "已重开的原发票不能再登记附件", 409);
      }
      if (fresh.documents.length > 0) {
        throw new RegisterIssuedInvoiceError("INVOICE_STATE_CHANGED", "该申请已有真实发票附件", 409);
      }

      const allowIssuedRecovery =
        Boolean(options.allowIssuedWithoutDocument)
        && fresh.status === "ISSUED"
        && fresh.documents.length === 0;

      // 3) Re-check duplicates and take atomic claim rows.
      if (pre.actualInvoiceNo) {
        const numberConflict = await tx.externalOrderInvoiceRequest.findFirst({
          where: {
            id: { not: params.invoiceRequestId },
            actualInvoiceNo: pre.actualInvoiceNo,
            status: { not: "CANCELLED" },
            adjustmentsAsOriginal: { none: { kind: { in: [...INACTIVE_INVOICE_ADJUSTMENT_KINDS] } } },
          },
          select: { id: true },
        });
        if (numberConflict) {
          throw new RegisterIssuedInvoiceError("INVOICE_NUMBER_DUPLICATE", "发票号已在其他有效发票中登记", 409);
        }
        try {
          await claimIssuedInvoiceNumber(tx, {
            actualInvoiceNo: pre.actualInvoiceNo,
            invoiceRequestId: params.invoiceRequestId,
          });
        } catch (err) {
          if (err instanceof Error && (err as Error & { code?: string }).code === "INVOICE_NUMBER_DUPLICATE") {
            throw new RegisterIssuedInvoiceError("INVOICE_NUMBER_DUPLICATE", "发票号已在其他有效发票中登记", 409);
          }
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            throw new RegisterIssuedInvoiceError("INVOICE_NUMBER_DUPLICATE", "发票号已在其他有效发票中登记", 409);
          }
          throw err;
        }
      }

      const hashConflict = await tx.invoiceDocument.findFirst({
        where: {
          sha256: expectedSha256,
          kind: "ACTUAL_INVOICE",
          externalOrderInvoiceRequestId: { not: params.invoiceRequestId },
          externalOrderInvoiceRequest: {
            status: { not: "CANCELLED" },
            adjustmentsAsOriginal: { none: { kind: { in: [...INACTIVE_INVOICE_ADJUSTMENT_KINDS] } } },
          },
        },
        select: { id: true },
      });
      if (hashConflict) {
        throw new RegisterIssuedInvoiceError("INVOICE_FILE_DUPLICATE", "该文件已登记到其他有效发票", 409);
      }
      const sameRequestHash = await tx.invoiceDocument.findFirst({
        where: {
          externalOrderInvoiceRequestId: params.invoiceRequestId,
          sha256: expectedSha256,
          kind: "ACTUAL_INVOICE",
        },
        select: { id: true },
      });
      if (sameRequestHash) {
        throw new RegisterIssuedInvoiceError("INVOICE_FILE_DUPLICATE", "该文件已登记到本申请", 409);
      }

      // 4) Conditional status update — DRAFT may jump directly to ISSUED in-page.
      if (allowIssuedRecovery) {
        const recovered = await tx.externalOrderInvoiceRequest.updateMany({
          where: { id: params.invoiceRequestId, status: "ISSUED" },
          data: {
            ...(pre.actualInvoiceNo ? { actualInvoiceNo: pre.actualInvoiceNo } : {}),
            ...(pre.actualIssuedAt ? { actualIssuedAt: pre.actualIssuedAt } : {}),
          },
        });
        if (recovered.count !== 1) {
          throw new RegisterIssuedInvoiceError("INVOICE_STATE_CHANGED", "发票状态已变化，无法登记", 409);
        }
      } else {
        const allowedStatuses = options.allowDraftPromotion
          ? (["REQUESTED", "DRAFT"] as const)
          : (["REQUESTED"] as const);
        const updated = await tx.externalOrderInvoiceRequest.updateMany({
          where: {
            id: params.invoiceRequestId,
            status: { in: [...allowedStatuses] },
          },
          data: {
            status: "ISSUED",
            ...(pre.actualInvoiceNo ? { actualInvoiceNo: pre.actualInvoiceNo } : {}),
            ...(pre.actualIssuedAt ? { actualIssuedAt: pre.actualIssuedAt } : {}),
          },
        });
        if (updated.count !== 1) {
          throw new RegisterIssuedInvoiceError(
            "INVOICE_STATE_CHANGED",
            "发票状态已变化，无法登记",
            409,
          );
        }
      }

      let document;
      try {
        document = await tx.invoiceDocument.create({
          data: {
            externalOrderInvoiceRequestId: params.invoiceRequestId,
            kind: "ACTUAL_INVOICE",
            fileName: params.stagedFile.originalFileName,
            fileUrl: promoted.fileUrl,
            fileSize: params.stagedFile.fileSize,
            mimeType: params.stagedFile.mimeType,
            sha256: expectedSha256,
            sourceAgentProposalId: params.sourceAgentProposalId || null,
            uploadedById: params.actor.userId,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new RegisterIssuedInvoiceError(
            "INVOICE_REGISTRATION_CONFLICT",
            "并发或唯一约束冲突，请刷新后重试",
            409,
          );
        }
        throw err;
      }

      try {
        await claimIssuedInvoiceFileHash(tx, {
          sha256: expectedSha256,
          invoiceRequestId: params.invoiceRequestId,
          documentId: document.id,
        });
      } catch (err) {
        if (err instanceof Error && (err as Error & { code?: string }).code === "INVOICE_FILE_DUPLICATE") {
          throw new RegisterIssuedInvoiceError("INVOICE_FILE_DUPLICATE", "该文件已登记到其他有效发票", 409);
        }
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new RegisterIssuedInvoiceError("INVOICE_FILE_DUPLICATE", "该文件已登记到其他有效发票", 409);
        }
        throw err;
      }

      await tx.agentInvoiceStagingFile.update({
        where: { id: params.stagedFile.id },
        data: { registeredDocumentId: document.id },
      });

      const invoice = await tx.externalOrderInvoiceRequest.findUnique({
        where: { id: params.invoiceRequestId },
        select: {
          id: true,
          status: true,
          actualInvoiceNo: true,
          actualIssuedAt: true,
        },
      });

      return { document, invoice };
    });

    invoiceId = result.invoice?.id ?? params.invoiceRequestId;

    // Best-effort: remove staging original after successful DB commit.
    await deleteStagingFileQuietly(params.stagedFile.storageKey);

    const touchedOrderIds = await resolveInvoiceTouchedOrderIds(invoiceId);
    for (const orderId of touchedOrderIds) {
      try {
        const order = await prisma.order.findUnique({
          where: { id: orderId },
          select: { legacyExternalOrderId: true },
        });
        if (order?.legacyExternalOrderId) {
          await syncOrderInvoiceStatus(prisma, order.legacyExternalOrderId, orderId);
        }
        await syncOrderInvoiceStatus(prisma, orderId, orderId);
      } catch (err) {
        console.error(
          "[register-issued-invoice] syncOrderInvoiceStatus failed:",
          orderId,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return {
      invoice: {
        id: invoiceId,
        status: "ISSUED",
        actualInvoiceNo: result.invoice?.actualInvoiceNo ?? pre.actualInvoiceNo,
        actualIssuedAt: result.invoice?.actualIssuedAt
          ? result.invoice.actualIssuedAt.toISOString().slice(0, 10)
          : (pre.actualIssuedAt ? pre.actualIssuedAt.toISOString().slice(0, 10) : null),
      },
      document: {
        id: result.document.id,
        fileName: result.document.fileName,
        fileUrl: result.document.fileUrl,
        mimeType: result.document.mimeType,
        fileSize: result.document.fileSize,
        sha256: result.document.sha256 || expectedSha256,
      },
      touchedOrderIds,
    };
  } catch (err) {
    // DB failed after file promote: delete orphan formal file if unreferenced.
    if (promoted.createdNewFile) {
      const referenced = await prisma.invoiceDocument.count({
        where: { fileUrl: promoted.fileUrl },
      });
      if (referenced === 0) {
        await fs.unlink(promoted.absolutePath).catch(() => undefined);
      }
    }
    if (err instanceof RegisterIssuedInvoiceError || err instanceof InvoiceStagingError) {
      throw err;
    }
    throw err;
  }
}

export function mapRegisterIssuedInvoiceError(err: unknown): {
  status: number;
  body: { error: string; code?: string };
} | null {
  if (err instanceof RegisterIssuedInvoiceError || err instanceof InvoiceStagingError) {
    return {
      status: err.httpStatus,
      body: { error: err.message, code: err.code },
    };
  }
  return null;
}
