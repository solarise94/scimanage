import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * 合同生成 Agent 幂等设计（docs/agent-bankflow-contract-design-2026-07-23.md §2.2）。
 *
 * 生命周期：
 *   prepareOrReuseGenerationIntent → PENDING（占用 activeDigestKey）
 *   claimGenerationIntent          → PENDING → PROCESSING（绑定 processingProposalId）
 *   markIntentGenerated            → PROCESSING → GENERATED（清空 activeDigestKey + processingProposalId）
 *
 * proposalId 不是稳定幂等键（超时回收后会换新 proposal 重试），因此用持久化的
 * ContractGenerationIntent 记录承载"一次生成意图"，与 proposal 生命周期解耦。
 */

/** intent 24h TTL。 */
const INTENT_TTL_MS = 24 * 60 * 60 * 1000;

export type NormalizedContractInput = {
  /** 保持用户指定顺序（首项即 primaryOrderId），不排序。 */
  orderIds: string[];
  /** 已解析默认模板后的模板 ID。 */
  templateId: string;
  /** 已解析默认开票主体后的 BillingProfile ID。 */
  sellerProfileId: string;
  /** 买方覆盖字段：key 排序，空值剔除。 */
  buyerOverrides: Record<string, string>;
  remark: string;
};

/** 规范化 buyerOverrides：key 排序 + 剔除空值。 */
function normalizeBuyerOverrides(overrides: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(overrides).sort()) {
    const value = overrides[key];
    if (value === undefined || value === null || value === "") continue;
    result[key] = value;
  }
  return result;
}

/**
 * 规范化输入的确定性 JSON 序列化。
 * 字段顺序固定（不依赖调用方传入的对象 key 顺序），buyerOverrides 内部 key 已排序。
 */
export function canonicalizeNormalizedInput(input: NormalizedContractInput): string {
  const canonical = {
    orderIds: input.orderIds,
    templateId: input.templateId,
    sellerProfileId: input.sellerProfileId,
    buyerOverrides: normalizeBuyerOverrides(input.buyerOverrides ?? {}),
    remark: input.remark ?? "",
  };
  return JSON.stringify(canonical);
}

/** sha256(canonicalJSON)，仅用于同 digest 复用判断，不作为幂等键本身。 */
export function computeInputDigest(input: NormalizedContractInput): string {
  return createHash("sha256").update(canonicalizeNormalizedInput(input)).digest("hex");
}

function buildActiveDigestKey(ownerUserId: string, inputDigest: string): string {
  return `${ownerUserId}::${inputDigest}`;
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "P2002";
}

/**
 * 创建或复用 generation intent（并发安全）。
 *
 * - 同 owner + 同 digest + status ∈ {PENDING, PROCESSING} + 未过期 → 复用。
 * - 找到但已过期（TTL 已到但状态尚未惰性翻转）→ 就地标记 EXPIRED 并释放 activeDigestKey，
 *   避免随后创建新 intent 时撞 activeDigestKey 唯一约束。
 * - 否则创建新 intent；若 P2002（activeDigestKey 唯一约束冲突，说明并发 prepare 已有赢家）
 *   → 读取赢家并复用。
 */
