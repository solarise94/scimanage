-- AGENT-DREAM-01: 梦境记忆 D1 基础设施。
-- 1) AgentMemory 增加 embeddingBytes（向量召回；bge-m3 1024 维 Float32 LE，可空降级）。
-- 2) 新增 AgentEntityMemory：实体级（项目/客户）热记忆，夜间整理产出。
--    唯一约束 (userId, entityType, entityId)；索引 (userId, status, activityScore) 用于
--    按"活跃度分数 + 状态"快速拉热记忆候选注入 prompt。
-- 字段均可空/带默认值，向后兼容；实际通过 `prisma db push` 应用（仓库约定，见 AGENTS.md），
-- 此 SQL 文件仅作为迁移历史留档。

PRAGMA defer_foreign_keys;
BEGIN TRANSACTION;

-- AddColumn: AgentMemory.embeddingBytes
ALTER TABLE "AgentMemory" ADD COLUMN "embeddingBytes" BLOB;

-- CreateTable: AgentEntityMemory
CREATE TABLE "AgentEntityMemory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "activityScore" REAL NOT NULL DEFAULT 0,
    "lastActiveAt" DATETIME,
    "embeddingBytes" BLOB,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentEntityMemory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: 唯一约束 (userId, entityType, entityId)
CREATE UNIQUE INDEX "AgentEntityMemory_userId_entityType_entityId_key"
    ON "AgentEntityMemory"("userId", "entityType", "entityId");

-- CreateIndex: 按用户+状态+活跃度召回热记忆候选
CREATE INDEX "AgentEntityMemory_userId_status_activityScore_idx"
    ON "AgentEntityMemory"("userId", "status", "activityScore");

COMMIT;
