/**
 * 合同生成确定排序工具（prisma-free 纯模块）。
 *
 * ⚠️ 不得引入 @/lib/prisma 或任何运行时依赖 Prisma 的模块：
 * 本模块被测试在 withTempSmokeDb 之外静态导入，若传递实例化 PrismaClient
 * 会把全局单例钉死在 dev.db 上，污染真实开发库（见 T8 迁移记忆 gotcha）。
 * `import type { Prisma }` 仅为类型约束，编译期擦除，无运行时实例化。
 */
import type { Prisma } from "@prisma/client";

/**
 * 按调用方指定的 orderIds 顺序重排订单查询结果（与 loadOrdersForContractAction 同口径）。
 * Prisma findMany({ where: { id: { in } } }) 不保证返回顺序，而 buildTemplateData 按 orders
 * 数组顺序 flatMap 行项目，且 lines 顺序进入 fact digest；preflight 与事务内重载若返回
 * 不同顺序，会产生假性 FACT_DIGEST_MISMATCH。两处查询统一重排后，渲染/落库/digest
 * 全链路顺序确定，且与调用方（用户/模型）指定的 orderIds 顺序一致。
 */
export function sortOrdersByInputIds<T extends { id: string }>(orders: T[], orderIds: string[]): T[] {
  const byId = new Map(orders.map((order) => [order.id, order]));
  return orderIds.map((id) => byId.get(id)).filter((order): order is T => order !== undefined);
}

/**
 * 首单项目关联的确定排序：isPrimary 优先 → 最早创建 → id。
 * 一笔订单存在多个项目关联时，findFirst 不加 orderBy 的选取不确定；preflight 与事务内
 * 重载若取到不同 projectId，会进入 digest 造成假性 mismatch，附件归属也会漂移。
 */
export const PRIMARY_PROJECT_LINK_ORDER_BY = [
  { isPrimary: "desc" as const },
  { createdAt: "asc" as const },
  { id: "asc" as const },
] satisfies Prisma.OrderProjectLinkOrderByWithRelationInput[];
