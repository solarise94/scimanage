/**
 * openEntityResource 路径回归。
 *
 * 锁定：order / project / ticket / customer 走 onOpenResource(entity)；
 * 无资源栏时回退 focus_entity。invoice 优先 onOpenResource，否则 navigate 全页。
 * 同时覆盖签到结果卡 / 工单状态与回复完成卡对共享 helper 的接线（adapter 映射）。
 *
 * 运行: npx tsx scripts/smoke-test-agent-open-resource.ts
 */

import { openEntityResource } from "@/components/agent/cards/open-resource";
import { normalizeAgentUi } from "@/components/agent/agent-ui-adapters";
import type { AgentResourceRequest } from "@/lib/agent-resources/types";
import type { AgentViewIntent } from "@/lib/agent-runtime/types";

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    pass++;
  } else {
    console.log(`  ✗ ${msg}`);
    fail++;
  }
}

function captureHandlers() {
  const resources: AgentResourceRequest[] = [];
  const intents: AgentViewIntent[] = [];
  return {
    resources,
    intents,
    onOpenResource: (req: AgentResourceRequest) => {
      resources.push(req);
    },
    onApplyViewIntent: (intent: AgentViewIntent) => {
      intents.push(intent);
    },
  };
}

console.log("=== openEntityResource 路径 ===\n");

{
  const h = captureHandlers();
  openEntityResource("order", "ord-1", "打开订单详情", h);
  assert(h.resources.length === 1, "order → onOpenResource 一次");
  assert(
    h.resources[0]?.type === "entity"
      && h.resources[0].entityType === "order"
      && h.resources[0].entityId === "ord-1",
    "order entity 请求字段正确",
  );
  assert(h.intents.length === 0, "有 onOpenResource 时不走 view-intent");
}

{
  const intents: AgentViewIntent[] = [];
  openEntityResource("project", "proj-1", "打开项目详情", {
    onApplyViewIntent: (i) => intents.push(i),
  });
  assert(intents.length === 1 && intents[0].type === "focus_entity", "project 无资源栏 → focus_entity");
  assert(intents[0]?.entityType === "project" && intents[0]?.entityId === "proj-1", "project focus 字段正确");
}

{
  const intents: AgentViewIntent[] = [];
  openEntityResource("ticket", "tkt-1", "打开工单详情", {
    onApplyViewIntent: (i) => intents.push(i),
  });
  assert(intents[0]?.type === "focus_entity" && intents[0]?.entityType === "ticket", "ticket → focus_entity");
}

{
  const intents: AgentViewIntent[] = [];
  openEntityResource("customer", "prof-1", "打开客户详情", {
    onApplyViewIntent: (i) => intents.push(i),
  });
  assert(intents[0]?.type === "focus_entity" && intents[0]?.entityType === "customer", "customer → focus_entity");
}

{
  const h = captureHandlers();
  openEntityResource("invoice", "inv-1", "打开发票详情", h);
  assert(
    h.resources[0]?.type === "entity"
      && h.resources[0].entityType === "invoice"
      && h.resources[0].entityId === "inv-1",
    "invoice 优先 onOpenResource",
  );
}

{
  const intents: AgentViewIntent[] = [];
  openEntityResource("invoice", "inv-2", "打开发票详情", {
    onApplyViewIntent: (i) => intents.push(i),
  });
  assert(intents[0]?.type === "navigate", "invoice 无资源栏 → navigate");
  assert(
    typeof intents[0]?.route === "string"
      && intents[0].route.includes("invoiceId=inv-2"),
    "invoice navigate 含 invoiceId",
  );
}

{
  const h = captureHandlers();
  openEntityResource("order", "", "打开订单详情", h);
  assert(h.resources.length === 0 && h.intents.length === 0, "空 entityId 不触发打开");
}

console.log("\n=== 结果卡 adapter 保留可打开 ID ===\n");

{
  const checkin = normalizeAgentUi({
    actionKey: "crm.create_visit_checkin",
    input: { profileId: "prof-checkin", customerName: "测试客户" },
    output: {
      checkin: { id: "ck-1", status: "COMPLETED", addressSnapshot: "某路", completedAt: new Date().toISOString() },
      interaction: { id: "ix-1", type: "VISIT" },
    },
    proposal: {
      id: "p1",
      actionKey: "crm.create_visit_checkin",
      title: "签到",
      summary: "签到",
      status: "CONFIRMED",
      input: { profileId: "prof-checkin", customerName: "测试客户" },
    } as never,
    status: "success",
  });
  assert(checkin?.type === "crm.checkin-result", "确认签到 → checkin-result");
  assert(checkin?.props.profileId === "prof-checkin", "签到结果卡保留 profileId");
}

{
  const statusCard = normalizeAgentUi({
    actionKey: "tickets.update_status",
    input: { ticketId: "tkt-status", status: "CLOSED" },
    output: {
      ticket: { id: "tkt-status", title: "样例工单", status: "CLOSED", previousStatus: "OPEN" },
    },
    proposal: {
      id: "p2",
      actionKey: "tickets.update_status",
      title: "改状态",
      summary: "将工单「样例工单」状态从「打开」变更为「已关闭」。",
      status: "CONFIRMED",
      input: { ticketId: "tkt-status", status: "CLOSED" },
    } as never,
    status: "success",
  });
  assert(statusCard?.type === "tickets.status-update", "工单状态 → status-update");
  assert(
    (statusCard?.props.ticket as { id?: string } | undefined)?.id === "tkt-status",
    "状态卡保留 ticket.id",
  );
}

{
  const replyCard = normalizeAgentUi({
    actionKey: "tickets.reply",
    input: { ticketId: "tkt-reply", content: "收到" },
    output: {
      reply: { id: "r1", ticketId: "tkt-reply", content: "收到" },
    },
    proposal: {
      id: "p3",
      actionKey: "tickets.reply",
      title: "回复",
      summary: "将在工单「样例」下添加回复",
      status: "CONFIRMED",
      input: { ticketId: "tkt-reply", content: "收到" },
    } as never,
    status: "success",
  });
  assert(replyCard?.type === "tickets.reply-draft", "工单回复 → reply-draft");
  assert(
    (replyCard?.props.reply as { ticketId?: string } | undefined)?.ticketId === "tkt-reply",
    "回复卡保留 reply.ticketId",
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("❌ openEntityResource 回归失败");
  process.exit(1);
}
console.log("✅ openEntityResource 回归通过");
