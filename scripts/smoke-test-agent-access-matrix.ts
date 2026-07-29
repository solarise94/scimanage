/**
 * Agent CRM 访问矩阵 — 纯逻辑级固定回归（不依赖 HTTP / session / DB 查询）。
 *
 * 目的：锁定「区域经理 REGIONAL_MANAGER 开放读类 CRM Agent，写类仅代表/ADMIN」的角色矩阵。
 * 仅调用每个 action 的 `availability(actor)`；availability 内部只走 role helper（canReadCrmAgent /
 * canUseCrmAgent），不触达数据库。USER 必须全部 false（USER 不能进 Agent）。
 *
 * 运行: npx tsx scripts/smoke-test-agent-access-matrix.ts
 *
 * 断言：
 *  - REGIONAL_MANAGER：读类 action=true，写类 action=false。
 *  - REPRESENTATIVE：所有 crm.* action=true。
 *  - USER：所有 crm.* action=false。
 *  - ADMIN：所有 crm.* action=true。
 */

import type { BusinessActor } from "../src/lib/application/actor";

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

function assertEq<T>(actual: T, expected: T, msg: string) {
  assert(
    actual === expected,
    `${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`,
  );
}

const CRM_READ_ACTIONS = new Set<string>([
  "crm.search_customers",
  "crm.get_customer_context",
  "crm.list_my_organizations",
  "crm.resolve_customer_name",
  "crm.search_customers_by_pinyin",
]);

function isCrmAction(key: string): boolean {
  return key.startsWith("crm.");
}

function isReadCrmAction(key: string): boolean {
  return CRM_READ_ACTIONS.has(key);
}

async function availabilityMap(role: string): Promise<Map<string, boolean>> {
  const { listAgentActions } = await import("../src/lib/agent-actions/registry");
  const actor: BusinessActor = {
    userId: `smoke-${role.toLowerCase()}-user`,
    role,
    name: `Smoke ${role}`,
    email: `smoke-${role.toLowerCase()}@test.local`,
  };
  const actions = listAgentActions().filter((a) => isCrmAction(a.key));
  const result = new Map<string, boolean>();
  await Promise.all(
    actions.map(async (a) => {
      result.set(a.key, await a.availability(actor));
    }),
  );
  return result;
}

/** 列出 agent.* 命名空间的已注册 action（不触发 DB，仅角色矩阵断言用）。 */
async function listAgentActionsForAgentDomain() {
  const { listAgentActions } = await import("../src/lib/agent-actions/registry");
  return listAgentActions().filter((a) => a.key.startsWith("agent."));
}