export async function prepareOrReuseGenerationIntent(opts: {
  ownerUserId: string;
  normalizedInput: NormalizedContractInput;
}): Promise<{ generationIntentId: string; inputDigest: string; reused: boolean }> {
  const inputDigest = computeInputDigest(opts.normalizedInput);
  const now = new Date();

  const activeCandidate = await prisma.contractGenerationIntent.findFirst({
    where: {
      ownerUserId: opts.ownerUserId,
      inputDigest,
      status: { in: ["PENDING", "PROCESSING"] },
    },
    orderBy: { createdAt: "desc" },
  });

  if (activeCandidate) {
    if (activeCandidate.expiresAt.getTime() > now.getTime()) {
      return { generationIntentId: activeCandidate.id, inputDigest, reused: true };
    }
    // 惰性过期：TTL 已到但尚未被清理，就地翻转并释放 activeDigestKey。
    // where 带上原 status 做轻量 CAS，避免覆盖并发中的合法状态变化。
    await prisma.contractGenerationIntent.updateMany({
      where: { id: activeCandidate.id, status: activeCandidate.status },
      data: { status: "EXPIRED", activeDigestKey: null, processingProposalId: null },
    });
  }

  const activeDigestKey = buildActiveDigestKey(opts.ownerUserId, inputDigest);
  const expiresAt = new Date(now.getTime() + INTENT_TTL_MS);

  try {
    const created = await prisma.contractGenerationIntent.create({
      data: {
        ownerUserId: opts.ownerUserId,
        inputDigest,
        normalizedInputJson: canonicalizeNormalizedInput(opts.normalizedInput),
        activeDigestKey,
        status: "PENDING",
        expiresAt,
      },
    });
    return { generationIntentId: created.id, inputDigest, reused: false };
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      // 并发 prepare 已有赢家：读取该活跃 intent 并复用。
      const winner = await prisma.contractGenerationIntent.findUnique({
        where: { activeDigestKey },
      });
      if (winner) {
        return { generationIntentId: winner.id, inputDigest, reused: true };
      }
    }
    throw err;
  }
}

export type ClaimGenerationIntentResult =
  | { status: "claimed" }
  | { status: "already_generated"; contractId: string; contractNo: string }
  | { status: "processing_by_other" }
  | { status: "claim_conflict" }
  | { status: "not_found" | "expired" | "forbidden" };

/**
 * claim / 接管协议（generate execute 层调用）。
 *
 * 1. 乐观路径：直接 CAS PENDING → PROCESSING，绑定 processingProposalId。
 * 2. count=0：读取当前状态判断原因：
 *    - GENERATED → 通过 intent.contract 关系返回已有合同（幂等快路径）。
 *    - 已过期 → expired。
 *    - PROCESSING：
 *      - processingProposalId 等于当前 proposal（同 proposal 重试 claim）→ 视为已 claim。
 *      - 旧 proposal 仍 PROCESSING → processing_by_other（旧 worker 可能仍在运行）。
 *      - 旧 proposal 已终态（FAILED/CONFIRMED/REJECTED）或不存在 → CAS 重新绑定后 claimed。
 *    - PENDING → claim_conflict（另一个请求刚 claim 成功）。
 */
export async function claimGenerationIntent(opts: {
  intentId: string;
  ownerUserId: string;
  currentProposalId: string;
}): Promise<ClaimGenerationIntentResult> {
  const claimed = await prisma.contractGenerationIntent.updateMany({
    where: {
      id: opts.intentId,
      ownerUserId: opts.ownerUserId,
      status: "PENDING",
      expiresAt: { gt: new Date() },
    },
    data: {
      status: "PROCESSING",
      processingProposalId: opts.currentProposalId,
      processingStartedAt: new Date(),
    },
  });
  if (claimed.count > 0) {
    return { status: "claimed" };
  }

  // count=0：读取当前状态判断原因
  const intent = await prisma.contractGenerationIntent.findUnique({ where: { id: opts.intentId } });
  if (!intent) return { status: "not_found" };
  if (intent.ownerUserId !== opts.ownerUserId) return { status: "forbidden" };

  if (intent.status === "GENERATED") {
    const contract = await prisma.contractDocument.findUnique({
      where: { generationIntentId: intent.id },
    });
    if (!contract) {
      // 数据异常：GENERATED 态必须有关联合同（intent↔合同一对一 relation）
      throw new Error(`合同生成意图数据异常：intent ${intent.id} 已 GENERATED 但找不到关联合同`);
    }
    return { status: "already_generated", contractId: contract.id, contractNo: contract.contractNo };
  }

  if (intent.status === "EXPIRED" || intent.expiresAt.getTime() < Date.now()) {
    return { status: "expired" };
  }

  if (intent.status === "PROCESSING") {
    if (intent.processingProposalId === opts.currentProposalId) {
      // 同一 proposal 重试 claim（如恢复流程内部重入）：视为已持有执行权。
      return { status: "claimed" };
    }

    const oldProposalId = intent.processingProposalId;
    if (oldProposalId) {
      const oldProposal = await prisma.agentProposal.findUnique({
        where: { id: oldProposalId },
        select: { status: true },
      });
      if (oldProposal?.status === "PROCESSING") {
        // 旧 worker 可能仍在运行，拒绝接管。
        return { status: "processing_by_other" };
      }
    }

    // 旧 proposal 已终态（FAILED/CONFIRMED/REJECTED）或不存在 → CAS 重新绑定（fencing：
    // where 校验 processingProposalId 仍等于 oldProposalId，防止并发接管冲突）。
    const reclaimed = await prisma.contractGenerationIntent.updateMany({
      where: {
        id: opts.intentId,
        status: "PROCESSING",
        processingProposalId: oldProposalId,
      },
      data: {
        processingProposalId: opts.currentProposalId,
        processingStartedAt: new Date(),
      },
    });
    return reclaimed.count > 0 ? { status: "claimed" } : { status: "processing_by_other" };
  }

  // status === PENDING：并发 claim 冲突（其他请求刚 claim 成功，state 已变化）
  return { status: "claim_conflict" };
}

