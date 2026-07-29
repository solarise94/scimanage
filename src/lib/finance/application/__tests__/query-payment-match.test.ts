import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent" },
});

/**
 * T6.1: actor-aware payment match query shared by Web match route and Agent
 * `finance.match_payment`. Covers ADMIN full disclosure, partial order scope
 * (no ID/amount/combination leak), and Web/Agent parity.
 */
describe("T6.1 payment match query service", () => {
  it("enforces scope disclosure and Agent/Web parity", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const {
        queryPaymentMatchForActor,
        shapePaymentMatchForAgent,
      } = await import("@/lib/finance/application/query-payment-match");
      const { ForbiddenError } = await import("@/lib/application/errors");
      const { executeAgentAction } = await import("@/lib/agent-actions/registry");

      const admin = await prisma.user.create({
        data: { email: "t61-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const userA = await prisma.user.create({
        data: { email: "t61-usera@example.com", name: "UserA", password: "h", role: "USER" },
      });
      const userB = await prisma.user.create({
        data: { email: "t61-userb@example.com", name: "UserB", password: "h", role: "USER" },
      });

      const adminActor = { userId: admin.id, role: "ADMIN" };
      const userAActor = { userId: userA.id, role: "USER", email: userA.email, name: userA.name };

      const profileA = await prisma.crmCustomerProfile.create({
        data: { ownerUserId: userA.id, name: "Customer A", assignmentStatus: "ASSIGNED" },
      });
      const profileB = await prisma.crmCustomerProfile.create({
        data: { ownerUserId: userB.id, name: "Customer B", assignmentStatus: "ASSIGNED" },
      });

      const org = await prisma.organization.create({
        data: {
          orgCode: "T61-ORG",
          canonicalName: "测试医院",
          normalizedName: "测试医院",
        },
      });

      const orderA = await prisma.order.create({
        data: {
          orderNo: "T61-A",
          source: "MANUAL",
          profileId: profileA.id,
          title: "Order A",
          createdById: admin.id,
          totalAmount: 50_000,
          status: "CONFIRMED",
        },
      });
      const orderB = await prisma.order.create({
        data: {
          orderNo: "T61-B",
          source: "MANUAL",
          profileId: profileB.id,
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
          actualIssuedAt: new Date(),
          actualInvoiceNo: "INV-A",
          createdById: admin.id,
        },
      });

      const invoiceMulti = await prisma.externalOrderInvoiceRequest.create({
        data: {
          orderId: orderA.id,
          buyerOrganizationId: org.id,
          buyerOrganizationName: org.canonicalName,
          totalAmount: 100_000,
          status: "ISSUED",
          actualIssuedAt: new Date(),
          actualInvoiceNo: "INV-MULTI",
          createdById: admin.id,
          orderCoverage: {
            create: [
              { orderId: orderA.id, amount: 50_000 },
              { orderId: orderB.id, amount: 50_000 },
            ],
          },
        },
      });

      const targetCents = 50_000;

      const adminResult = await queryPaymentMatchForActor(adminActor, {
        organizationId: org.id,
        amountCents: targetCents,
      });
      expect(adminResult.partialScopeInvoiceCount).toBe(0);
      expect(adminResult.outOfScopeInvoiceCount).toBe(0);
      const adminCandidateIds = adminResult.candidateInvoices.map((c) => c.id);
      expect(adminCandidateIds).toContain(invoiceSingleA.id);
      expect(adminCandidateIds).toContain(invoiceMulti.id);
      expect(adminResult.status).toBe("MATCHED");
      expect(adminResult.combinations?.some((c) => c.invoiceIds.includes(invoiceSingleA.id))).toBe(true);

      const userResult = await queryPaymentMatchForActor(userAActor, {
        organizationId: org.id,
        amountCents: targetCents,
      });
      expect(userResult.partialScopeInvoiceCount).toBe(1);
      expect(userResult.outOfScopeInvoiceCount).toBe(0);
      const userCandidateIds = userResult.candidateInvoices.map((c) => c.id);
      expect(userCandidateIds).toContain(invoiceSingleA.id);
      expect(userCandidateIds).not.toContain(invoiceMulti.id);

      const leakedIds = [
        ...userCandidateIds,
        ...(userResult.combinations ?? []).flatMap((c) => c.invoiceIds),
        ...(userResult.heuristicReference?.invoiceIds ?? []),
      ];
      expect(leakedIds).not.toContain(invoiceMulti.id);

      const agentExec = await executeAgentAction<{
        status: string;
        candidateCount: number;
        partialScopeInvoiceCount: number;
        candidateInvoices: Array<{ id: string }>;
      }>(agentExecCtx(userAActor), "finance.match_payment", {
        organizationId: org.id,
        amount: 500,
      });
      const shaped = shapePaymentMatchForAgent(userResult, targetCents);
      expect(agentExec.result.status).toBe(shaped.status);
      expect(agentExec.result.candidateCount).toBe(shaped.candidateCount);
      expect(agentExec.result.partialScopeInvoiceCount).toBe(1);
      expect(agentExec.result.candidateInvoices.map((c) => c.id)).not.toContain(
        invoiceMulti.id,
      );

      await expect(
        queryPaymentMatchForActor(
          { userId: userA.id, role: "REPRESENTATIVE" },
          { organizationId: org.id, amountCents: targetCents },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
