-- AddColumn + UniqueIndex: FinanceReceipt.sourceAgentProposalId
-- Agent proposal 级业务幂等键：finance.create_receipt 单回款确认链按 proposalId
-- 冻结——业务写入成功后、proposal finalize 前进程崩溃/租约回收导致同 proposal
-- 重执行时，唯一约束兜底幂等回放，不再重复创建回款与核销行。
-- 银行流水批量确认不用此键（一个 proposal 对应多笔回款，走 sourceWorkspaceId +
-- sourceRowIndex 复合唯一键）。旧数据为 NULL，SQLite 唯一约束允许多个 NULL。
--
-- 应用方式与既有部署一致：npx prisma db push（additive-only；unique 约束会触发
-- 表重建假阳性告警，部署时按 deploy 脚本约定显式 PRISMA_ACCEPT_DATA_LOSS=1）。

PRAGMA defer_foreign_keys;
BEGIN TRANSACTION;

ALTER TABLE "FinanceReceipt" ADD COLUMN "sourceAgentProposalId" TEXT;
CREATE UNIQUE INDEX "FinanceReceipt_sourceAgentProposalId_key"
  ON "FinanceReceipt"("sourceAgentProposalId");

COMMIT;
