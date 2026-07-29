import { describe, expect, it, vi } from "vitest";
import { withTempSmokeDb } from "../../../../scripts/lib/temp-smoke-db";

/**
 * Allocation receipt write-off guards: invoices adjusted RED/REISSUE must be
 * rejected both by the pre-tx fast-fail and — critically — by an in-tx re-read,
 * so a REISSUE committed between bank-flow matching and workspace confirmation
 * cannot be written off via a stale candidate combination.
 */
describe("createAllocationReceipt RED/REISSUE guards", () => {
  it("rejects RED (400) and REISSUE (409) pre-tx and inside the write transaction", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const {
        createAllocationReceipt,
        AllocationReceiptError,
      } = await import("@/lib/finance/create-allocation-receipt");

      const admin = await prisma.user.create({
        data: { email: "t-alloc-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const profile = await prisma.crmCustomerProfile.create({
        data: { ownerUserId: admin.id, name: "Alloc Customer", assignmentStatus: "ASSIGNED" },
      });
      const org = await prisma.organization.create({
        data: {
          orgCode: "ALLOC-ORG",
          canonicalName: "核销测试单位",
          normalizedName: "核销测试单位",
        },
      });
      const order = await prisma.order.create({
        data: {
          orderNo: "ALLOC-A",
          source: "MANUAL",
          profileId: profile.id,
          buyerOrganizationId: org.id,
          title: "Order Alloc",
          createdById: admin.id,
          totalAmount: 50_000,
          status: "CONFIRMED",
        },
      });

      const makeInvoice = async (invoiceNo: string) =>
        prisma.externalOrderInvoiceRequest.create({
          data: {
            orderId: order.id,
            buyerOrganizationId: org.id,
            buyerOrganizationName: org.canonicalName,
            totalAmount: 50_000,
            status: "ISSUED",
            actualIssuedAt: new Date("2026-01-15"),
            actualInvoiceNo: invoiceNo,
            createdById: admin.id,
          },
        });

      const baseInput = (invoiceId: string) => ({
        userId: admin.id,
        role: "ADMIN",
        department: "FIELD_SALES",
        amountYuan: 500,
        receivedAt: "2026-01-20",
        organizationId: org.id,
        source: "BANK",
        allocations: [{ invoiceId, amountYuan: 500 }],
      });

      // 1) happy path: full-invoice allocation succeeds
      const cleanInvoice = await makeInvoice("ALLOC-OK");
      const ok = await createAllocationReceipt(baseInput(cleanInvoice.id));
      expect(ok.receipt.amountCents).toBe(50_000);
      expect(ok.allocations[0]?.invoiceId).toBe(cleanInvoice.id);

      // 2) pre-tx RED → 400
      const redInvoice = await makeInvoice("ALLOC-RED");
      await prisma.invoiceAdjustment.create({
        data: { kind: "RED", originalInvoiceId: redInvoice.id, createdById: admin.id },
      });
      try {
        await createAllocationReceipt(baseInput(redInvoice.id));
        throw new Error("expected RED rejection");
      } catch (err) {
        expect(err).toBeInstanceOf(AllocationReceiptError);
        expect((err as InstanceType<typeof AllocationReceiptError>).status).toBe(400);
        expect((err as Error).message).toContain("已冲红");
      }

      // 3) pre-tx REISSUE → 409 INVOICE_REISSUED
      const reissuedInvoice = await makeInvoice("ALLOC-REISSUE");
      await prisma.invoiceAdjustment.create({
        data: { kind: "REISSUE", originalInvoiceId: reissuedInvoice.id, createdById: admin.id },
      });
      try {
        await createAllocationReceipt(baseInput(reissuedInvoice.id));
        throw new Error("expected REISSUE rejection");
      } catch (err) {
        expect(err).toBeInstanceOf(AllocationReceiptError);
        const are = err as InstanceType<typeof AllocationReceiptError>;
        expect(are.status).toBe(409);
        expect(are.body).toMatchObject({
          error: "INVOICE_REISSUED",
          invoiceId: reissuedInvoice.id,
        });
      }

      // 4) race simulation: the pre-tx invoice fetch sees a clean invoice, but a
      //    REISSUE commits before the write transaction runs (bank-flow match →
      //    reissue → stale workspace confirm). The in-tx re-check must reject it.
      const raceInvoice = await makeInvoice("ALLOC-RACE");
      const receiptsBefore = await prisma.financeReceipt.count();
      const origFindMany = prisma.externalOrderInvoiceRequest.findMany.bind(
        prisma.externalOrderInvoiceRequest,
      );
      let intercepted = false;
      const spy = vi
        .spyOn(prisma.externalOrderInvoiceRequest, "findMany")
        .mockImplementationOnce((async (...args: unknown[]) => {
          const where = (args[0] as { where?: { id?: { in?: string[] } } } | undefined)?.where;
          expect(where?.id?.in).toContain(raceInvoice.id);
          intercepted = true;
          const result = await origFindMany(
            ...(args as Parameters<typeof prisma.externalOrderInvoiceRequest.findMany>),
          );
          // Commit the adjustment AFTER the stale pre-tx read returned.
          await prisma.invoiceAdjustment.create({
            data: { kind: "REISSUE", originalInvoiceId: raceInvoice.id, createdById: admin.id },
          });
          return result;
        }) as unknown as typeof prisma.externalOrderInvoiceRequest.findMany);

      try {
        await createAllocationReceipt(baseInput(raceInvoice.id));
        throw new Error("expected in-tx REISSUE rejection");
      } catch (err) {
        expect(err).toBeInstanceOf(AllocationReceiptError);
        const are = err as InstanceType<typeof AllocationReceiptError>;
        expect(are.status).toBe(409);
        expect(are.body).toMatchObject({
          error: "INVOICE_REISSUED",
          invoiceId: raceInvoice.id,
        });
      } finally {
        spy.mockRestore();
      }
      expect(intercepted).toBe(true);

      // No receipt or allocation may survive the rejected transaction.
      expect(await prisma.financeReceipt.count()).toBe(receiptsBefore);
      expect(
        await prisma.financeReceiptAllocation.count({
          where: { invoiceId: raceInvoice.id },
        }),
      ).toBe(0);
    });
  }, 120_000);
});
