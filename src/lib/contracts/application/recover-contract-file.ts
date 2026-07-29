/**
 * T8.3 - 合同 PENDING_FILE 批量崩溃恢复 application 层入口。
 *
 * 包装 generate.ts 的 resumePendingFileContracts（批量恢复 + 孤儿目录清理），
 * 供内部恢复 route（POST /api/internal/contract-recovery/run）调用。
 *
 * 批量复用单合同恢复核心（recoverContractFiles），不复制规则；
 * 仅处理超过 RECOVERY_TTL_MS（5min）的记录，避免与正在生成的流程竞态；
 * 清理超过 ORPHAN_MIN_AGE_MS（1h）的 ct_ 前缀孤儿目录。
 *
 * 审计：记录调用者（cron token vs ADMIN）与结果计数（AgentActionLog 风格，
 * application service 可自由使用 prisma，scanner 仅约束 Agent 路径）。
 */
import { prisma } from "@/lib/prisma";
import { resumePendingFileContracts } from "@/lib/contracts/generate";

export type RecoverPendingContractFilesResult = {
  resumed: number;
  cleaned: number;
  skipped: number;
};

export type RecoverPendingContractFilesOpts = {
  /** 调用者标识（cron token / ADMIN userId），用于审计。 */
  invokedBy?: string;
};

/**
 * 批量恢复 PENDING_FILE 合同 + 清理孤儿目录。
 * 恢复成功时合同与 intent 在同一事务内标记 GENERATED（generate.ts:548-551）。
 */
export async function recoverPendingContractFiles(
  opts: RecoverPendingContractFilesOpts = {},
): Promise<RecoverPendingContractFilesResult> {
  const result = await resumePendingFileContracts();

  // 审计日志（system.contract_recovery 合成键，不阻塞恢复结果）
  try {
    await prisma.agentActionLog.create({
      data: {
        actionKey: "system.contract_recovery",
        userId: opts.invokedBy ?? "system",
        riskLevel: "safe",
        status: "completed",
        inputJson: JSON.stringify({ invokedBy: opts.invokedBy ?? "system" }),
        outputJson: JSON.stringify(result),
      },
    });
  } catch (err) {
    console.error("[contract-recovery] audit log failed:", err);
  }

  return result;
}