async function main() {
  console.log("=== Agent CRM access matrix (logic-level) ===\n");

  // ── 入口角色门 requireAgentAccess（review P1#2）────────────────────────────
  // 纯函数断言：USER 打任意 /api/agent/** 应被 403 拒绝；REP/RM/ADMIN 放行；
  // null session 401。不碰 DB / HTTP，直接 import helper。
  console.log("[requireAgentAccess] 入口角色门（REP/RM/ADMIN 放行，USER 403，null 401）");
  {
    const { requireAgentAccess } = await import("../src/lib/agent-actions/require-agent-access");
    type MockSession = { user?: { role?: string | null } };

    function mockSession(role: string): MockSession {
      return { user: { role } };
    }

    const allowed = ["REPRESENTATIVE", "REGIONAL_MANAGER", "ADMIN"] as const;
    for (const role of allowed) {
      const res = requireAgentAccess(mockSession(role) as never);
      assert(res === null, `requireAgentAccess(${role}) 放行（null）`);
    }

    const userRes = requireAgentAccess(mockSession("USER") as never);
    assert(!!userRes, "requireAgentAccess(USER) 返回响应（非 null）");
    assert(userRes?.status === 403, `USER → 403（实际 ${userRes?.status}）`);

    const nullRes = requireAgentAccess(null);
    assert(!!nullRes, "requireAgentAccess(null) 返回响应（非 null）");
    assert(nullRes?.status === 401, `null session → 401（实际 ${nullRes?.status}）`);

    // 无 role 的 session 也应被拒（边界）。
    const noRoleRes = requireAgentAccess({ user: { role: "" } } as never);
    assert(noRoleRes?.status === 403, `空 role → 403（实际 ${noRoleRes?.status}）`);
  }
  console.log("");

  const roles = ["REPRESENTATIVE", "REGIONAL_MANAGER", "USER", "ADMIN"] as const;
  const maps = new Map<string, Map<string, boolean>>();
  for (const role of roles) {
    maps.set(role, await availabilityMap(role));
  }

  // Pretty-print matrix
  const allKeys = Array.from(maps.get("ADMIN")!.keys()).sort();
  console.log("action".padEnd(38) + roles.map((r) => r.padEnd(18)).join(""));
  for (const key of allKeys) {
    const cells = roles.map((r) => {
      const v = maps.get(r)!.get(key);
      return (v ? "✓" : "✗").padEnd(18);
    });
    console.log(key.padEnd(38) + cells.join(""));
  }
  console.log("");

  // ---- Assertions ----

  // REGIONAL_MANAGER: read=true, write=false
  console.log("[REGIONAL_MANAGER] 读类=true、写类=false");
  const rm = maps.get("REGIONAL_MANAGER")!;
  for (const key of allKeys) {
    const expected = isReadCrmAction(key);
    assertEq(rm.get(key), expected, `RM ${key}`);
  }

  // REPRESENTATIVE: all crm.* = true
  console.log("\n[REPRESENTATIVE] 所有 crm.* action=true");
  const rep = maps.get("REPRESENTATIVE")!;
  for (const key of allKeys) {
    assertEq(rep.get(key), true, `REP ${key}`);
  }

  // USER: all crm.* = false (USER 不在 Agent 白名单)
  console.log("\n[USER] 所有 crm.* action=false");
  const user = maps.get("USER")!;
  for (const key of allKeys) {
    assertEq(user.get(key), false, `USER ${key}`);
  }

  // ADMIN: all crm.* = true
  console.log("\n[ADMIN] 所有 crm.* action=true");
  const admin = maps.get("ADMIN")!;
  for (const key of allKeys) {
    assertEq(admin.get(key), true, `ADMIN ${key}`);
  }

  // Matrix completeness sanity: read set must be non-empty & every crm action
  // classified as either read or write.
  assert(CRM_READ_ACTIONS.size > 0, "CRM_READ_ACTIONS 非空");
  for (const key of allKeys) {
    assert(isCrmAction(key), `${key} 属于 crm.* 命名空间`);
  }

  // ── agent.* 命名空间：agent.recall_memory 角色矩阵 ───────────────────────
  // 梦境记忆 D3：REP/RM/ADMIN 可用（与 Agent 入口 canAccessAgent 口径一致），USER 不可用。
  console.log("\n[agent.recall_memory] 角色矩阵（REP/RM/ADMIN=true, USER=false）");
  const allActions = await listAgentActionsForAgentDomain();
  const recallAction = allActions.find((a) => a.key === "agent.recall_memory");
  assert(!!recallAction, "agent.recall_memory 已注册");
  if (recallAction) {
    for (const role of roles) {
      const actorForRole: BusinessActor = {
        userId: `smoke-agent-${role.toLowerCase()}-user`,
        role,
        name: `Smoke ${role}`,
        email: `smoke-agent-${role.toLowerCase()}@test.local`,
      };
      const available = await recallAction.availability(actorForRole);
      const expected = role !== "USER";
      assertEq(available, expected, `agent.recall_memory ${role}`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("❌ Agent 访问矩阵回归失败");
    process.exit(1);
  }
  console.log("✅ Agent 访问矩阵回归通过");
}

void main().catch((err) => {
  console.error("smoke-test-agent-access-matrix crashed:", err);
  process.exit(2);
});
