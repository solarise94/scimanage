/**
 * T8.3 - 合同文件提升（PENDING_FILE -> GENERATED）application 层入口。
 *
 * 包装 generate.ts 的确定性恢复逻辑（resumePendingFileContract），为
 * generate command（T8.2b）与崩溃恢复（T8.3 recover-contract-file）提供
 * 统一的 application 层调用点。generate.ts 保持为确定性领域实现。
 *
 * 单合同恢复幂等：临时/staging 文件存在则推进 rename -> GENERATED；
 * 最终文件已就位 -> 直接标记 GENERATED；均不存在 -> 清理 DB+文件；
 * 部分推进 -> 保留 PENDING_FILE 返回 skipped，下次重试。
 */
export type { ResumeContractOutcome } from "@/lib/contracts/generate";
import { resumePendingFileContract } from "@/lib/contracts/generate";
import type { ResumeContractOutcome } from "@/lib/contracts/generate";

/**
 * 恢复单个 PENDING_FILE 合同（幂等，无 TTL 限制）。
 * 合同不存在时返回 skipped（无副作用）。
 */
export async function resumePendingFileContractById(
  contractId: string,
): Promise<ResumeContractOutcome> {
  return resumePendingFileContract(contractId);
}
