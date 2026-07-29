/**
 * T8.2b - 合同生成最终 command（canonical application service）。
 *
 * Shared by POST /api/contracts/generate（Web，intent-less 直生成）与 Agent
 * contracts.generate execute（intent-based：claim/resume/幂等）。
 *
 * confirm 时不信 proposal 内容，重新加载并检查：
 * - actor 当前角色（canGenerateContract）；
 * - 全部订单存在/未删除/全在 actor scope（loadOrdersForContractAction）；
 * - 同一结构化买方（assertSameBuyer -> ValidationError）；
 * - 模板可用且未归档；seller billing profile 存在且未归档；
 * - intent 路径：ownership/状态/TTL/digest 复核（loadOwnedActiveIntentForActor
 *   + assertIntentInputUnchanged）；
 * - intent-less 路径（Web）：直接 generateContract。
 *
 * 状态流：PENDING intent -> CAS claim PROCESSING -> PENDING_FILE ContractDocument
 * -> 文件成功 -> GENERATED。GENERATED 幂等快路径跨 proposal 安全。
 *
 * generate.ts 保持为确定性领域实现（contractNo HT-YYYYMMDD-<B36>、P2002 兜底、
 * fencing 不变），由本 command 统一调用。
 */
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import { ApplicationError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/application/errors";
import { prisma } from "@/lib/prisma";
import { canGenerateContract } from "@/lib/contracts/permissions";
import { generateContract, type GenerateInput } from "@/lib/contracts/generate";
import { resumePendingFileContractById } from "@/lib/contracts/application/contract-file-promotion";
import { claimGenerationIntent } from "@/lib/contracts/generation-intent";
import {
  loadOrdersForContractAction,
  assertSameBuyerChecked,
  buyerOverridesToRecord,
  buyerOverridesToGenerateFields,
  type BuyerOverridesInput,
} from "@/lib/contracts/application/prepare-contract-draft";
import {
  buildNormalizedContractInput,
  assertIntentInputUnchanged,
  loadOwnedActiveIntentForActor,
} from "@/lib/contracts/application/contract-generation-intent";

export type GenerateCommandInput = {
  generationIntentId?: string;
  orderIds: string[];
  templateId: string;
  sellerProfileId: string;
  buyerOverrides?: BuyerOverridesInput;
  remark?: string;
};

export type GenerateContractResult = {
  contractId: string;
  contractNo: string;
  /** 新生成的合同有 docxBuffer；幂等快路径返回已有合同的 null（Agent 不需要 buffer）。 */
  docxBuffer: Buffer | null;
  coveredOrderCount: number;
  totalAmountCents: number;
};

export type GenerateContractOpts = {
  invocation?: InvocationContext;
};

/** generateContract() 抛出的纯 Error -> 结构化 ApplicationError。 */
function mapGenerateContractError(err: unknown): never {
  if (err instanceof ApplicationError) {
    throw err;
  }
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.startsWith("CROSS_BUYER_ORDERS")) {
      throw new ValidationError(msg);
    }
    if (msg.startsWith("SCOPE_REVOKED")) {
      throw new ForbiddenError(msg);
    }
    if (msg.startsWith("FACT_DIGEST_MISMATCH")) {
      throw new ConflictError(msg);
    }
    if (msg.startsWith("INTENT_FENCING_FAILED") || msg.includes("归档失败")) {
      throw new ConflictError(msg);
    }
    if (/不存在|已删除|已归档/.test(msg)) {
      throw new ValidationError(msg);
    }
    throw new ApplicationError(msg, 500, "CONTRACT_GENERATE_FAILED");
  }
  throw err;
}

/**
 * 单一生成入口：包装 domain generateContract() + 错误翻译。
 * 消除原 execute 内两处逐字重复的 generateContract 调用块。
 */
async function runGenerate(
  params: GenerateInput,
  userId: string,
  role: string,
  /** 部门归属；未提供时下游从 DB 实时解析（fail-closed）。 */
  department?: string,
): Promise<{ contractId: string; contractNo: string; docxBuffer: Buffer }> {
  try {
    const result = await generateContract(params, userId, role, department);
    return { contractId: result.contractId, contractNo: result.contractNo, docxBuffer: result.docxBuffer };
  } catch (err) {
    mapGenerateContractError(err);
  }
}

