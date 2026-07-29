/**
 * P1-3 allowProposal 可信前端事件测试
 * （docs/agent-public-surface-cleanup-plan-2026-07-26.md §六 P1-3 / §八.5）。
 *
 * 覆盖：
 *  - agent channel 无事件 → createAgentProposal 拒（NEEDS_USER_CONFIRMATION / 409）；
 *  - 颁发事件后 → proposal 创建成功且事件 consumedAt 落库；
 *  - 同一事件重放（再创建 proposal）→ 拒（一次性消费）；
 *  - 跨 run 事件（event 属 runA，proposal 在 runB）→ 拒；
 *  - targetIntent 不匹配 → 拒；
 *  - web channel 无事件 → 不受影响（成功）；
 *  - 路由：未登录 401 / 他人 runId 404 / 缺字段 400 / 幂等重发同 key 返回同事件 / 已消费后重发同 key 409；
 *  - idempotencyKey 唯一约束（同 actor 同 key 两次 issue 不产两行）。
 *
 * 全部场景共享单个 withTempSmokeDb 临时库（与 parity / phase-d 惯例一致）。
 * ⚠️ 顶层 type-only import + vi.mock（next-auth）。
 */
import { describe, expect, it, vi } from "vitest";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";
import type { BusinessActor } from "@/lib/application/actor";

// ── mock next-auth（路由用 getServerSession） ──
type SessionUser = { id: string; role: string; name: string; email: string };
type MockSession = { user: SessionUser };
const sessionState = vi.hoisted(() => ({ current: null as MockSession | null }));

vi.mock("next-auth/next", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getServerSession: async () => sessionState.current,
}));
vi.mock("next-auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getServerSession: async () => sessionState.current,
}));

/** 测试用 confirm action：零领域耦合，纯校验 createAgentProposal 的 gate 行为。 */
const TEST_ACTION_KEY = "test.confirm_echo_p1_3";

