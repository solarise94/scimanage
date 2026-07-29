-- CRM 客户阶段流转设计第一版迁移
-- 将旧 stage = 'NEW' 统一更新为 'CONTACTED'
-- 运行时对读取到的漏网 'NEW' 仍按 'CONTACTED' 兼容处理（见 normalizeStage）

UPDATE "CrmCustomerProfile" SET stage = 'CONTACTED' WHERE stage = 'NEW';
