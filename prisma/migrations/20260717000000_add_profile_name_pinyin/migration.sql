-- AGENT-VOICE-01: 为 CrmCustomerProfile 增加去声调拼音检索字段。
-- namePinyin 由写路径自动填充（pinyin-pro），用于语音同音错字召回：
--   name="王晓明" → namePinyin="wangxiaoming"，使 ASR 转写的 "王小明" 也能 SQL 命中。
-- 字段可为空（向后兼容），存量数据由 scripts/backfill-profile-name-pinyin.ts 回填。

-- RedefineTables
-- SQLite 不支持纯 ADD COLUMN + CREATE INDEX 的独立语句在 Prisma 迁移上下文里直接跑，
-- 因此采用 Prisma 标准的 SQLite 迁移写法：重建表。但本迁移实际通过 `prisma db push`
-- 应用（仓库约定，见 AGENTS.md），此 SQL 文件仅作为迁移历史留档。

PRAGMA defer_foreign_keys;
BEGIN TRANSACTION;

-- AddColumn: namePinyin
ALTER TABLE "CrmCustomerProfile" ADD COLUMN "namePinyin" TEXT;

-- CreateIndex
CREATE INDEX "CrmCustomerProfile_namePinyin_idx" ON "CrmCustomerProfile"("namePinyin");

COMMIT;