describe("P1-3 allowProposal 可信前端事件", () => {
  it("service gate + route + idempotency 全覆盖", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { hashSync } = await import("bcryptjs");
      const { ensureBuiltinAgentActionsRegistered, registerAgentAction } = await import(
        "@/lib/agent-actions/registry"
      );
      const { createAgentProposal } = await import("@/lib/agent-actions/proposals");
      const { issueConfirmationEvent } = await import("@/lib/application/agent-confirmation-events");
      const { AgentActionNeedsConfirmationError } = await import("@/lib/agent-actions/errors");

      ensureBuiltinAgentActionsRegistered();

      // 注册零耦合 confirm action（仅满足 createAgentProposal 的 riskLevel/buildProposal 要求）。
      registerAgentAction({
        key: TEST_ACTION_KEY,
        title: "测试确认",
        description: "P1-3 测试用 confirm action",
        domain: "agent",
        riskLevel: "confirm",
        readOnly: false,
        inputSchema: { type: "object", properties: {}, required: [] },
        outputSchema: { type: "object", properties: {}, required: [] },
        parseInput: (raw) => (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}),
        availability: async () => true,
        buildProposal: async () => ({
          title: "测试提案",
          summary: "P1-3 gate 测试",
        }),
        execute: async () => ({ ok: true }),
      });

      // ── 用户 / AgentRun fixture ──
      const password = hashSync("x", 4);
      const admin = await prisma.user.create({
        data: { email: "p13-admin@t.test", name: "P13Admin", password, role: "ADMIN" },
      });
      const other = await prisma.user.create({
        data: { email: "p13-other@t.test", name: "P13Other", password, role: "ADMIN" },
      });
      const adminActor: BusinessActor = { userId: admin.id, role: "ADMIN" };
      const runA = await prisma.agentRun.create({
        data: { userId: admin.id, role: "ADMIN", status: "ACTIVE", source: "CHAT" },
      });
      const runB = await prisma.agentRun.create({
        data: { userId: admin.id, role: "ADMIN", status: "ACTIVE", source: "CHAT" },
      });
      const otherRun = await prisma.agentRun.create({
        data: { userId: other.id, role: "ADMIN", status: "ACTIVE", source: "CHAT" },
      });

      // ════════════ §1 agent channel 无事件 → 拒（NEEDS_USER_CONFIRMATION / 409） ════════════
      await expect(
        createAgentProposal(
          { actor: adminActor, invocation: { channel: "agent", publicToolKey: "propose_test", agentRunId: runA.id } },
          TEST_ACTION_KEY,
          {},
        ),
      ).rejects.toMatchObject({ status: 409, code: "NEEDS_USER_CONFIRMATION" });

      // 验证抛出的是正确子类
      await expect(
        createAgentProposal(
          { actor: adminActor, invocation: { channel: "agent", publicToolKey: "propose_test", agentRunId: runA.id } },
          TEST_ACTION_KEY,
          {},
        ),
      ).rejects.toBeInstanceOf(AgentActionNeedsConfirmationError);

      // ════════════ §1b 回归：静态路径（channel=agent 但无 publicToolKey）不受门限 ════════════
      // runtime 桥接 / 浏览器 run 绑定调用都没有 publicToolKey；这些是既有 UX
      // （ProposalCard 确认按钮即用户确认），flag OFF 行为必须不变——无事件也应成功。
      const staticProposal = await createAgentProposal(
        { actor: adminActor, invocation: { channel: "agent", agentRunId: runA.id } },
        TEST_ACTION_KEY,
        {},
      );
      expect(staticProposal.status).toBe("PENDING");
      // 清理，避免影响后续串行/计数断言
      await prisma.agentProposal.delete({ where: { id: staticProposal.id } });

      // ════════════ §2 agent channel 无 runId → 拒（fail-closed） ════════════
      await expect(
        createAgentProposal(
          { actor: adminActor, invocation: { channel: "agent", publicToolKey: "propose_test", agentRunId: null } },
          TEST_ACTION_KEY,
          {},
        ),
      ).rejects.toMatchObject({ code: "NEEDS_USER_CONFIRMATION" });

      // ════════════ §3 颁发事件后 → proposal 创建成功且 consumedAt 落库 ════════════
      const event = await issueConfirmationEvent({
        actor: adminActor,
        agentRunId: runA.id,
        targetIntent: TEST_ACTION_KEY,
        idempotencyKey: "p13-key-aaaaaaaa",
      });
      expect(event.consumedAt).toBeNull();
      expect(event.action).toBe("create_proposal");
      expect(event.created).toBe(true);

      const proposal = await createAgentProposal(
        { actor: adminActor, invocation: { channel: "agent", publicToolKey: "propose_test", agentRunId: runA.id } },
        TEST_ACTION_KEY,
        {},
      );
      expect(proposal.status).toBe("PENDING");
      expect(proposal.actionKey).toBe(TEST_ACTION_KEY);

      // 事件已被消费
      const consumedEvent = await prisma.agentUserConfirmationEvent.findUnique({
        where: { id: event.id },
      });
      expect(consumedEvent?.consumedAt).not.toBeNull();

      // ════════════ §4 同一事件重放（再创建 proposal）→ 拒（一次性消费） ════════════
      await expect(
        createAgentProposal(
          { actor: adminActor, invocation: { channel: "agent", publicToolKey: "propose_test", agentRunId: runA.id } },
          TEST_ACTION_KEY,
          {},
        ),
      ).rejects.toMatchObject({ code: "NEEDS_USER_CONFIRMATION" });

      // ════════════ §5 跨 run 事件（event 属 runA，proposal 在 runB）→ 拒 ════════════
      // 给 runB 颁一个事件不是这测的目的；这测的是「runA 的事件不能在 runB 用」。
      // runA 的事件已被消费，runB 无事件 → 拒。
      await expect(
        createAgentProposal(
          { actor: adminActor, invocation: { channel: "agent", publicToolKey: "propose_test", agentRunId: runB.id } },
          TEST_ACTION_KEY,
          {},
        ),
      ).rejects.toMatchObject({ code: "NEEDS_USER_CONFIRMATION" });

      // 即使给 runB 颁发事件，runA 的事件（不同 runId）也不能用于 runB 的 proposal。
      const eventForB = await issueConfirmationEvent({
        actor: adminActor,
        agentRunId: runB.id,
        targetIntent: TEST_ACTION_KEY,
        idempotencyKey: "p13-key-bbbbbbbb",
      });
      // 现在用 runB 的 proposal 应当成功（事件匹配 runB）
      const proposalB = await createAgentProposal(
        { actor: adminActor, invocation: { channel: "agent", publicToolKey: "propose_test", agentRunId: runB.id } },
        TEST_ACTION_KEY,
        {},
      );
      expect(proposalB.status).toBe("PENDING");
      void eventForB; // 已被消费

      // ════════════ §6 targetIntent 不匹配 → 拒 ════════════
      // 为 runA 颁一个 targetIntent 为 contracts.generate 的事件，
      // 再用 TEST_ACTION_KEY 创建 proposal（不匹配）→ 拒。
      await issueConfirmationEvent({
        actor: adminActor,
        agentRunId: runA.id,
        targetIntent: "contracts.generate",
        idempotencyKey: "p13-key-cccccccc",
      });
      await expect(
        createAgentProposal(
          { actor: adminActor, invocation: { channel: "agent", publicToolKey: "propose_test", agentRunId: runA.id } },
          TEST_ACTION_KEY,
          {},
        ),
      ).rejects.toMatchObject({ code: "NEEDS_USER_CONFIRMATION" });

      // ════════════ §7 web channel 无事件 → 不受影响（成功） ════════════
      // web channel（GenUI 点击本身就是可信用户动作）不消费事件。
      const webProposal = await createAgentProposal(
        { actor: adminActor, invocation: { channel: "web" } },
        TEST_ACTION_KEY,
        {},
      );
      expect(webProposal.status).toBe("PENDING");
      expect(webProposal.agentRunId).toBeNull();

      // web channel 也不该消费任何已颁发的事件
      const webRun = await prisma.agentRun.create({
        data: { userId: admin.id, role: "ADMIN", status: "ACTIVE", source: "CHAT" },
      });
      await issueConfirmationEvent({
        actor: adminActor,
        agentRunId: webRun.id,
        targetIntent: TEST_ACTION_KEY,
        idempotencyKey: "p13-key-web00001",
      });
      const webProposal2 = await createAgentProposal(
        { actor: adminActor, invocation: { channel: "web" } },
        TEST_ACTION_KEY,
        {},
      );
      expect(webProposal2.status).toBe("PENDING");
      // 该事件应仍未被消费（web channel 不消费）
      const webEvent = await prisma.agentUserConfirmationEvent.findUnique({
        where: { idempotencyKey: "p13-key-web00001" },
      });
      expect(webEvent?.consumedAt).toBeNull();

      // ════════════ §8 service：他人 runId → NotFound（合并语义，防存在性泄露） ════════════
      await expect(
        issueConfirmationEvent({
          actor: adminActor,
          agentRunId: otherRun.id,
          targetIntent: TEST_ACTION_KEY,
          idempotencyKey: "p13-key-crossxxx",
        }),
      ).rejects.toMatchObject({ httpStatus: 404 });

      // 不存在的 runId 也 → 404（不区分「不存在」与「越权」）
      await expect(
        issueConfirmationEvent({
          actor: adminActor,
          agentRunId: "nonexistent-run-id",
          targetIntent: TEST_ACTION_KEY,
          idempotencyKey: "p13-key-nonexist1",
        }),
      ).rejects.toMatchObject({ httpStatus: 404 });

      // ════════════ §9 service：幂等重发同 key 返回同事件 ════════════
      const idemRun = await prisma.agentRun.create({
        data: { userId: admin.id, role: "ADMIN", status: "ACTIVE", source: "CHAT" },
      });
      const idemKey = "p13-key-idempotnt";
      const first = await issueConfirmationEvent({
        actor: adminActor,
        agentRunId: idemRun.id,
        targetIntent: TEST_ACTION_KEY,
        idempotencyKey: idemKey,
      });
      const second = await issueConfirmationEvent({
        actor: adminActor,
        agentRunId: idemRun.id,
        targetIntent: TEST_ACTION_KEY,
        idempotencyKey: idemKey,
      });
      expect(second.id).toBe(first.id);
      expect(second.created).toBe(false); // 幂等命中既有事件
      // 数据库只有一行（unique 约束生效）
      const rows = await prisma.agentUserConfirmationEvent.findMany({
        where: { idempotencyKey: idemKey },
      });
      expect(rows.length).toBe(1);

      // ════════════ §10 service：已消费后重发同 key → 409 ════════════
      // 先消费 first 事件（创建 proposal）
      await createAgentProposal(
        { actor: adminActor, invocation: { channel: "agent", publicToolKey: "propose_test", agentRunId: idemRun.id } },
        TEST_ACTION_KEY,
        {},
      );
      await expect(
        issueConfirmationEvent({
          actor: adminActor,
          agentRunId: idemRun.id,
          targetIntent: TEST_ACTION_KEY,
          idempotencyKey: idemKey,
        }),
      ).rejects.toMatchObject({ httpStatus: 409 });

      // ════════════ §11 service：校验 — 缺字段 / 长度非法 → ValidationError ════════════
      await expect(
        issueConfirmationEvent({
          actor: adminActor,
          agentRunId: "",
          targetIntent: TEST_ACTION_KEY,
          idempotencyKey: "p13-key-valid0001",
        }),
      ).rejects.toMatchObject({ httpStatus: 400 });

      await expect(
        issueConfirmationEvent({
          actor: adminActor,
          agentRunId: runA.id,
          targetIntent: "",
          idempotencyKey: "p13-key-valid0002",
        }),
      ).rejects.toMatchObject({ httpStatus: 400 });

      // idempotencyKey 太短（< 8）
      await expect(
        issueConfirmationEvent({
          actor: adminActor,
          agentRunId: runA.id,
          targetIntent: TEST_ACTION_KEY,
          idempotencyKey: "short",
        }),
      ).rejects.toMatchObject({ httpStatus: 400 });

      // ════════════ §12 路由：POST /api/agent/confirmation-events ════════════
      const { POST } = await import("@/app/api/agent/confirmation-events/route");

      const jsonReq = (body: unknown) =>
        new Request("http://localhost/api/agent/confirmation-events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const toJson = async (res: Response) => ({ status: res.status, body: await res.json() });

      // 未登录 → 401
      sessionState.current = null;
      const r401 = await POST(jsonReq({ agentRunId: runA.id, targetIntent: TEST_ACTION_KEY, idempotencyKey: "p13-route-0001" }) as never);
      expect(r401.status).toBe(401);

      // 登录 admin
      sessionState.current = {
        user: { id: admin.id, role: admin.role, name: "P13Admin", email: "p13-admin@t.test" },
      };

      // 缺字段 → 400
      const r400Missing = await toJson(
        await POST(jsonReq({ agentRunId: runA.id, targetIntent: TEST_ACTION_KEY }) as never),
      );
      expect(r400Missing.status).toBe(400);
      expect(r400Missing.body.code).toBe("INVALID_INPUT");

      // idempotencyKey 太短 → 400
      const r400Short = await toJson(
        await POST(jsonReq({ agentRunId: runA.id, targetIntent: TEST_ACTION_KEY, idempotencyKey: "short" }) as never),
      );
      expect(r400Short.status).toBe(400);

      // 他人 runId → 404（NotFound 合并语义）
      const r404 = await toJson(
        await POST(jsonReq({ agentRunId: otherRun.id, targetIntent: TEST_ACTION_KEY, idempotencyKey: "p13-route-0002" }) as never),
      );
      expect(r404.status).toBe(404);

      // 正常首次颁发 → 201
      const routeRun = await prisma.agentRun.create({
        data: { userId: admin.id, role: "ADMIN", status: "ACTIVE", source: "CHAT" },
      });
      const r201 = await toJson(
        await POST(jsonReq({ agentRunId: routeRun.id, targetIntent: TEST_ACTION_KEY, idempotencyKey: "p13-route-0003" }) as never),
      );
      expect(r201.status).toBe(201);
      expect(r201.body.ok).toBe(true);
      expect(r201.body.event.targetIntent).toBe(TEST_ACTION_KEY);
      const routeEventId = r201.body.event.id;

      // 幂等重发同 key → 200，返回同事件
      const r200 = await toJson(
        await POST(jsonReq({ agentRunId: routeRun.id, targetIntent: TEST_ACTION_KEY, idempotencyKey: "p13-route-0003" }) as never),
      );
      expect(r200.status).toBe(200);
      expect(r200.body.event.id).toBe(routeEventId);

      // 消费该事件后重发同 key → 409
      await createAgentProposal(
        { actor: adminActor, invocation: { channel: "agent", publicToolKey: "propose_test", agentRunId: routeRun.id } },
        TEST_ACTION_KEY,
        {},
      );
      const r409 = await toJson(
        await POST(jsonReq({ agentRunId: routeRun.id, targetIntent: TEST_ACTION_KEY, idempotencyKey: "p13-route-0003" }) as never),
      );
      expect(r409.status).toBe(409);
      expect(r409.body.code).toBe("ALREADY_CONSUMED");

      // 非 JSON body → 400
      const badReq = new Request("http://localhost/api/agent/confirmation-events", {
        method: "POST",
        body: "not-json{{{",
      });
      const r400BadJson = await toJson(await POST(badReq as never));
      expect(r400BadJson.status).toBe(400);

      // body 不是对象 → 400
      const r400Arr = await toJson(
        await POST(jsonReq([1, 2, 3]) as never),
      );
      expect(r400Arr.status).toBe(400);

      // ════════════════════════════════════════════════════════════════════
      // 问题 4：幂等键完整 tuple 校验 + 并发 P2002 重读 + 单条消费
      // ════════════════════════════════════════════════════════════════════
      const { ConflictError } = await import("@/lib/application/errors");

      // ── §A 幂等命中 tuple 不匹配 → 409 ConflictError ──
      // 同 actor + 同 idempotencyKey，但 agentRunId 不同 → 409
      const tupleRun = await prisma.agentRun.create({
        data: { userId: admin.id, role: "ADMIN", status: "ACTIVE", source: "CHAT" },
      });
      await issueConfirmationEvent({
        actor: adminActor,
        agentRunId: tupleRun.id,
        targetIntent: TEST_ACTION_KEY,
        idempotencyKey: "p13-tuple-keyaaaa",
      });
      await expect(
        issueConfirmationEvent({
          actor: adminActor,
          agentRunId: runA.id, // 不同的 run
          targetIntent: TEST_ACTION_KEY,
          idempotencyKey: "p13-tuple-keyaaaa", // 同 key
        }),
      ).rejects.toBeInstanceOf(ConflictError);

      // targetIntent 不同 → 409
      const tupleRun2 = await prisma.agentRun.create({
        data: { userId: admin.id, role: "ADMIN", status: "ACTIVE", source: "CHAT" },
      });
      await issueConfirmationEvent({
        actor: adminActor,
        agentRunId: tupleRun2.id,
        targetIntent: TEST_ACTION_KEY,
        idempotencyKey: "p13-tuple-keybbbb",
      });
      await expect(
        issueConfirmationEvent({
          actor: adminActor,
          agentRunId: tupleRun2.id,
          targetIntent: "contracts.generate", // 不同的 targetIntent
          idempotencyKey: "p13-tuple-keybbbb",
        }),
      ).rejects.toBeInstanceOf(ConflictError);

      // ── §B 并发 P2002 重读：先直接 create 同 key，再 issue 同 key 同 tuple → created:false ──
      // 模拟并发输家路径：DB 中已有同 key + 同 tuple 的事件，issue 重读后返回既有。
      const p2002Run = await prisma.agentRun.create({
        data: { userId: admin.id, role: "ADMIN", status: "ACTIVE", source: "CHAT" },
      });
      await prisma.agentUserConfirmationEvent.create({
        data: {
          actorUserId: admin.id,
          agentRunId: p2002Run.id,
          targetIntent: TEST_ACTION_KEY,
          action: "create_proposal",
          idempotencyKey: "p13-p2002-keyccc",
        },
      });
      const reread = await issueConfirmationEvent({
        actor: adminActor,
        agentRunId: p2002Run.id,
        targetIntent: TEST_ACTION_KEY,
        idempotencyKey: "p13-p2002-keyccc",
      });
      expect(reread.created).toBe(false);
      const rowsP2002 = await prisma.agentUserConfirmationEvent.findMany({
        where: { idempotencyKey: "p13-p2002-keyccc" },
      });
      expect(rowsP2002.length).toBe(1);

      // P2002 重读时 tuple 不匹配 → 409
      await prisma.agentUserConfirmationEvent.create({
        data: {
          actorUserId: admin.id,
          agentRunId: p2002Run.id,
          targetIntent: TEST_ACTION_KEY,
          action: "create_proposal",
          idempotencyKey: "p13-p2002-keyddd",
        },
      });
      await expect(
        issueConfirmationEvent({
          actor: adminActor,
          agentRunId: p2002Run.id,
          targetIntent: "contracts.generate", // tuple 不匹配
          idempotencyKey: "p13-p2002-keyddd",
        }),
      ).rejects.toBeInstanceOf(ConflictError);

      // ── §C 同 intent 颁发两个事件 → 一次 proposal 只消费一条 ──
      const multiRun = await prisma.agentRun.create({
        data: { userId: admin.id, role: "ADMIN", status: "ACTIVE", source: "CHAT" },
      });
      const ev1 = await issueConfirmationEvent({
        actor: adminActor,
        agentRunId: multiRun.id,
        targetIntent: TEST_ACTION_KEY,
        idempotencyKey: "p13-multi-keyeeee",
      });
      const ev2 = await issueConfirmationEvent({
        actor: adminActor,
        agentRunId: multiRun.id,
        targetIntent: TEST_ACTION_KEY,
        idempotencyKey: "p13-multi-keyffff",
      });
      expect(ev1.id).not.toBe(ev2.id);

      await createAgentProposal(
        { actor: adminActor, invocation: { channel: "agent", publicToolKey: "propose_test", agentRunId: multiRun.id } },
        TEST_ACTION_KEY,
        {},
      );
      const afterFirst1 = await prisma.agentUserConfirmationEvent.findUnique({ where: { id: ev1.id } });
      const afterFirst2 = await prisma.agentUserConfirmationEvent.findUnique({ where: { id: ev2.id } });
      expect(afterFirst1?.consumedAt).not.toBeNull();
      expect(afterFirst2?.consumedAt).toBeNull();

      await createAgentProposal(
        { actor: adminActor, invocation: { channel: "agent", publicToolKey: "propose_test", agentRunId: multiRun.id } },
        TEST_ACTION_KEY,
        {},
      );
      const afterSecond2 = await prisma.agentUserConfirmationEvent.findUnique({ where: { id: ev2.id } });
      expect(afterSecond2?.consumedAt).not.toBeNull();

      await expect(
        createAgentProposal(
          { actor: adminActor, invocation: { channel: "agent", publicToolKey: "propose_test", agentRunId: multiRun.id } },
          TEST_ACTION_KEY,
          {},
        ),
      ).rejects.toMatchObject({ code: "NEEDS_USER_CONFIRMATION" });

      // ── §D 回归：跨 run 事件不互消费 ──
      const crossRunA = await prisma.agentRun.create({
        data: { userId: admin.id, role: "ADMIN", status: "ACTIVE", source: "CHAT" },
      });
      const crossRunB = await prisma.agentRun.create({
        data: { userId: admin.id, role: "ADMIN", status: "ACTIVE", source: "CHAT" },
      });
      await issueConfirmationEvent({
        actor: adminActor,
        agentRunId: crossRunA.id,
        targetIntent: TEST_ACTION_KEY,
        idempotencyKey: "p13-cross-keygggg",
      });
      await issueConfirmationEvent({
        actor: adminActor,
        agentRunId: crossRunB.id,
        targetIntent: TEST_ACTION_KEY,
        idempotencyKey: "p13-cross-keyhhhh",
      });
      await createAgentProposal(
        { actor: adminActor, invocation: { channel: "agent", publicToolKey: "propose_test", agentRunId: crossRunA.id } },
        TEST_ACTION_KEY,
        {},
      );
      const crossRunBEvent = await prisma.agentUserConfirmationEvent.findUnique({
        where: { idempotencyKey: "p13-cross-keyhhhh" },
      });
      expect(crossRunBEvent?.consumedAt).toBeNull();
    });
  });
});
