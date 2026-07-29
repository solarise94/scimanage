/**
 * P1-2 #5 断链修复测试：propose_receipt facade → create_receipt service。
 *
 * 覆盖（docs/agent-public-surface-cleanup-plan-2026-07-26.md P1-2 #5）：
 *  - 精确唯一匹配（单候选 outstanding === amountCents）→ 自动产 PENDING proposal；
 *  - 多候选 → needs_selection + 候选发票列表；
 *  - 用户传 selectedOptionId（∈ 候选）→ 产 proposal；
 *  - 无效 selectedOptionId（不在候选集）→ needs_input（facade）/ 404（service 重跑）；
 *  - allocations 旧路径不 regress（Web 直传 allocations 仍可用）；
 *  - proposal 内容（title/summary）含最终选定候选发票与金额；
 *  - modelFacing 文案无 internal action key（finance./crm. 前缀）。
 *
 * 全部场景共享单个 withTempSmokeDb 临时库。
 * ⚠️ 顶层 type-only import + vi.mock（与 phase-c3 一致）。
 */
import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";
import type { PrismaClient } from "@prisma/client";
import type { BusinessActor, AgentExecutionContext } from "@/lib/application/actor";

/**
 * P1-3 适配：channel="agent" 的 proposal 创建必须消费 AgentUserConfirmationEvent。
 */
const agentInv = (over: Partial<{ agentRunId: string }> = {}) => ({
  channel: "agent" as const,
  ...(over.agentRunId ? { agentRunId: over.agentRunId } : {}),
});

let eventSeed = 0;
function seedConfirmationEvent(
  prisma: PrismaClient,
  opts: { actorUserId: string; agentRunId: string; targetIntent: string },
): Promise<unknown> {
  eventSeed += 1;
  return prisma.agentUserConfirmationEvent.create({
    data: {
      actorUserId: opts.actorUserId,
      agentRunId: opts.agentRunId,
      targetIntent: opts.targetIntent,
      action: "create_proposal",
      idempotencyKey: `rcpt-seed-${process.pid}-${eventSeed}-${Date.now()}`,
    },
  });
}

