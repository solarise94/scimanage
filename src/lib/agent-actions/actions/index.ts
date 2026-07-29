import { registerProjectActions } from "./projects";
import { registerOrderActions } from "./orders";
import { registerCrmActions } from "./crm";
import { registerFinanceActions } from "./finance";
import { registerTicketActions } from "./tickets";
import { registerAgentActions } from "./agent";
import { registerContractActions } from "./contracts";
// Phase B/D：注册 public facade。
// facade 自身零 Prisma（经 internal action 调度），与 boundary 扫描一致。
// P2-2：manifest implemented 现在静态全 true；一致性由 assertPublicFacadeParity 校验。
import { registerPublicReadFacades, assertPublicFacadeParity } from "../public/facades";

export function registerBuiltinAgentActions() {
  registerProjectActions();
  registerOrderActions();
  registerCrmActions();
  registerFinanceActions();
  registerTicketActions();
  registerAgentActions();
  registerContractActions();
  // Phase B：internal actions 注册完成后，注册 public facade。
  registerPublicReadFacades();
}

/**
 * 启动期一致性断言（P2-2）：manifest↔handler↔action registry 校验。
 * 必须在 registerBuiltinAgentActions 之后调用（runtime/instrumentation 负责）。
 * 异步：内部动态 import registry（避免模块加载期循环依赖）。
 */
export async function assertBuiltinAgentActionsParity(): Promise<void> {
  await assertPublicFacadeParity();
}
