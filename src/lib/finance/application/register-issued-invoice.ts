/**
 * Canonical actor-aware register issued invoice command (T6.4).
 *
 * Shared by Web invoice-documents POST and Agent `finance.register_issued_invoice`.
 * All touched orders must be fully in actor scope before register.
 */
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import { NotFoundError } from "@/lib/application/errors";
import { canWriteFinance } from "@/lib/finance/permissions";
import { resolveInvoiceTouchedOrderIds } from "@/lib/finance/order-invoice-access";
import {
  getOwnedStagingFile,
  type InvoiceStagingError,
} from "@/lib/finance/invoice-staging";
import {
  RegisterIssuedInvoiceError,
  type RegisterIssuedInvoiceOptions,
  type RegisterIssuedInvoiceResult,
  type RegisterIssuedInvoiceStagedFile,
  registerIssuedInvoiceDocument,
  validateRegisterIssuedInvoicePreconditions,
} from "@/lib/finance/register-issued-invoice";
import { assertFullOrderScopeForActor } from "@/lib/finance/application/invoice-order-scope";

export type RegisterIssuedInvoiceChannelPolicy = RegisterIssuedInvoiceOptions;

export const AGENT_REGISTER_ISSUED_INVOICE_POLICY: RegisterIssuedInvoiceChannelPolicy = {
  allowUserRole: false,
  allowDraftPromotion: false,
  allowIssuedWithoutDocument: false,
  requireActualInvoiceNo: true,
};

export const WEB_REGISTER_ISSUED_INVOICE_POLICY: RegisterIssuedInvoiceChannelPolicy = {
  allowUserRole: true,
  allowDraftPromotion: true,
  allowIssuedWithoutDocument: true,
  requireActualInvoiceNo: false,
};

export type RegisterIssuedInvoiceByStagingIdInput = {
  stagingFileId: string;
  invoiceRequestId: string;
  actualInvoiceNo?: string | null;
  actualIssuedAt?: string | null;
  expectedSha256: string;
  expectedStagingVersion: number;
};

export type RegisterIssuedInvoiceWithStagedFileInput = {
  invoiceRequestId: string;
  stagedFile: RegisterIssuedInvoiceStagedFile;
  actualInvoiceNo?: string | null;
  actualIssuedAt?: string | null;
  expectedSha256?: string;
  expectedStagingVersion?: number;
};

export type RegisterIssuedInvoicePreview = {
  title: string;
  summary: string;
  target: { type: "order_invoice_request"; id: string };
  proposalInput: Record<string, unknown>;
};

function policyToOptions(policy: RegisterIssuedInvoiceChannelPolicy): RegisterIssuedInvoiceOptions {
  return { ...policy };
}

function assertRegisterIssuedInvoiceCapability(
  actor: BusinessActor,
  policy: RegisterIssuedInvoiceChannelPolicy,
): void {
  if (!canWriteFinance(actor.role)) {
    throw new RegisterIssuedInvoiceError("INVOICE_REQUEST_FORBIDDEN", "无权登记发票", 403);
  }
  if (!policy.allowUserRole && actor.role !== "ADMIN") {
    throw new RegisterIssuedInvoiceError("INVOICE_REQUEST_FORBIDDEN", "仅管理员可通过 Agent 登记发票", 403);
  }
}

async function assertRegisterIssuedInvoiceOrderScope(
  actor: BusinessActor,
  invoiceRequestId: string,
): Promise<void> {
  const touchedOrderIds = await resolveInvoiceTouchedOrderIds(invoiceRequestId);
  try {
    await assertFullOrderScopeForActor(actor, touchedOrderIds);
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new RegisterIssuedInvoiceError("INVOICE_REQUEST_NOT_FOUND", err.message, 404);
    }
    throw err;
  }
}

function buildPreviewFromPreconditions(
  input: RegisterIssuedInvoiceByStagingIdInput,
  staging: RegisterIssuedInvoiceStagedFile,
  pre: Awaited<ReturnType<typeof validateRegisterIssuedInvoicePreconditions>>,
): RegisterIssuedInvoicePreview {
  const coveredOrders = [
    ...(pre.invoice.order
      ? [{
          orderId: pre.invoice.order.id,
          orderNo: pre.invoice.order.orderNo,
          title: pre.invoice.order.title,
        }]
      : []),
    ...pre.invoice.orderCoverage
      .filter((c) => c.order && c.order.id !== pre.invoice.order?.id)
      .map((c) => ({
        orderId: c.order!.id,
        orderNo: c.order!.orderNo,
        title: c.order!.title,
      })),
  ];
  const orderLabels = coveredOrders.map((o) => `${o.orderNo} · ${o.title}`);
  const amountYuan = (pre.invoice.totalAmount / 100).toFixed(2);
  const invoiceNoLabel = pre.actualInvoiceNo || "未编号";

  return {
    title: `登记已开发票：NO. ${invoiceNoLabel}`,
    summary:
      `登记已开发票：NO. ${invoiceNoLabel}\n` +
      `文件 ${staging.originalFileName}，将关联申请 ${input.invoiceRequestId.slice(-8)}；` +
      `购方${pre.invoice.buyerOrganizationName}，金额 ¥${amountYuan}，确认后状态变为“已开具”。`,
    target: { type: "order_invoice_request", id: input.invoiceRequestId },
    proposalInput: {
      stagingFileId: staging.id,
      invoiceRequestId: input.invoiceRequestId,
      actualInvoiceNo: pre.actualInvoiceNo,
      actualIssuedAt: input.actualIssuedAt || null,
      expectedSha256: staging.sha256,
      expectedStagingVersion: staging.version,
      fileName: staging.originalFileName,
      mimeType: staging.mimeType,
      fileSize: staging.fileSize,
      buyerOrganizationName: pre.invoice.buyerOrganizationName,
      invoiceType: pre.invoice.invoiceType,
      totalAmountCents: pre.invoice.totalAmount,
      orderLabels,
      coveredOrders,
      previewUrl: `/api/agent/invoice-staging/${staging.id}/content`,
    },
  };
}

