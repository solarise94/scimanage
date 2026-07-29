import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent" },
});

/**
 * T6.3: actor-aware invoice request plan/prepare/submit shared by Web routes and
 * Agent finance.* actions. Covers ADMIN capability, plan output, submit success,
 * and partial touched-order scope → NotFound without leak.
 */
describe("T6.3 invoice request plan/submit", () => {
  it("enforces capability, scope, plan output, and submit parity", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { ForbiddenError, NotFoundError } = await import("@/lib/application/errors");
      const { planProjectInvoiceRequestsForActor } = await import(
        "@/lib/finance/application/plan-project-invoice-requests"
      );
      const { prepareInvoiceDraftForActor } = await import(
        "@/lib/finance/application/prepare-invoice-draft"
      );
      const { submitInvoiceRequestForActor } = await import(
        "@/lib/finance/application/submit-invoice-request"
      );
      const { assertFullOrderScopeForActor } = await import(
        "@/lib/finance/application/invoice-order-scope"
      );
      const { executeAgentAction } = await import("@/lib/agent-actions/registry");

      const admin = await prisma.user.create({
        data: { email: "t63-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const userA = await prisma.user.create({
        data: { email: "t63-usera@example.com", name: "UserA", password: "h", role: "USER" },
      });

      const adminActor = { userId: admin.id, role: "ADMIN" };
      const userAActor = { userId: userA.id, role: "USER", email: userA.email, name: userA.name };

      const profileA = await prisma.crmCustomerProfile.create({
        data: { ownerUserId: userA.id, name: "Customer A", assignmentStatus: "ASSIGNED" },
      });
      const profileB = await prisma.crmCustomerProfile.create({
        data: { ownerUserId: admin.id, name: "Customer B", assignmentStatus: "ASSIGNED" },
      });

      const org = await prisma.organization.create({
        data: {
          orgCode: "T63-ORG",
          canonicalName: "测试开票单位",
          normalizedName: "测试开票单位",
          isInvoiceSubject: true,
          taxId: "91110000000000000X",
        },
      });

      const seller = await prisma.billingProfile.create({
        data: { name: "测试销方", taxId: "91110000000000001X", isDefault: true },
      });

      const project = await prisma.project.create({
        data: {
          name: "T63 Project",
          projectNo: "T63-P",
          profile: { connect: { id: profileA.id } },
          status: "IN_PROGRESS",
        },
      });

      const orderA = await prisma.order.create({
        data: {
          orderNo: "T63-A",
          source: "MANUAL",
          profileId: profileA.id,
          buyerOrganizationId: org.id,
          title: "Order A",
          createdById: admin.id,
          technicalOwnerUserId: admin.id,
          totalAmount: 100_000,
          status: "CONFIRMED",
          financeTreatment: "STANDALONE",
          lines: {
            create: [{ itemName: "测序服务", amount: 100_000, sortOrder: 0 }],
          },
        },
      });
      const orderB = await prisma.order.create({
        data: {
          orderNo: "T63-B",
          source: "MANUAL",
          profileId: profileB.id,
          buyerOrganizationId: org.id,
          title: "Order B",
          createdById: admin.id,
          technicalOwnerUserId: admin.id,
          totalAmount: 80_000,
          status: "CONFIRMED",
          financeTreatment: "STANDALONE",
          lines: {
            create: [{ itemName: "分析服务", amount: 80_000, sortOrder: 0 }],
          },
        },
      });

      await prisma.orderProjectLink.createMany({
        data: [
          { projectId: project.id, orderId: orderA.id },
          { projectId: project.id, orderId: orderB.id },
        ],
      });

      await expect(
        planProjectInvoiceRequestsForActor(userAActor, {
          projectId: project.id,
          invoiceType: "NORMAL",
          sellerProfileId: seller.id,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      const adminPlan = await planProjectInvoiceRequestsForActor(adminActor, {
        projectId: project.id,
        invoiceType: "NORMAL",
        sellerProfileId: seller.id,
      });
      expect(adminPlan.status).toBe("READY");
      expect(adminPlan.plans.length).toBeGreaterThan(0);
      expect(adminPlan.plans[0].totalAmountCents).toBeGreaterThan(0);
      expect(adminPlan.plans[0].buyerOrganizationId).toBe(org.id);

      await expect(assertFullOrderScopeForActor(userAActor, [orderA.id])).resolves.toBeUndefined();
      await expect(
        assertFullOrderScopeForActor(userAActor, [orderA.id, orderB.id]),
      ).rejects.toBeInstanceOf(NotFoundError);

      const draftInput = {
        mainOrderId: orderA.id,
        coverageAllocations: [{ orderId: orderA.id, amountCents: 20_000 }],
        buyerOrganizationId: org.id,
        buyerOrganizationName: org.canonicalName,
        invoiceType: "NORMAL" as const,
        items: [{ itemName: "测序服务", amountCents: 20_000 }],
      };

      const webDraft = await prepareInvoiceDraftForActor(adminActor, draftInput);
      expect(webDraft.invoice.status).toBe("DRAFT");
      expect(webDraft.invoice.totalAmount).toBe(20_000);

      const agentDraft = await executeAgentAction<{
        invoice: { status: string };
      }>(
        agentExecCtx(adminActor),
        "finance.prepare_invoice_draft",
        {
          orderId: orderA.id,
          coverageAllocations: [{ orderId: orderA.id, amountCents: 20_000 }],
          buyerOrganizationId: org.id,
          buyerOrganizationName: org.canonicalName,
          invoiceType: "NORMAL",
          items: [{ itemName: "测序服务", amount: 200 }],
        },
        { allowConfirm: true, proposalId: "prop-draft-1" },
      );
      expect(agentDraft.result.invoice.status).toBe("DRAFT");

      await expect(
        prepareInvoiceDraftForActor(userAActor, draftInput),
      ).rejects.toBeInstanceOf(ForbiddenError);

      const submitInput = {
        mainOrderId: orderA.id,
        coverageAllocations: [{ orderId: orderA.id, amountCents: 15_000 }],
        sellerProfileId: seller.id,
        buyerOrganizationId: org.id,
        buyerOrganizationName: org.canonicalName,
        invoiceType: "NORMAL" as const,
        items: [{ itemName: "测序服务", amountCents: 15_000 }],
        projectId: project.id,
      };

      const submitted = await submitInvoiceRequestForActor(adminActor, submitInput);
      expect(submitted.invoice.status).toBe("REQUESTED");
      expect(submitted.coveredOrderCount).toBe(1);

      const agentSubmit = await executeAgentAction<{
        invoice: { status: string };
      }>(
        agentExecCtx(adminActor),
        "finance.submit_invoice_request",
        {
          ...submitInput,
          coverageAllocations: [{ orderId: orderA.id, amountCents: 10_000 }],
          items: [{ itemName: "测序服务", amountCents: 10_000 }],
        },
        { allowConfirm: true, proposalId: "prop-submit-1" },
      );
      expect(agentSubmit.result.invoice.status).toBe("REQUESTED");

      await expect(submitInvoiceRequestForActor(userAActor, submitInput)).rejects.toBeInstanceOf(
        ForbiddenError,
      );

      // P0：non-owner ADMIN 经 Agent 路径不得落库（owner gate 依赖 opts.invocation）。
      const nonOwnerAdmin = await prisma.user.create({
        data: {
          email: "t63-admin-other@example.com",
          name: "OtherAdmin",
          password: "h",
          role: "ADMIN",
        },
      });
      const nonOwnerActor = {
        userId: nonOwnerAdmin.id,
        role: "ADMIN",
        email: nonOwnerAdmin.email,
        name: nonOwnerAdmin.name,
      };
      const invoiceCountBefore = await prisma.externalOrderInvoiceRequest.count();

      await expect(
        prepareInvoiceDraftForActor(
          nonOwnerActor,
          {
            ...draftInput,
            coverageAllocations: [{ orderId: orderA.id, amountCents: 5_000 }],
            items: [{ itemName: "测序服务", amountCents: 5_000 }],
          },
          { invocation: { channel: "agent", proposalId: "prop-non-owner-draft" } },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);

      await expect(
        submitInvoiceRequestForActor(
          nonOwnerActor,
          {
            ...submitInput,
            coverageAllocations: [{ orderId: orderA.id, amountCents: 5_000 }],
            items: [{ itemName: "测序服务", amountCents: 5_000 }],
          },
          { invocation: { channel: "agent", proposalId: "prop-non-owner-submit" } },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);

      expect(await prisma.externalOrderInvoiceRequest.count()).toBe(invoiceCountBefore);
    });
  });
});