describe("P1-2 #5 propose_receipt 断链修复", () => {
  it("exact unique auto-proposal / multi needsSelection / selectedOptionId / invalid rejected / allocations regress / proposal content", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { hashSync } = await import("bcryptjs");
      const { executePublicTool, __clearPublicFacadeRegistryForTests } = await import(
        "@/lib/agent-actions/public/public-executor"
      );
      const { __resetPublicReadFacadesForTests, registerPublicReadFacades } = await import(
        "@/lib/agent-actions/public/facades"
      );
      const { ensureBuiltinAgentActionsRegistered } = await import("@/lib/agent-actions/registry");
      const { confirmAgentProposal } = await import("@/lib/agent-actions/proposals");
      const { executeAgentAction } = await import("@/lib/agent-actions/registry");

      __clearPublicFacadeRegistryForTests();
      __resetPublicReadFacadesForTests();
      ensureBuiltinAgentActionsRegistered();
      registerPublicReadFacades();

      const admin = await prisma.user.create({
        data: { email: "rcpt-admin@t.test", name: "RcptAdmin", password: hashSync("x", 4), role: "ADMIN" },
      });
      const adminActor: BusinessActor = { userId: admin.id, role: "ADMIN" };
      const adminCtx: AgentExecutionContext = { actor: adminActor, invocation: { channel: "agent" } };

      // ── 公共 fixture：机构 + 客户 + 订单 ──
      const org = await prisma.organization.create({
        data: { orgCode: "RCPT-ORG", canonicalName: "回款单位", normalizedName: "回款单位" },
      });
      const profile = await prisma.crmCustomerProfile.create({
        data: { name: "回款客户", ownerUserId: admin.id },
      });
      const order = await prisma.order.create({
        data: {
          orderNo: "RCPT-ORD-1",
          title: "回款测试订单",
          status: "CONFIRMED",
          totalAmount: 100_000,
          profileId: profile.id,
          buyerOrganizationId: org.id,
          createdById: admin.id,
          technicalOwnerUserId: admin.id,
        },
      });

      /** 建一张 ISSUED 发票（指定 totalAmount + outstanding 起始 = totalAmount）。 */
      async function makeIssuedInvoice(totalAmountCents: number, suffix: string) {
        const inv = await prisma.externalOrderInvoiceRequest.create({
          data: {
            orderId: order.id,
            status: "ISSUED",
            totalAmount: totalAmountCents,
            buyerOrganizationId: org.id,
            buyerOrganizationName: "回款单位",
            actualInvoiceNo: `INV-${suffix}`,
            createdById: admin.id,
          },
        });
        await prisma.orderInvoiceCoverage.create({
          data: { invoiceRequestId: inv.id, orderId: order.id, amount: totalAmountCents },
        });
        return inv;
      }

      // ────────────────────────────────────────────────────────────────────
      // 1. 精确唯一匹配：单候选 outstanding === amountCents → 自动产 PENDING proposal
      // ────────────────────────────────────────────────────────────────────
      {
        const inv = await makeIssuedInvoice(30_000, "EXACT-1");
        await seedConfirmationEvent(prisma, {
          actorUserId: admin.id,
          agentRunId: "rcpt-exact",
          targetIntent: "finance.create_receipt",
        });

        const receiptsBefore = await prisma.financeReceipt.count();

        const outcome = await executePublicTool({
          actor: adminActor,
          invocation: agentInv({ agentRunId: "rcpt-exact" }),
          publicToolKey: "propose_receipt",
          publicInput: { organizationId: org.id, amountYuan: 300 },
        });
        expect(outcome.ok, `propose_receipt exact failed: ${JSON.stringify(outcome.ok ? null : outcome)}`).toBe(true);
        if (!outcome.ok) throw new Error(`propose_receipt exact failed: ${JSON.stringify(outcome)}`);

        // mode 应为 proposal（产了 PENDING proposal）
        expect(outcome.result.mode).toBe("proposal");

        const facing = outcome.result.modelFacing as {
          proposal?: { id?: string; title?: string; summary?: string };
        };
        expect(facing.proposal?.id, "exact match 应产 PENDING proposal").toBeTruthy();

        // proposal 内容应含候选发票号与金额（P1-2 #8）
        const summary = facing.proposal?.summary ?? "";
        expect(summary).toContain("300.00");
        // proposal title/summary 文案无 internal action key（actionKey 字段是审计元数据，不算文案）
        expect(facing.proposal?.title ?? "").not.toMatch(/finance\.\w+/);
        expect(summary).not.toMatch(/finance\.\w+/);

        // preview 不写业务表
        const receiptsAfterPreview = await prisma.financeReceipt.count();
        expect(receiptsAfterPreview).toBe(receiptsBefore);

        // confirm 后写一次
        await confirmAgentProposal(
          { actor: adminActor, invocation: agentInv({ agentRunId: "rcpt-exact" }) },
          facing.proposal!.id!,
        );
        const receiptsAfterConfirm = await prisma.financeReceipt.count();
        expect(receiptsAfterConfirm).toBe(receiptsBefore + 1);

        // 核销后验证 FinanceReceiptAllocation 落库（invoiceId 关联）
        const allocs = await prisma.financeReceiptAllocation.findMany({
          where: { invoiceId: inv.id },
        });
        expect(allocs.length).toBeGreaterThan(0);
      }

      // ────────────────────────────────────────────────────────────────────
      // 2. 多候选 → needs_selection + 候选发票列表
      // ────────────────────────────────────────────────────────────────────
      {
        // 建 2 张发票，各 outstanding 400，amountYuan=400 会产生多组合匹配
        await makeIssuedInvoice(40_000, "MULTI-A");
        await makeIssuedInvoice(40_000, "MULTI-B");

        const outcome = await executePublicTool({
          actor: adminActor,
          invocation: agentInv({ agentRunId: "rcpt-multi" }),
          publicToolKey: "propose_receipt",
          publicInput: { organizationId: org.id, amountYuan: 400 },
        });
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) throw new Error(`propose_receipt multi failed: ${JSON.stringify(outcome)}`);

        // mode 应为 needs_input（多候选 needsSelection）
        expect(outcome.result.mode).toBe("needs_input");
        expect(outcome.result.needsSelection).toBe(true);

        const facing = outcome.result.modelFacing as {
          candidates?: Array<{ invoiceId: string; outstanding: number }>;
          optionType?: string;
        };
        expect(facing.candidates?.length, "多候选应返回候选列表").toBeGreaterThan(1);
        expect(facing.optionType).toBe("invoice");

        // nextStep 文案无 internal action key
        const nextStep = (facing as { nextStep?: string }).nextStep ?? "";
        expect(nextStep).not.toMatch(/finance\.\w+/);
      }

      // ────────────────────────────────────────────────────────────────────
      // 3. 用户传 selectedOptionId（∈ 候选）→ 产 proposal
      // ────────────────────────────────────────────────────────────────────
      {
        // 用一张新的精确匹配发票（避免被场景 2 的候选干扰）
        const inv = await makeIssuedInvoice(50_000, "SELECT-1");
        // 先 match 拿候选 id
        const matchOutcome = await executeAgentAction(adminCtx, "finance.match_payment", {
          organizationId: org.id,
          amount: 500,
        });
        const matchResult = matchOutcome.result as {
          candidateInvoices?: Array<{ id: string; outstanding: number }>;
        };
        const candidate = matchResult.candidateInvoices?.find((c) => c.id === inv.id);
        expect(candidate, "SELECT-1 发票应在 match 候选中").toBeTruthy();

        await seedConfirmationEvent(prisma, {
          actorUserId: admin.id,
          agentRunId: "rcpt-select",
          targetIntent: "finance.create_receipt",
        });

        const outcome = await executePublicTool({
          actor: adminActor,
          invocation: agentInv({ agentRunId: "rcpt-select" }),
          publicToolKey: "propose_receipt",
          publicInput: {
            organizationId: org.id,
            amountYuan: 500,
            selectedOptionId: inv.id,
          },
        });
        expect(outcome.ok, `propose_receipt selected failed: ${JSON.stringify(outcome.ok ? null : outcome)}`).toBe(true);
        if (!outcome.ok) throw new Error(`propose_receipt selected failed: ${JSON.stringify(outcome)}`);

        expect(outcome.result.mode).toBe("proposal");
        const facing = outcome.result.modelFacing as { proposal?: { id?: string } };
        expect(facing.proposal?.id).toBeTruthy();
      }

      // ────────────────────────────────────────────────────────────────────
      // 4. 无效 selectedOptionId（不在候选集）→ facade 返回 needs_input；
      //    service 直调 buildProposal 重跑 match → 404 NotFoundError
      // ────────────────────────────────────────────────────────────────────
      {
        // 先 match 拿到候选集（此时已有发票）
        const matchOutcome = await executeAgentAction(adminCtx, "finance.match_payment", {
          organizationId: org.id,
          amount: 500,
        });
        const matchResult = matchOutcome.result as {
          candidateInvoices?: Array<{ id: string }>;
        };
        const candidateIds = new Set((matchResult.candidateInvoices ?? []).map((c) => c.id));

        // 用一个不在候选的随机 id
        const fakeId = "clxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
        expect(candidateIds.has(fakeId)).toBe(false);

        const outcome = await executePublicTool({
          actor: adminActor,
          invocation: agentInv({ agentRunId: "rcpt-invalid" }),
          publicToolKey: "propose_receipt",
          publicInput: {
            organizationId: org.id,
            amountYuan: 500,
            selectedOptionId: fakeId,
          },
        });
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) throw new Error(`propose_receipt invalid failed: ${JSON.stringify(outcome)}`);

        // facade 层：selectedOptionId 不在候选 → needs_input（不调 create_receipt）
        expect(outcome.result.mode).toBe("needs_input");
        expect(outcome.result.needsSelection).toBe(true);

        // service 层：create_receipt 直传无效 selectedOptionId → buildProposal 重跑 match 找不到 → 404
        const { getAgentAction } = await import("@/lib/agent-actions/registry");
        const action = getAgentAction("finance.create_receipt")!;
        const parsedInvalid = action.parseInput({
          amount: 500,
          receivedAt: new Date().toISOString(),
          organizationId: org.id,
          selectedOptionId: "00000000-0000-0000-0000-000000000000",
        });
        await expect(
          action.buildProposal!(
            { ...adminCtx, invocation: agentInv({ agentRunId: "rcpt-invalid-svc" }) },
            parsedInvalid,
          ),
        ).rejects.toThrow();
      }

      // ────────────────────────────────────────────────────────────────────
      // 5. allocations 旧路径不 regress（Web 直传 allocations 仍可用）
      //    验证 parseInput 接受 allocations、buildProposal 用 allocations 产 preview
      // ────────────────────────────────────────────────────────────────────
      {
        const inv = await makeIssuedInvoice(60_000, "ALLOC-1");
        const { getAgentAction } = await import("@/lib/agent-actions/registry");
        const action = getAgentAction("finance.create_receipt")!;

        // parseInput 接受 allocations（旧路径）
        const parsed = action.parseInput({
          amount: 600,
          receivedAt: new Date().toISOString(),
          organizationId: org.id,
          allocations: [{ invoiceId: inv.id, amount: 600 }],
        }) as { allocations?: unknown[]; selectedOptionId?: string };
        expect(parsed.allocations?.length).toBe(1);
        expect(parsed.selectedOptionId).toBeUndefined();

        // buildProposal 用 allocations 产 preview（不抛错 = allocations 路径可用）
        const preview = await action.buildProposal!(
          { ...adminCtx, invocation: agentInv({ agentRunId: "rcpt-alloc" }) },
          parsed,
        );
        expect(preview).toBeTruthy();
        expect((preview as { title?: string }).title).toContain("回款");
      }

      // ────────────────────────────────────────────────────────────────────
      // 6. 无候选（NO_EXACT_MATCH，无可核销发票）→ needs_input
      // ────────────────────────────────────────────────────────────────────
      {
        // 用一个无发票的机构
        const emptyOrg = await prisma.organization.create({
          data: { orgCode: "RCPT-EMPTY", canonicalName: "空机构", normalizedName: "空机构" },
        });
        const outcome = await executePublicTool({
          actor: adminActor,
          invocation: agentInv({ agentRunId: "rcpt-empty" }),
          publicToolKey: "propose_receipt",
          publicInput: { organizationId: emptyOrg.id, amountYuan: 100 },
        });
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) throw new Error(`propose_receipt empty failed: ${JSON.stringify(outcome)}`);

        expect(outcome.result.mode).toBe("needs_input");
        expect(outcome.result.needsUserInput).toBe(true);
      }
    });
  });
});