export async function generateContractForActor(
  actor: BusinessActor,
  input: GenerateCommandInput,
  opts: GenerateContractOpts = {},
): Promise<GenerateContractResult> {
  if (!canGenerateContract(actor.role)) {
    throw new ForbiddenError();
  }

  // Agent 路径必须有 proposalId（intent-based 确认流）
  const proposalId = opts.invocation?.proposalId ?? null;
  if (opts.invocation?.channel === "agent" && !proposalId) {
    throw new ValidationError("缺少 proposalId，无法执行合同生成");
  }

  const orders = await loadOrdersForContractAction(input.orderIds, actor);
  assertSameBuyerChecked(orders);

  // Phase E（P0-3）：Agent channel 合同生成——事务外 early pre-check（快速失败 UX）；
  // 权威复核在 generateContract 最终写事务内（agentOwnerRecheck，防 TOCTOU）。
  if (opts.invocation?.channel === "agent") {
    const { assertAgentCanWriteOrders } = await import("@/lib/orders/application/technical-owner-gate");
    await assertAgentCanWriteOrders(actor, opts.invocation, input.orderIds);
  }

  // 重新校验模板与卖方（不信 proposal 冻结内容）
  const template = await prisma.contractTemplate.findFirst({
    where: { id: input.templateId, archived: false },
  });
  if (!template) throw new NotFoundError("模板不存在或已归档");

  const sellerProfile = await prisma.billingProfile.findUnique({ where: { id: input.sellerProfileId } });
  if (!sellerProfile || sellerProfile.archived) {
    throw new NotFoundError("开票主体不存在或已归档");
  }

  const totalAmountCents = orders.reduce((sum, order) => sum + (order.totalAmount || 0), 0);
  const agentOwnerRecheck =
    opts.invocation?.channel === "agent"
      ? { actor, invocation: opts.invocation }
      : undefined;
  const baseGenerateInput: Omit<GenerateInput, "generationIntentId" | "processingProposalId"> = {
    orderIds: input.orderIds,
    templateId: input.templateId,
    sellerProfileId: input.sellerProfileId,
    ...buyerOverridesToGenerateFields(input.buyerOverrides ?? {}),
    remark: input.remark,
    agentOwnerRecheck,
  };

  // ── intent-less 路径（Web 手动生成，C5：double-submit 可产生多份，幂等保证是 proposal-scoped） ──
  if (!input.generationIntentId) {
    // Fail-closed（设计 §6.1）：actor.department 缺失时留 undefined，由下游从 DB 实时解析；
    // 不再兜底 FIELD_SALES。
    const result = await runGenerate(baseGenerateInput, actor.userId, actor.role, actor.department);
    return {
      contractId: result.contractId,
      contractNo: result.contractNo,
      docxBuffer: result.docxBuffer,
      coveredOrderCount: orders.length,
      totalAmountCents,
    };
  }

  // ── intent-based 路径（Agent 确认） ──
  const intent = await loadOwnedActiveIntentForActor(actor, input.generationIntentId);
  const normalizedInput = buildNormalizedContractInput({
    orderIds: input.orderIds,
    templateId: input.templateId,
    sellerProfileId: input.sellerProfileId,
    buyerOverrides: buyerOverridesToRecord(input.buyerOverrides ?? {}),
    remark: input.remark,
  });
  assertIntentInputUnchanged(intent, normalizedInput);

  let contractId: string;
  let contractNo: string;
  let idempotentReplay = false;

  if (intent.status === "GENERATED") {
    // 幂等快路径：跨 proposal 安全（超时重试也不会重复生成）
    if (!intent.contract) {
      throw new ConflictError("生成意图已完成但找不到关联合同，请联系管理员");
    }
    contractId = intent.contract.id;
    contractNo = intent.contract.contractNo;
    idempotentReplay = true;
  } else {
    const claim = await claimGenerationIntent({
      intentId: input.generationIntentId,
      ownerUserId: actor.userId,
      currentProposalId: proposalId!,
    });

    if (claim.status === "already_generated") {
      contractId = claim.contractId;
      contractNo = claim.contractNo;
      idempotentReplay = true;
    } else if (claim.status === "processing_by_other") {
      throw new ConflictError("生成意图正在被其他请求处理，请稍后重试");
    } else if (claim.status === "claim_conflict") {
      throw new ConflictError("生成意图刚被其他请求抢先处理，请重试");
    } else if (claim.status === "not_found" || claim.status === "expired" || claim.status === "forbidden") {
      throw new ConflictError(`生成意图不可用（${claim.status}），请重新调用 contracts.prepare_draft`);
    } else {
      // claimed：可能是全新 claim，也可能是接管旧 PROCESSING（崩溃恢复）。
      const existingContract = await prisma.contractDocument.findUnique({
        where: { generationIntentId: input.generationIntentId },
      });

      if (existingContract && existingContract.status === "PENDING_FILE") {
        const resumed = await resumePendingFileContractById(existingContract.id);
        if (resumed.outcome === "resumed") {
          contractId = existingContract.id;
          contractNo = resumed.contractNo ?? existingContract.contractNo;
          idempotentReplay = true;
        } else if (resumed.outcome === "skipped") {
          throw new ConflictError("合同恢复未完成（可重试），请稍后再确认一次");
        } else {
          // cleaned：孤儿记录已清理，回到全新生成
          const result = await runGenerate(
            { ...baseGenerateInput, generationIntentId: input.generationIntentId, processingProposalId: proposalId ?? undefined },
            actor.userId,
            actor.role,
            actor.department,
          );
          contractId = result.contractId;
          contractNo = result.contractNo;
        }
      } else if (existingContract) {
        // 已是 GENERATED（罕见竞态：claim 刚成功但合同已完成）
        contractId = existingContract.id;
        contractNo = existingContract.contractNo;
        idempotentReplay = true;
      } else {
        const result = await runGenerate(
          { ...baseGenerateInput, generationIntentId: input.generationIntentId, processingProposalId: proposalId ?? undefined },
          actor.userId,
          actor.role,
          actor.department,
        );
        contractId = result.contractId;
        contractNo = result.contractNo;
      }
    }
  }

  // 幂等回放：从既有合同快照构造 totalAmount/coverageCount（不用当前订单金额）
  if (idempotentReplay) {
    const [existingDoc, coverageCount] = await Promise.all([
      prisma.contractDocument.findUnique({
        where: { id: contractId },
        select: { totalAmount: true },
      }),
      prisma.orderContractCoverage.count({ where: { contractId } }),
    ]);
    return {
      contractId,
      contractNo,
      docxBuffer: null,
      coveredOrderCount: coverageCount,
      totalAmountCents: existingDoc?.totalAmount ?? 0,
    };
  }

  // 全新生成：用当前订单金额（与刚生成的合同一致）
  return {
    contractId,
    contractNo,
    docxBuffer: null,
    coveredOrderCount: orders.length,
    totalAmountCents,
  };
}
