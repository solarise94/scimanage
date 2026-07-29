/**
 * T8.2a - 合同生成意图（generation intent）application 层 helper。
 *
 * 将 contracts.ts 内重复 3 次的 NormalizedContractInput 组装与 digest fence
 * 收敛到此处；domain helper（generation-intent.ts）不动。
 * - buildNormalizedContractInput：组装规范化输入（orderIds 保持顺序，buyerOverrides
 *   已由调用方用 buyerOverridesToRecord 剔除空值；generation-intent 内部再排序 key）。
 * - assertIntentInputUnchanged：confirm 时比对 digest，变化 -> ConflictError。
 * - loadOwnedActiveIntentForActor：加载归属当前 actor 的活跃 intent，缺失 -> NotFoundError。
 */
import type { BusinessActor } from "@/lib/application/actor";
import { ConflictError, NotFoundError } from "@/lib/application/errors";
import {
  computeInputDigest,
  loadOwnedIntent,
  type NormalizedContractInput,
} from "@/lib/contracts/generation-intent";

export type { NormalizedContractInput };

export function buildNormalizedContractInput(parts: {
  orderIds: string[];
  templateId: string;
  sellerProfileId: string;
  buyerOverrides: Record<string, string>;
  remark?: string | null;
}): NormalizedContractInput {
  return {
    orderIds: parts.orderIds,
    templateId: parts.templateId,
    sellerProfileId: parts.sellerProfileId,
    buyerOverrides: parts.buyerOverrides,
    remark: parts.remark ?? "",
  };
}

/**
 * confirm 时复核 intent 的 inputDigest 是否仍与当前 normalizedInput 一致。
 * 变化（订单/模板/卖方/买方覆盖/备注任一改动）-> ConflictError，要求重新 prepare_draft。
 */
export function assertIntentInputUnchanged(
  intent: { inputDigest: string },
  normalizedInput: NormalizedContractInput,
): void {
  if (computeInputDigest(normalizedInput) !== intent.inputDigest) {
    throw new ConflictError("INTENT_INPUT_MISMATCH：输入已变化，请重新调用 contracts.prepare_draft");
  }
}

type OwnedIntent = NonNullable<Awaited<ReturnType<typeof loadOwnedIntent>>>;

/**
 * 加载归属当前 actor 的活跃 generation intent。
 * intent 与 ownerUserId 绑定（非 proposalId），跨 proposal 重试安全。
 * 缺失/过期 -> NotFoundError（fail-closed，不泄露存在性差异）。
 */
export async function loadOwnedActiveIntentForActor(
  actor: BusinessActor,
  intentId: string,
): Promise<OwnedIntent> {
  const intent = await loadOwnedIntent({ intentId, ownerUserId: actor.userId });
  if (!intent) {
    throw new NotFoundError("生成意图不存在或已过期");
  }
  return intent;
}
