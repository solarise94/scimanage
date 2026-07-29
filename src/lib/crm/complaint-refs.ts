/**
 * 客诉关联资源校验——relatedOrder / relatedProject / relatedInteraction。
 *
 * 设计文档 §关联资源校验：
 * 1. relatedOrderId 必须复用订单模块 scope 校验 + order.profileId 等于当前 profileId。
 * 2. relatedProjectId 必须复用项目权限校验 + project.profileId 等于当前 profileId。
 * 3. relatedInteractionId 必须属于当前 profileId。
 * 4. 不允许通过客诉关联字段把用户无权读取的订单/项目 ID 暴露出来。
 * 5. 权限失败优先返回 403，资源不存在或不属于当前客户返回 400/404。
 *
 * 返回值：成功返回 void，失败抛错（message 为错误类型，API 层映射到状态码）。
 */
import { prisma } from "@/lib/prisma";
import { getOrderScopeWhere } from "@/lib/orders/permissions";
import { assertProjectContextReadable } from "@/lib/permissions";

export interface ComplaintRefValidationParams {
  profileId: string;
  userId: string;
  role: string;
  department: string;
  relatedOrderId?: string | null;
  relatedProjectId?: string | null;
  relatedInteractionId?: string | null;
}

/**
 * 校验客诉关联资源。
 *
 * 抛错约定（API 层 catch 后映射）：
 * - "FORBIDDEN"            → 403（有权 profile 但无权读该订单/项目）
 * - "REF_NOT_FOUND"        → 404（关联资源不存在）
 * - "REF_CUSTOMER_MISMATCH" → 400（资源不属于当前客户）
 * - "INTERACTION_MISMATCH" → 400（沟通记录不属于当前 profile）
 */
export async function validateComplaintRelatedRefs(
  params: ComplaintRefValidationParams,
): Promise<void> {
  const { profileId, userId, role, department } = params;

  const belongsToProfile = (row: { profileId?: string | null }) =>
    Boolean(row.profileId) && row.profileId === profileId;

  // ── relatedOrderId ──
  // 先做 scope 校验（确定用户能读该订单），再判断客户归属。
  // 顺序很重要：如果先查归属，404/400 的差异会泄露无权订单是否存在。
  if (params.relatedOrderId) {
    const orderId = params.relatedOrderId;
    // 订单读取权限校验（scope 为 null 表示 ADMIN，全量可见）
    const scope = await getOrderScopeWhere(userId, role, prisma, department);
    if (scope !== null) {
      const visible = await prisma.order.findFirst({
        where: { AND: [scope, { id: orderId, deleted: false }] },
        select: { id: true, profileId: true },
      });
      if (!visible) throw new Error("FORBIDDEN");
      if (!belongsToProfile(visible)) {
        throw new Error("REF_CUSTOMER_MISMATCH");
      }
    } else {
      // ADMIN：直接查订单做归属校验
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true, profileId: true, deleted: true },
      });
      if (!order || order.deleted) {
        throw new Error("REF_NOT_FOUND");
      }
      if (!belongsToProfile(order)) {
        throw new Error("REF_CUSTOMER_MISMATCH");
      }
    }
  }

  // ── relatedProjectId ──
  // 复用现有项目权限守卫 assertProjectContextReadable，不自行重写成员判断。
  if (params.relatedProjectId) {
    const projectId = params.relatedProjectId;
    // 项目读取权限校验（ADMIN 放行；REPRESENTATIVE 抛 FORBIDDEN；其余角色需是成员）
    try {
      await assertProjectContextReadable(projectId, userId, role);
    } catch {
      throw new Error("FORBIDDEN");
    }
    // 客户归属校验
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { profileId: true },
    });
    if (!project) {
      throw new Error("REF_NOT_FOUND");
    }
    if (!belongsToProfile(project)) {
      throw new Error("REF_CUSTOMER_MISMATCH");
    }
  }

  // ── relatedInteractionId ──
  if (params.relatedInteractionId) {
    const interaction = await prisma.crmInteraction.findUnique({
      where: { id: params.relatedInteractionId },
      select: { id: true, profileId: true },
    });
    if (!interaction) {
      throw new Error("REF_NOT_FOUND");
    }
    if (interaction.profileId !== profileId) {
      throw new Error("INTERACTION_MISMATCH");
    }
  }
}
