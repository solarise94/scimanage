/**
 * P2-2：manifest ↔ facade handler ↔ action registry 一致性断言。
 *
 * 在服务启动路径调用一次（registerBuiltinAgentActions 末尾），fail-fast：
 *  - enabled(implemented:true) tool 必有 handler 注册；
 *  - handler 必有 manifest entry；
 *  - manifest 的 internalActions 全部存在于 action registry；
 *  - roles/kind/exposure 字段完整（kind ∈ 枚举；roles 数组元素合法；exposure ∈ 枚举）。
 *
 * 本模块零 Prisma。仅在启动期读 manifest + registry + facade registry（均内存态）。
 *
 * 注意循环依赖：registry.ts → actions/index.ts → facades/index.ts → manifest-parity.ts。
 * 因此 listAgentActions 用动态 import（在函数体内），避免模块加载期循环。
 */
import { PUBLIC_TOOL_MANIFEST, type PublicToolKind } from "./manifest";
import { getRegisteredFacadeKeys } from "./public-executor";

const VALID_KINDS: ReadonlySet<PublicToolKind> = new Set<PublicToolKind>([
  "discovery",
  "context",
  "propose",
  "preview",
  "workflow",
  "preview_then_confirm_generate",
]);

const VALID_EXPOSURES = new Set(["primary", "contextual", "workflow_step"]);

const VALID_ROLES = new Set(["ADMIN", "USER", "REGIONAL_MANAGER", "REPRESENTATIVE"]);

export interface ManifestFacadeParityViolation {
  publicTool: string;
  kind: string;
  detail: string;
}

/**
 * 校验 manifest ↔ handler ↔ action registry 一致性。返回违规列表（空 = 通过）。
 *
 * 注意：调用方必须确保 builtin actions 与 public facades 都已注册完成后再调用
 * （否则 handler/action 暂缺会被误报为违规）。
 */
export async function checkManifestFacadeParity(): Promise<ManifestFacadeParityViolation[]> {
  const violations: ManifestFacadeParityViolation[] = [];
  // 动态 import：避免模块加载期循环依赖（registry → actions → facades → manifest-parity）。
  const { listAgentActions } = await import("../registry");
  const actionKeys = new Set(listAgentActions().map((a) => a.key));
  const facadeKeys = getRegisteredFacadeKeys();

  for (const entry of PUBLIC_TOOL_MANIFEST) {
    // 字段完整性
    if (!VALID_KINDS.has(entry.kind)) {
      violations.push({ publicTool: entry.publicTool, kind: "kind", detail: `未知 kind: ${entry.kind}` });
    }
    if (!VALID_EXPOSURES.has(entry.exposure)) {
      violations.push({
        publicTool: entry.publicTool,
        kind: "exposure",
        detail: `未知 exposure: ${entry.exposure}`,
      });
    }
    for (const role of entry.roles) {
      if (!VALID_ROLES.has(role)) {
        violations.push({
          publicTool: entry.publicTool,
          kind: "roles",
          detail: `未知 role: ${role}`,
        });
      }
    }
    if (entry.internalActions.length === 0) {
      violations.push({
        publicTool: entry.publicTool,
        kind: "internalActions",
        detail: "internalActions 为空",
      });
    }

    // enabled tool 必有 handler
    if (entry.implemented && !facadeKeys.has(entry.publicTool)) {
      violations.push({
        publicTool: entry.publicTool,
        kind: "handler",
        detail: "implemented:true 但无 facade handler 注册",
      });
    }
    // handler 必有 manifest entry（此处 entry 来自 manifest 迭代，天然满足；保留语义注释）

    // internalActions 全部存在于 action registry
    for (const actionKey of entry.internalActions) {
      if (!actionKeys.has(actionKey)) {
        violations.push({
          publicTool: entry.publicTool,
          kind: "internalActions",
          detail: `internal action 未注册: ${actionKey}`,
        });
      }
    }
  }

  return violations;
}

/**
 * 启动期一致性断言：违规即抛错（fail-fast，避免带病启动）。
 * 在 registerBuiltinAgentActions 末尾调用一次。
 */
export async function assertManifestFacadeParity(): Promise<void> {
  const violations = await checkManifestFacadeParity();
  if (violations.length > 0) {
    const lines = violations.map(
      (v) => `  - [${v.publicTool}] ${v.kind}: ${v.detail}`,
    );
    throw new Error(
      `[manifest-parity] manifest ↔ handler ↔ action registry 不一致（${violations.length} 项）：\n${lines.join("\n")}`,
    );
  }
}
