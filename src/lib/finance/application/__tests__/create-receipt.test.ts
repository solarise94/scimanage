import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent" },
});

/**
 * T6.5: actor-aware create receipt shared by Web POST /api/finance/receipts
 * (allocation branch) and Agent finance.create_receipt. Covers capability,
 * success path, partial touched-order scope → NotFound without leak, and
 * Agent/Web parity for core receipt fields.
 */
describe("T6.5 create receipt", () => {
  it("enforces capability, scope, receipt success, and Agent/Web parity", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { ForbiddenError, NotFoundError } = await import("@/lib/application/errors");
      const {
        createReceiptForActor,
        previewCreateReceiptForActor,
      } = await import("@/lib/finance/application/create-receipt");
      const { executeAgentAction } = await import("@/lib/agent-actions/registry");

      const admin = await prisma.user.create({
        data: { email: "t65-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const userA = await prisma.user.create({
        data: { email: "t65-usera@example.com", name: "UserA", password: "h", role: "USER" },
      });
      const rep = await prisma.user.create({
        data: { email: "t65-rep@example.com", name: "Rep", password: "h", role: "REPRESENTATIVE" },
      });

      const userAActor = { userId: userA.id, role: "USER", email: userA.email, name: userA.name };
      const repActor = { userId: rep.id, role: "REPRESENTATIVE" };

      const profileA = await prisma.crmCustomerProfile.create({
        data: { ownerUserId: userA.id, name: "Customer A", assignmentStatus: "ASSIGNED" },
      });
      const profileB = await prisma.crmCustomerProfile.create({
        data: { ownerUserId: admin.id, name: "Customer B", assignmentStatus: "ASSIGNED" },
      });

      const org = await prisma.organization.create({
        data: {
          orgCode: "T65-ORG",
          canonicalName: "测试付款单位",
          normalizedName: "测试付款单位",
        },
      });

      const orderA = await prisma.order.create({
        data: {
          orderNo: "T65-A",
          source: "MANUAL",
          profileId: profileA.id,
          buyerOrganizationId: org.id,
          title: "Order A",
          createdById: admin.id,
          technicalOwnerUserId: userA.id,
          totalAmount: 50_000,
          status: "CONFIRMED",
        },
      });
      const orderB = await prisma.order.create({
        data: {
          orderNo: "T65-B",
          source: "MANUAL",
          profileId: profileB.id,
          buyerOrganizationId: org.id,
          title: "Order B",
          createdById: admin.id,
          totalAmount: 50_000,
          status: "CONFIRMED",
        },
      });

      const invoiceSingleA = await prisma.externalOrderInvoiceRequest.create({
        data: {
          orderId: orderA.id,
          buyerOrganizationId: org.id,
          buyerOrganizationName: org.canonicalName,
          totalAmount: 50_000,
          status: "ISSUED",
          actualIssuedAt: new Date("2026-01-15"),
          actualInvoiceNo: "T65-A-001",
          createdById: admin.id,
        },
      });

      const invoiceCross = await prisma.externalOrderInvoiceRequest.create({
        data: {
          orderId: orderA.id,
          buyerOrganizationId: org.id,
          buyerOrganizationName: org.canonicalName,
          totalAmount: 100_000,
          status: "ISSUED",
          actualIssuedAt: new Date("2026-01-16"),
          actualInvoiceNo: "T65-CROSS",
          createdById: admin.id,
          orderCoverage: {
            create: [
              { orderId: orderA.id, amount: 50_000 },
              { orderId: orderB.id, amount: 50_000 },
            ],
          },
        },
      });

      const receiptInput = {
        amountYuan: 500,
        receivedAt: "2026-01-20",
        organizationId: org.id,
        source: "BANK" as const,
        allocations: [{ invoiceId: invoiceSingleA.id, amountYuan: 500 }],
      };

      await expect(
        createReceiptForActor(repActor, receiptInput, { invocation: { channel: "agent" } }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      await expect(
        createReceiptForActor(
          userAActor,
          {
            ...receiptInput,
            allocations: [{ invoiceId: invoiceCross.id, amountYuan: 1000 }],
          },
          { invocation: { channel: "web" } },
        ),
      ).rejects.toBeInstanceOf(NotFoundError);

      try {
        await createReceiptForActor(
          userAActor,
          {
            ...receiptInput,
            allocations: [{ invoiceId: invoiceCross.id, amountYuan: 1000 }],
          },
          { invocation: { channel: "web" } },
        );
        throw new Error("expected scope failure");
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundError);
        const nf = err as InstanceType<typeof NotFoundError>;
        expect(nf.message).not.toContain(orderB.id);
        expect(nf.message).not.toContain(orderB.orderNo);
        expect(nf.message).not.toContain(invoiceCross.id);
      }

      const preview = await previewCreateReceiptForActor(userAActor, receiptInput);
      expect(preview.title).toContain("测试付款单位");
      expect(preview.target.id).toBe(org.id);

      const webResult = await createReceiptForActor(userAActor, receiptInput, {
        invocation: { channel: "web" },
      });
      expect(webResult.receipt.amountCents).toBe(50_000);
      expect(webResult.allocations).toHaveLength(1);
      expect(webResult.allocations[0]?.invoiceId).toBe(invoiceSingleA.id);
      expect(webResult.allocations[0]?.orderId).toBe(orderA.id);

      const invoiceWeb = await prisma.externalOrderInvoiceRequest.create({
        data: {
          orderId: orderA.id,
          buyerOrganizationId: org.id,
          buyerOrganizationName: org.canonicalName,
          totalAmount: 20_000,
          status: "ISSUED",
          actualIssuedAt: new Date("2026-01-17"),
          actualInvoiceNo: "T65-WEB",
          createdById: admin.id,
        },
      });

      const invoiceAgent = await prisma.externalOrderInvoiceRequest.create({
        data: {
          orderId: orderA.id,
          buyerOrganizationId: org.id,
          buyerOrganizationName: org.canonicalName,
          totalAmount: 20_000,
          status: "ISSUED",
          actualIssuedAt: new Date("2026-01-18"),
          actualInvoiceNo: "T65-AGENT",
          createdById: admin.id,
        },
      });

      const webParity = await createReceiptForActor(
        userAActor,
        {
          amountYuan: 200,
          receivedAt: "2026-01-21",
          organizationId: org.id,
          source: "BANK",
          allocations: [{ invoiceId: invoiceWeb.id, amountYuan: 200 }],
        },
        { invocation: { channel: "web" } },
      );

      const agentExecuted = await executeAgentAction<{
        receipt: { id: string; amount: number; receivedAt: string };
        allocationCount: number;
      }>(
        agentExecCtx(userAActor),
        "finance.create_receipt",
        {
          amount: 200,
          receivedAt: "2026-01-22",
          organizationId: org.id,
          allocations: [{ invoiceId: invoiceAgent.id, amount: 200 }],
          source: "BANK",
        },
        { allowConfirm: true, proposalId: "prop-t65-1" },
      );

      expect(webParity.receipt.amountCents).toBe(20_000);
      expect(agentExecuted.result.receipt.amount).toBe(20_000);
      expect(webParity.allocations.length).toBe(agentExecuted.result.allocationCount);

      // ── proposal 级业务幂等：finalize 前崩溃后的重试不得重复回款 ──────────
      // action 层端到端透传：proposalId 落库为 FinanceReceipt 唯一幂等键
      const agentReceiptRow = await prisma.financeReceipt.findFirstOrThrow({
        where: { sourceAgentProposalId: "prop-t65-1" },
      });
      expect(agentReceiptRow.id).toBe(agentExecuted.result.receipt.id);
      // Web 渠道无 proposal → 键为空
      const webReceiptRow = await prisma.financeReceipt.findUniqueOrThrow({
        where: { id: webParity.receipt.id },
      });
      expect(webReceiptRow.sourceAgentProposalId).toBeNull();

      const receiptsBefore = await prisma.financeReceipt.count();
      const allocationsBefore = await prisma.financeReceiptAllocation.count();

      // command 层回放：同 proposalId → 幂等返回原回款，不触发「剩余可核销不足」
      const replayed = await createReceiptForActor(
        userAActor,
        {
          amountYuan: 200,
          receivedAt: "2026-01-22",
          organizationId: org.id,
          source: "BANK",
          allocations: [{ invoiceId: invoiceAgent.id, amountYuan: 200 }],
          sourceAgentProposalId: "prop-t65-1",
        },
        { invocation: { channel: "agent", proposalId: "prop-t65-1" } },
      );
      expect(replayed.idempotentReplay).toBe(true);
      expect(replayed.receipt.id).toBe(agentExecuted.result.receipt.id);

      // action 层回放（模拟 confirm 链崩溃重试）：同一回款、正式表零新增
      const reExecuted = await executeAgentAction<{
        receipt: { id: string };
        allocationCount: number;
      }>(
        agentExecCtx(userAActor),
        "finance.create_receipt",
        {
          amount: 200,
          receivedAt: "2026-01-22",
          organizationId: org.id,
          allocations: [{ invoiceId: invoiceAgent.id, amount: 200 }],
          source: "BANK",
        },
        { allowConfirm: true, proposalId: "prop-t65-1" },
      );
      expect(reExecuted.result.receipt.id).toBe(agentExecuted.result.receipt.id);
      expect(await prisma.financeReceipt.count()).toBe(receiptsBefore);
      expect(await prisma.financeReceiptAllocation.count()).toBe(allocationsBefore);
    });
  });
});
