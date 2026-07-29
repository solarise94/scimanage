/**
 * Phase B tests: read facade + REP/RM projection + find_with_financial_view。
 *
 * 全部场景共享单个 withTempSmokeDb 临时库（与 parity 惯例一致）。
 * ⚠️ 顶层只允许 type-only import：executePublicTool / registerPublicReadFacades 经
 * registry → actions → 触发 @/lib/prisma 实例化，必须在 withTempSmokeDb 内动态 import，
 * 否则 prisma 单例锁定到真实 dev.db（详见 temp-smoke-db 顶部约束）。
 */
import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";
import type { BusinessActor, AgentExecutionContext } from "@/lib/application/actor";

describe("Phase B — read facades + find_with_financial_view + REP/RM projection", () => {
  it("implemented flip, find_with_financial_view 3 views, facade id passthrough, REP projection, REP unavailable", async () => {
    await withTempSmokeDb(async () => {
      // 动态 import：避免 prisma 单例在 withTempSmokeDb 之前锁定。
      const { prisma } = await import("@/lib/prisma");
      const { hashSync } = await import("bcryptjs");
      const { executeAgentAction, ensureBuiltinAgentActionsRegistered, getAgentAction } = await import(
        "@/lib/agent-actions/registry"
      );
      const { executePublicTool, __clearPublicFacadeRegistryForTests } = await import(
        "@/lib/agent-actions/public/public-executor"
      );
      const { __resetPublicReadFacadesForTests, registerPublicReadFacades } = await import(
        "@/lib/agent-actions/public/facades"
      );
      const { PUBLIC_TOOL_MANIFEST } = await import("@/lib/agent-actions/public/manifest");

      // ── P2-2：manifest implemented 静态全 true（不再由注册翻转） ──
      __clearPublicFacadeRegistryForTests();
      __resetPublicReadFacadesForTests();
      registerPublicReadFacades();
      const implemented = PUBLIC_TOOL_MANIFEST.filter((e) => e.implemented).map((e) => e.publicTool);
      expect(implemented).toContain("find_orders");
      expect(implemented).toContain("get_order");
      expect(implemented).toContain("get_invoice");
      // Phase C 后 propose_order 也已实现
      expect(implemented).toContain("propose_order");
      // P2-2：全部 28 个 tool 都应 implemented（静态声明）
      expect(implemented.length).toBe(PUBLIC_TOOL_MANIFEST.length);

      // ── fixtures ──
      const admin = await prisma.user.create({
        data: { email: "admin-fv@t.test", name: "Admin", password: hashSync("x", 4), role: "ADMIN" },
      });
      const repUser = await prisma.user.create({
        data: { email: "rep-fv@t.test", name: "Rep", password: hashSync("x", 4), role: "REPRESENTATIVE" },
      });
      await prisma.representative.create({ data: { name: "Rep", email: "rep-fv@t.test", kind: "HUMAN" } });

      const profile = await prisma.crmCustomerProfile.create({
        data: { name: "FV客户", ownerUserId: admin.id, assignmentStatus: "ASSIGNED" },
      });
      const repProfile = await prisma.crmCustomerProfile.create({
        data: { name: "REP客户", ownerUserId: repUser.id, assignmentStatus: "ASSIGNED" },
      });
      // 部门隔离 Phase 4：可见性以部门 CLAIMED state 为准；raw fixture 需回填 state
      // （ASSIGNED+owner → FIELD_SALES CLAIMED，可见范围与旧语义等价）。
      const { backfillDepartmentStates } = await import("../scripts/lib/department-states");
      await backfillDepartmentStates(prisma, { apply: true });
      await prisma.order.create({
        data: { orderNo: "ORD-FV-1", title: "财务视图测试", totalAmount: 100000, status: "CONFIRMED", profileId: profile.id, createdById: admin.id },
      });
      const repOrder = await prisma.order.create({
        data: { orderNo: "ORD-REP-1", title: "rep 订单", totalAmount: 80000, status: "CONFIRMED", profileId: repProfile.id, createdById: repUser.id },
      });

      ensureBuiltinAgentActionsRegistered();
      registerPublicReadFacades();

      const adminActor: BusinessActor = { userId: admin.id, role: "ADMIN" };
      const adminCtx: AgentExecutionContext = { actor: adminActor, invocation: { channel: "agent" } };

      // ── find_with_financial_view: any/pending/settled ──
      const anyResult = await executeAgentAction(adminCtx, "orders.find_with_financial_view", { financialView: "any" });
      const anyOut = anyResult.result as { financialView: string; items: Array<{ id: string }> };
      expect(anyOut.financialView).toBe("any");
      expect(anyOut.items.some((o) => o.id)).toBe(true);

      const pendingResult = await executeAgentAction(adminCtx, "orders.find_with_financial_view", { financialView: "pending_receipt" });
      const pendingOut = pendingResult.result as { financialView: string; truncated: boolean };
      expect(pendingOut.financialView).toBe("pending_receipt");
      expect(pendingOut).toHaveProperty("truncated");

      const settledResult = await executeAgentAction(adminCtx, "orders.find_with_financial_view", { financialView: "settled" });
      const settledOut = settledResult.result as { financialView: string; items: unknown[] };
      expect(settledOut.financialView).toBe("settled");
      expect(settledOut.items.length).toBe(0);

      // ── find_with_financial_view REP 不可用 ──
      const fvAction = getAgentAction("orders.find_with_financial_view")!;
      expect(await fvAction.availability({ userId: repUser.id, role: "REPRESENTATIVE" })).toBe(false);
      expect(await fvAction.availability({ userId: admin.id, role: "ADMIN" })).toBe(true);

      // ── public find_orders facade（内部员工）：透传真实 orderId ──
      const foOutcome = await executePublicTool({
        actor: adminActor,
        invocation: { channel: "agent", agentRunId: "run-fo" },
        publicToolKey: "find_orders",
        publicInput: { financialView: "any" },
      });
      expect(foOutcome.ok).toBe(true);
      if (foOutcome.ok) {
        const facing = foOutcome.result.modelFacing as { items: Array<{ orderId: string }> };
        expect(facing.items.length).toBeGreaterThan(0);
        // facade 透传真实 id（非 opaque token）；service scope gate 负责授权。
        expect(typeof facing.items[0].orderId).toBe("string");
        expect(facing.items[0].orderId.length).toBeGreaterThan(0);
      }

      // ── P1：publicToolKey 写入 AgentActionLog（受控元数据，非模型输入）──
      const foLog = await prisma.agentActionLog.findFirst({
        where: { actionKey: "orders.find_with_financial_view", userId: admin.id },
        orderBy: { createdAt: "desc" },
      });
      expect(foLog?.publicToolKey).toBe("find_orders");

      // 直调 internal action 不写 publicToolKey
      await executeAgentAction(adminCtx, "orders.find_with_financial_view", { financialView: "any" });
      const directLog = await prisma.agentActionLog.findFirst({
        where: {
          actionKey: "orders.find_with_financial_view",
          userId: admin.id,
          publicToolKey: null,
        },
        orderBy: { createdAt: "desc" },
      });
      expect(directLog).toBeTruthy();
      expect(directLog?.publicToolKey).toBeNull();

      // ── public find_orders facade（REP）：忽略 financialView ──
      const repOutcome = await executePublicTool({
        actor: { userId: repUser.id, role: "REPRESENTATIVE" },
        invocation: { channel: "agent", agentRunId: "run-rep" },
        publicToolKey: "find_orders",
        publicInput: { financialView: "settled" },
      });
      expect(repOutcome.ok).toBe(true);
      if (repOutcome.ok) {
        const facing = repOutcome.result.modelFacing as { financialView?: string };
        expect(facing.financialView).toBeUndefined();
      }

      // ── public find_customers facade：透传真实 profileId ──
      // （2026-07-27 demo flag-on 实测 bug：facade 误读 id/name，模型侧 customerId 全空）
      const fcOutcome = await executePublicTool({
        actor: adminActor,
        invocation: { channel: "agent", agentRunId: "run-fc" },
        publicToolKey: "find_customers",
        publicInput: { query: "FV" },
      });
      expect(fcOutcome.ok).toBe(true);
      if (fcOutcome.ok) {
        const facing = fcOutcome.result.modelFacing as {
          items: Array<{ customerId: string; name?: string }>;
        };
        expect(facing.items.length).toBeGreaterThan(0);
        expect(facing.items[0].customerId).toBe(profile.id);
        expect(facing.items[0].name).toBe("FV客户");
      }

      // ── REP get_order receiptState 投影（剥金额）──
      // 直接传真实 orderId（ref 体系已删；授权由 service scope gate 拦截）。
      const goOutcome = await executePublicTool({
        actor: { userId: repUser.id, role: "REPRESENTATIVE" },
        invocation: { channel: "agent", agentRunId: "run-rs" },
        publicToolKey: "get_order",
        publicInput: { orderId: repOrder.id },
      });
      expect(goOutcome.ok).toBe(true);
      if (goOutcome.ok) {
        const orderPayload = goOutcome.result.modelFacing as { order: Record<string, unknown> };
        expect(orderPayload.order.totalAmount).toBeUndefined();
        expect(orderPayload.order.finance).toBeUndefined();
        // 有效财务金额>0且回款=0 → UNPAID
        expect(orderPayload.order.receiptState).toBe("UNPAID");
      }
    });
  });
});
