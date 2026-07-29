-- AddColumn: AgentProposal.displayPropsJson
-- 服务端生成的结构化展示快照，卡片组件优先读取此字段而非从 summary 正则刮取实体名。
-- 旧数据为 NULL，卡片回退到正则匹配。

PRAGMA defer_foreign_keys;
BEGIN TRANSACTION;

ALTER TABLE "AgentProposal" ADD COLUMN "displayPropsJson" TEXT;

COMMIT;