export async function previewRegisterIssuedInvoiceForActor(
  actor: BusinessActor,
  input: RegisterIssuedInvoiceByStagingIdInput,
  policy: RegisterIssuedInvoiceChannelPolicy = AGENT_REGISTER_ISSUED_INVOICE_POLICY,
): Promise<RegisterIssuedInvoicePreview> {
  assertRegisterIssuedInvoiceCapability(actor, policy);
  await assertRegisterIssuedInvoiceOrderScope(actor, input.invoiceRequestId);

  const staging = await getOwnedStagingFile({
    stagingFileId: input.stagingFileId,
    userId: actor.userId,
  });

  const pre = await validateRegisterIssuedInvoicePreconditions({
    actor,
    invoiceRequestId: input.invoiceRequestId,
    stagedFile: staging,
    expectedSha256: input.expectedSha256,
    expectedStagingVersion: input.expectedStagingVersion,
    actualInvoiceNo: input.actualInvoiceNo,
    actualIssuedAt: input.actualIssuedAt,
    options: {
      ...policyToOptions(policy),
      skipLegacyAccessCheck: true,
    },
  });

  return buildPreviewFromPreconditions(input, staging, pre);
}

export async function registerIssuedInvoiceForActor(
  actor: BusinessActor,
  input: RegisterIssuedInvoiceWithStagedFileInput | RegisterIssuedInvoiceByStagingIdInput,
  opts: {
    policy?: RegisterIssuedInvoiceChannelPolicy;
    invocation?: InvocationContext;
  } = {},
): Promise<RegisterIssuedInvoiceResult> {
  const policy = opts.policy ?? AGENT_REGISTER_ISSUED_INVOICE_POLICY;
  assertRegisterIssuedInvoiceCapability(actor, policy);
  await assertRegisterIssuedInvoiceOrderScope(actor, input.invoiceRequestId);

  // Phase E（P0-3）：Agent 发票登记——early pre-check + 最终写事务内复核。
  let agentTouchedOrderIds: string[] = [];
  if (opts.invocation?.channel === "agent") {
    agentTouchedOrderIds = await resolveInvoiceTouchedOrderIds(input.invoiceRequestId);
    if (agentTouchedOrderIds.length > 0) {
      const { assertAgentCanWriteOrders } = await import("@/lib/orders/application/technical-owner-gate");
      await assertAgentCanWriteOrders(actor, opts.invocation, agentTouchedOrderIds);
    }
  }

  let stagedFile: RegisterIssuedInvoiceStagedFile;
  let expectedSha256: string;
  let expectedStagingVersion: number;

  if ("stagedFile" in input) {
    stagedFile = input.stagedFile;
    expectedSha256 = input.expectedSha256 ?? input.stagedFile.sha256;
    expectedStagingVersion = input.expectedStagingVersion ?? input.stagedFile.version;
  } else {
    stagedFile = await getOwnedStagingFile({
      stagingFileId: input.stagingFileId,
      userId: actor.userId,
    });
    expectedSha256 = input.expectedSha256;
    expectedStagingVersion = input.expectedStagingVersion;
  }

  return registerIssuedInvoiceDocument({
    actor,
    invoiceRequestId: input.invoiceRequestId,
    stagedFile,
    actualInvoiceNo: input.actualInvoiceNo,
    actualIssuedAt: input.actualIssuedAt,
    expectedSha256,
    expectedStagingVersion,
    sourceAgentProposalId: opts.invocation?.proposalId ?? null,
    options: {
      ...policyToOptions(policy),
      skipLegacyAccessCheck: true,
    },
    agentOwnerRecheck:
      opts.invocation?.channel === "agent"
        ? { actor, invocation: opts.invocation, orderIds: agentTouchedOrderIds }
        : undefined,
  });
}

export type { RegisterIssuedInvoiceResult, RegisterIssuedInvoiceStagedFile, InvoiceStagingError };