/**
 * 终态：GENERATED + 清空 activeDigestKey + processingProposalId。
 * fencing：where 校验 processingProposalId = 当前 proposal，防止旧 worker（已被接管）提交错误终态。
 * 可选 tx：在外部事务内（与 ContractDocument.status 更新同一事务）调用。
 */
export async function markIntentGenerated(opts: {
  intentId: string;
  processingProposalId: string;
  tx?: Prisma.TransactionClient;
}): Promise<boolean> {
  const client = opts.tx ?? prisma;
  const result = await client.contractGenerationIntent.updateMany({
    where: {
      id: opts.intentId,
      status: "PROCESSING",
      processingProposalId: opts.processingProposalId,
    },
    data: {
      status: "GENERATED",
      activeDigestKey: null,
      processingProposalId: null,
    },
  });
  return result.count > 0;
}

/**
 * 崩溃恢复路径专用：标记 GENERATED，但不要求调用方持有 processingProposalId。
 * - 若 intent 当前有 processingProposalId → 以其自身当前值作 fencing（防止恢复期间被其他
 *   worker 并发接管；一旦不匹配则 count=0，安全放弃，不覆盖新 worker 的状态）。
 * - 若当前没有 processingProposalId（如已被清空的异常态）→ 宽松更新（仅校验 id + status）。
 * 用于 resumePendingFileContract：该函数只知道 contractId，不携带 proposal 上下文。
 */
export async function markIntentGeneratedLenient(
  intentId: string,
  tx: Prisma.TransactionClient
): Promise<boolean> {
  const intent = await tx.contractGenerationIntent.findUnique({
    where: { id: intentId },
    select: { processingProposalId: true, status: true },
  });
  if (!intent) return false;
  if (intent.status === "GENERATED") return true; // 已是终态，无需重复写

  const where: Prisma.ContractGenerationIntentWhereInput = { id: intentId };
  if (intent.processingProposalId) {
    where.processingProposalId = intent.processingProposalId;
  } else {
    where.status = intent.status;
  }

  const result = await tx.contractGenerationIntent.updateMany({
    where,
    data: {
      status: "GENERATED",
      activeDigestKey: null,
      processingProposalId: null,
    },
  });
  return result.count > 0;
}

/** 读取属于指定 owner 的 intent（含关联合同）。不属于该 owner 或不存在均返回 null。 */
export async function loadOwnedIntent(opts: { intentId: string; ownerUserId: string }) {
  const intent = await prisma.contractGenerationIntent.findUnique({
    where: { id: opts.intentId },
    include: { contract: true },
  });
  if (!intent || intent.ownerUserId !== opts.ownerUserId) return null;
  return intent;
}
