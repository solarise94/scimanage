/**
 * 订单/银行流水导入 Agent action 的统一权限入口。
 *
 * 见 docs/agent-sequential-order-import-upgrade-design-2026-07-21.md §9.1。
 * Phase B/C：仅 ADMIN 可使用批量文件导入。后续若开放给 USER，只扩展这一入口并补充
 * 创建者/组织 scope 测试，action 文件和 route 不得分别硬编码角色判断。
 *
 * 注意：availability 只控制工具可见性；route 和领域服务仍必须独立执行服务端授权。
 */
import type { BusinessActor } from "@/lib/application/actor";

/** Phase B/C 单一入口：仅 ADMIN 可使用 Agent 批量订单/流水导入能力。 */
export function canUseAgentImport(actor: Pick<BusinessActor, "role">): boolean {
  return actor.role === "ADMIN";
}
