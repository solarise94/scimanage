/**
 * Phase B/C/D: register all public facades。
 *
 * read facades（Phase B）+ propose/workflow facades（Phase C/D）。
 * 在应用启动时调用（由 registerBuiltinAgentActions 触发）。
 *
 * P2-2：manifest 的 implemented 现在是静态声明（manifest.ts 全部 implemented:true），
 * 本模块不再翻转 implemented 标志。一致性由 assertManifestFacadeParity 在注册完成后校验。
 *
 * 本模块零 Prisma。
 */
import { registerPublicFacade } from "../public-executor";
import {
  findCustomersFacade,
  getCustomerFacade,
  findProjectsFacade,
  getProjectFacade,
  findOrdersFacade,
  getOrderFacade,
  findTicketsFacade,
  findContractsFacade,
  getContractFacade,
  getInvoiceFacade,
  listContractTemplatesFacade,
} from "./read";
import {
  prepareOrderFacade,
  proposeOrderFacade,
  proposeProjectFacade,
  proposeTicketFacade,
  proposeTicketReplyFacade,
  proposeFollowUpFacade,
  proposeVisitCheckinFacade,
  proposeInvoiceFacade,
  proposeReceiptFacade,
  prepareContractFacade,
  proposeInvoiceRegistrationFacade,
  linkOrderProjectFacade,
} from "./propose";
import {
  startOrderImportFacade,
  operateOrderImportFacade,
  startBankFlowFacade,
  operateBankFlowFacade,
  inspectAttachmentFacade,
} from "./workflow";

// standalone 构建按 route 分包可能产生多个模块实例，registered 标志必须挂
// globalThis（与 FACADE_REGISTRY 同因），否则一个 chunk 已注册、另一个 chunk
// 重复注册（或误判未注册）。
export function registerPublicReadFacades(): void {
  if (globalThis.__agentPublicFacadesRegistered) return;
  globalThis.__agentPublicFacadesRegistered = true;

  // read（Phase B）
  registerPublicFacade("find_customers", findCustomersFacade);
  registerPublicFacade("get_customer", getCustomerFacade);
  registerPublicFacade("find_projects", findProjectsFacade);
  registerPublicFacade("get_project", getProjectFacade);
  registerPublicFacade("find_orders", findOrdersFacade);
  registerPublicFacade("get_order", getOrderFacade);
  registerPublicFacade("find_tickets", findTicketsFacade);
  registerPublicFacade("find_contracts", findContractsFacade);
  registerPublicFacade("get_contract", getContractFacade);
  registerPublicFacade("get_invoice", getInvoiceFacade);
  registerPublicFacade("list_contract_templates", listContractTemplatesFacade);

  // propose / workflow（Phase C）
  registerPublicFacade("prepare_order", prepareOrderFacade);
  registerPublicFacade("propose_order", proposeOrderFacade);
  registerPublicFacade("propose_project", proposeProjectFacade);
  registerPublicFacade("propose_ticket", proposeTicketFacade);
  registerPublicFacade("propose_ticket_reply", proposeTicketReplyFacade);
  registerPublicFacade("propose_follow_up", proposeFollowUpFacade);
  registerPublicFacade("propose_visit_checkin", proposeVisitCheckinFacade);
  registerPublicFacade("propose_invoice", proposeInvoiceFacade);
  registerPublicFacade("propose_receipt", proposeReceiptFacade);
  registerPublicFacade("prepare_contract", prepareContractFacade);
  registerPublicFacade("propose_invoice_registration", proposeInvoiceRegistrationFacade);
  registerPublicFacade("link_order_project", linkOrderProjectFacade);

  // workflow（Phase D）
  registerPublicFacade("start_order_import", startOrderImportFacade);
  registerPublicFacade("operate_order_import", operateOrderImportFacade);
  registerPublicFacade("start_bank_flow", startBankFlowFacade);
  registerPublicFacade("operate_bank_flow", operateBankFlowFacade);
  registerPublicFacade("inspect_attachment", inspectAttachmentFacade);
}

/**
 * 启动期一致性断言：manifest↔handler↔action registry 校验（P2-2）。
 * 必须在 builtin actions + public facades 都注册完成后调用。
 *
 * 异步：内部动态 import registry（避免模块加载期循环依赖）。
 */
export async function assertPublicFacadeParity(): Promise<void> {
  const { assertManifestFacadeParity } = await import("../manifest-parity");
  await assertManifestFacadeParity();
}

// 测试辅助：重置注册状态（隔离测试）。
// P2-2：不再翻回 manifest implemented（manifest 现在静态全 true）。
export function __resetPublicReadFacadesForTests(): void {
  globalThis.__agentPublicFacadesRegistered = false;
}
