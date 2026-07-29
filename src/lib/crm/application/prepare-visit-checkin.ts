/**
 * Draft-only visit checkin preparation (T5.3).
 *
 * Shared by Agent `crm.prepare_visit_checkin`. No formal auth conclusion;
 * reuses customer context query for display cards.
 *
 * P0-4（preview→confirm 断链修复）：prepare 阶段在 Agent channel 持久化一条 DRAFT
 * CrmVisitCheckin 行作为服务端 intent 锚点（checkinId），供后续 create_visit_checkin
 * 一次性消费。GPS 仍由浏览器在用户点击「保存签到」时注入，create execute 把 GPS
 * 写回该 DRAFT 后调用 completeVisitCheckin 完成 DRAFT→COMPLETED 终态转换。
 *
 * Web channel 不创建 DRAFT（Web 走自己的多步上传/完成路径）。
 */
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import { assertCrmRepSelfServiceAccess } from "@/lib/crm/application/crm-agent-access";
import { getCustomerContextForActor } from "@/lib/crm/application/get-customer-context";
import { createCheckinDraft } from "@/lib/crm/services/visit-checkin";

export type PrepareVisitCheckinResult = {
  profileId: string;
  customerName: string;
  organization: string;
  checkinReady: string;
  /** Agent channel 下创建的 DRAFT checkin ID（intent 锚点）；Web channel 为 null。 */
  checkinId: string | null;
};

export async function prepareVisitCheckinForActor(
  actor: BusinessActor,
  invocation: InvocationContext,
  profileId: string,
): Promise<PrepareVisitCheckinResult> {
  if (invocation.channel === "agent") {
    assertCrmRepSelfServiceAccess(actor);
  }

  const context = await getCustomerContextForActor(actor, profileId);

  let checkinId: string | null = null;
  if (invocation.channel === "agent") {
    // P0-4：Agent channel 持久化 DRAFT intent（仅 profileId + userId；lat/lng 为空，
    // 由后续 create_visit_checkin 在 execute 时补齐 GPS）。这是 intent 而非业务终态：
    // status=DRAFT，未创建 VISIT interaction，未触发 lifecycle stage 转换。
    const draft = await createCheckinDraft({
      profileId: context.profileId,
      userId: actor.userId,
    });
    checkinId = draft.id;
  }

  return {
    profileId: context.profileId,
    customerName: context.customerName,
    organization: context.organization,
    checkinReady: "true",
    checkinId,
  };
}
