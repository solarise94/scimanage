import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent" },
});

/**
 * T6.4: actor-aware register issued invoice shared by Web invoice-documents POST
 * and Agent finance.register_issued_invoice. Covers capability, full-scope success,
 * partial touched-order scope → NotFound without leak, and duplicate invoice number.
 */
describe("T6.4 register issued invoice", () => {
  it("enforces capability, scope, register success, and duplicate conflicts", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { RegisterIssuedInvoiceError } = await import("@/lib/finance/register-issued-invoice");
      const { createInvoiceStagingFile } = await import("@/lib/finance/invoice-staging");
      const {
        previewRegisterIssuedInvoiceForActor,
        registerIssuedInvoiceForActor,
        AGENT_REGISTER_ISSUED_INVOICE_POLICY,
        WEB_REGISTER_ISSUED_INVOICE_POLICY,
      } = await import("@/lib/finance/application/register-issued-invoice");
      const { submitInvoiceRequestForActor } = await import(
        "@/lib/finance/application/submit-invoice-request"
      );
      const { executeAgentAction } = await import("@/lib/agent-actions/registry");

      const admin = await prisma.user.create({
        data: { email: "t64-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const userA = await prisma.user.create({
        data: { email: "t64-usera@example.com", name: "UserA", password: "h", role: "USER" },
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
          orgCode: "T64-ORG",
          canonicalName: "测试开票单位",
          normalizedName: "测试开票单位",
          isInvoiceSubject: true,
          taxId: "91110000000000000X",
        },
      });

      const seller = await prisma.billingProfile.create({
        data: { name: "测试销方", taxId: "91110000000000001X", isDefault: true },
      });

      const orderA = await prisma.order.create({
        data: {
          orderNo: "T64-A",
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
          orderNo: "T64-B",
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

      const submitSingle = async (mainOrderId: string, amountCents: number) =>
        submitInvoiceRequestForActor(adminActor, {
          mainOrderId,
          coverageAllocations: [{ orderId: mainOrderId, amountCents }],
          sellerProfileId: seller.id,
          buyerOrganizationId: org.id,
          buyerOrganizationName: org.canonicalName,
          invoiceType: "NORMAL",
          items: [{ itemName: "测序服务", amountCents }],
        });

      const invoiceA = await submitSingle(orderA.id, 20_000);
      const invoiceB = await submitSingle(orderB.id, 15_000);

      const crossCoverageInvoice = await submitInvoiceRequestForActor(adminActor, {
        mainOrderId: orderA.id,
        coverageAllocations: [
          { orderId: orderA.id, amountCents: 10_000 },
          { orderId: orderB.id, amountCents: 10_000 },
        ],
        sellerProfileId: seller.id,
        buyerOrganizationId: org.id,
        buyerOrganizationName: org.canonicalName,
        invoiceType: "NORMAL",
        items: [{ itemName: "测序服务", amountCents: 20_000 }],
      });

      const pdfBuffer = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 0x20)]);

      const createStaging = (userId: string, suffix = "") => {
        const buffer = Buffer.concat([
          Buffer.from(`%PDF-1.4\n${suffix}\n`),
          Buffer.alloc(64, 0x20),
        ]);
        return createInvoiceStagingFile({
          createdById: userId,
          originalFileName: "invoice.pdf",
          declaredMime: "application/pdf",
          buffer,
        });
      };

      const stagingAdmin = await createStaging(admin.id, "admin-a");

      await expect(
        previewRegisterIssuedInvoiceForActor(
          userAActor,
          {
            stagingFileId: stagingAdmin.id,
            invoiceRequestId: invoiceA.invoice.id,
            actualInvoiceNo: "T64-A-001",
            expectedSha256: stagingAdmin.sha256,
            expectedStagingVersion: stagingAdmin.version,
          },
          AGENT_REGISTER_ISSUED_INVOICE_POLICY,
        ),
      ).rejects.toMatchObject({
        name: "RegisterIssuedInvoiceError",
        code: "INVOICE_REQUEST_FORBIDDEN",
      });

      const stagingUser = await createStaging(userA.id, "user-cross");
      await expect(
        registerIssuedInvoiceForActor(
          userAActor,
          {
            invoiceRequestId: crossCoverageInvoice.invoice.id,
            stagedFile: stagingUser,
            actualInvoiceNo: "T64-CROSS-001",
            expectedSha256: stagingUser.sha256,
            expectedStagingVersion: stagingUser.version,
          },
          { policy: WEB_REGISTER_ISSUED_INVOICE_POLICY, invocation: { channel: "web" } },
        ),
      ).rejects.toBeInstanceOf(RegisterIssuedInvoiceError);

      try {
        await registerIssuedInvoiceForActor(
          userAActor,
          {
            invoiceRequestId: crossCoverageInvoice.invoice.id,
            stagedFile: stagingUser,
            actualInvoiceNo: "T64-CROSS-001",
            expectedSha256: stagingUser.sha256,
            expectedStagingVersion: stagingUser.version,
          },
          { policy: WEB_REGISTER_ISSUED_INVOICE_POLICY, invocation: { channel: "web" } },
        );
        throw new Error("expected scope failure");
      } catch (err) {
        expect(err).toBeInstanceOf(RegisterIssuedInvoiceError);
        const regErr = err as InstanceType<typeof RegisterIssuedInvoiceError>;
        expect(regErr.message).not.toContain(orderB.id);
        expect(regErr.message).not.toContain(orderB.orderNo);
        expect(regErr.code).toBe("INVOICE_REQUEST_NOT_FOUND");
      }

      const preview = await previewRegisterIssuedInvoiceForActor(
        adminActor,
        {
          stagingFileId: stagingAdmin.id,
          invoiceRequestId: invoiceA.invoice.id,
          actualInvoiceNo: "T64-A-001",
          expectedSha256: stagingAdmin.sha256,
          expectedStagingVersion: stagingAdmin.version,
        },
        AGENT_REGISTER_ISSUED_INVOICE_POLICY,
      );
      expect(preview.title).toContain("T64-A-001");
      expect(preview.target.id).toBe(invoiceA.invoice.id);

      const registered = await registerIssuedInvoiceForActor(
        adminActor,
        {
          stagingFileId: stagingAdmin.id,
          invoiceRequestId: invoiceA.invoice.id,
          actualInvoiceNo: "T64-A-001",
          expectedSha256: stagingAdmin.sha256,
          expectedStagingVersion: stagingAdmin.version,
        },
        {
          policy: AGENT_REGISTER_ISSUED_INVOICE_POLICY,
          invocation: { channel: "agent", proposalId: "prop-t64-1" },
        },
      );
      expect(registered.invoice.status).toBe("ISSUED");
      expect(registered.invoice.actualInvoiceNo).toBe("T64-A-001");
      expect(registered.touchedOrderIds).toContain(orderA.id);

      const stagingB = await createStaging(admin.id, "admin-b");
      const agentRegistered = await executeAgentAction<{
        invoice: { status: string; actualInvoiceNo: string | null };
      }>(
        agentExecCtx(adminActor),
        "finance.register_issued_invoice",
        {
          stagingFileId: stagingB.id,
          invoiceRequestId: invoiceB.invoice.id,
          actualInvoiceNo: "T64-B-001",
          expectedSha256: stagingB.sha256,
          expectedStagingVersion: stagingB.version,
        },
        { allowConfirm: true, proposalId: "prop-t64-2" },
      );
      expect(agentRegistered.result.invoice.status).toBe("ISSUED");
      expect(agentRegistered.result.invoice.actualInvoiceNo).toBe("T64-B-001");

      const invoiceC = await submitSingle(orderA.id, 10_000);
      const stagingDup = await createStaging(admin.id, "dup-number");
      await expect(
        registerIssuedInvoiceForActor(
          adminActor,
          {
            invoiceRequestId: invoiceC.invoice.id,
            stagedFile: stagingDup,
            actualInvoiceNo: "T64-A-001",
            expectedSha256: stagingDup.sha256,
            expectedStagingVersion: stagingDup.version,
          },
          { policy: AGENT_REGISTER_ISSUED_INVOICE_POLICY, invocation: { channel: "agent" } },
        ),
      ).rejects.toMatchObject({
        code: "INVOICE_NUMBER_DUPLICATE",
      });
    });
  });
});
