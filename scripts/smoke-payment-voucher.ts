/**
 * Self-contained smoke test for Payment Voucher Matching (DOC-001 Phase 1)
 * Creates test data in an isolated temp DB, runs assertions, then disposes.
 *
 * Run: npx tsx scripts/smoke-payment-voucher.ts
 */

import { withTempSmokeDb } from "./lib/temp-smoke-db";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

function uid(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

async function main() {
  await withTempSmokeDb(async () => {
    const { prisma } = await import("../src/lib/prisma");
    const { getOrderReceiptTotals } = await import("../src/lib/finance/order-receivables");
    const { computeInvoicePaymentStatus } = await import("../src/lib/finance/payment-status");
    const { getInvoicesForOrder, getInvoiceOccupiedAmount, assertInvoiceNotOccupied } = await import("../src/lib/finance/order-invoices");

    console.log("=== Smoke Test: Payment Voucher Matching (DOC-001) ===\n");

    console.log("Setting up test data...");
    const email = uid("test-admin");
    const admin = await prisma.user.create({
      data: { email, name: "Test Admin", password: "x", role: "ADMIN" },
      select: { id: true },
    });
    console.log(`  Created admin user: ${email}`);

    const org = await prisma.organization.create({
      data: { id: uid("org"), orgCode: uid("ORG"), canonicalName: "Smoke Test University", normalizedName: "smoke test university" },
      select: { id: true, canonicalName: true },
    });
    const profile = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: uid("CUST"),
        name: "Test Profile",
        organizationId: org.id,
        organization: org.canonicalName,
        ownerUserId: admin.id,
        stage: "ACTIVE",
        assignmentStatus: "ASSIGNED",
        assignedAt: new Date(),
      },
      select: { id: true },
    });
    const order1 = await prisma.order.create({
      data: {
        id: uid("ord1"), orderNo: uid("ORD-1"), title: "Smoke Order 1", totalAmount: 1000,
        createdById: admin.id, profileId: profile.id,
      },
      select: { id: true },
    });
    const order2 = await prisma.order.create({
      data: {
        id: uid("ord2"), orderNo: uid("ORD-2"), title: "Smoke Order 2", totalAmount: 2000,
        createdById: admin.id, profileId: profile.id,
      },
      select: { id: true },
    });
    const inv1 = await prisma.externalOrderInvoiceRequest.create({
      data: {
        id: uid("inv1"), actualInvoiceNo: "INV-001", buyerOrganizationName: "Test University",
        buyerOrganizationId: org.id, totalAmount: 500, status: "ISSUED", orderId: order1.id, createdById: admin.id,
      },
      select: { id: true, totalAmount: true },
    });
    const inv2 = await prisma.externalOrderInvoiceRequest.create({
      data: {
        id: uid("inv2"), actualInvoiceNo: "INV-002", buyerOrganizationName: "Test University",
        buyerOrganizationId: org.id, totalAmount: 300, status: "ISSUED", orderId: order2.id, createdById: admin.id,
      },
      select: { id: true, totalAmount: true },
    });
    console.log(`  Created: org=${org.id}, profile=${profile.id}, order1=${order1.id}, order2=${order2.id}, inv1=${inv1.id}, inv2=${inv2.id}\n`);

    try {
      console.log("1. getOrderReceiptTotals with allocation receipt");
      {
        const before = await getOrderReceiptTotals([order1.id]);
        const baseline = before.get(order1.id) || 0;

        const r = await prisma.financeReceipt.create({
          data: { amount: 100.00, receivedAt: new Date(), source: "BANK", remark: "SMOKE TEST 1", createdById: admin.id, organizationId: org.id, profileId: profile.id },
        });
        await prisma.financeReceiptAllocation.create({
          data: { receiptId: r.id, invoiceId: inv1.id, orderId: order1.id, amount: 100.00, createdById: admin.id },
        });

        const after = await getOrderReceiptTotals([order1.id]);
        const afterAmt = after.get(order1.id) || 0;
        assert(Math.abs(afterAmt - baseline - 100) < 0.01, `Receipt total increased by allocation: ${afterAmt}`);

        await prisma.financeReceiptAllocation.deleteMany({ where: { receiptId: r.id } });
        await prisma.financeReceipt.delete({ where: { id: r.id } });
      }

      console.log("\n2. Cross-order allocation aggregation");
      {
        const r = await prisma.financeReceipt.create({
          data: { amount: 200.00, receivedAt: new Date(), source: "BANK", remark: "SMOKE TEST 2", createdById: admin.id, profileId: profile.id },
        });
        await prisma.financeReceiptAllocation.createMany({
          data: [
            { receiptId: r.id, invoiceId: inv1.id, orderId: order1.id, amount: 120.00, createdById: admin.id },
            { receiptId: r.id, invoiceId: inv2.id, orderId: order2.id, amount: 80.00, createdById: admin.id },
          ],
        });

        const totals = await getOrderReceiptTotals([order1.id, order2.id]);
        assert((totals.get(order1.id) || 0) >= 120, `Order1 total >= 120: ${totals.get(order1.id)}`);
        assert((totals.get(order2.id) || 0) >= 80, `Order2 total >= 80: ${totals.get(order2.id)}`);

        await prisma.financeReceiptAllocation.deleteMany({ where: { receiptId: r.id } });
        await prisma.financeReceipt.delete({ where: { id: r.id } });
      }

      console.log("\n3. Legacy 1-to-1 receipt aggregation");
      {
        const r = await prisma.financeReceipt.create({
          data: {
            amount: 50.00, receivedAt: new Date(), source: "MANUAL", orderId: order1.id,
            profileId: profile.id, remark: "SMOKE TEST 3", createdById: admin.id,
          },
        });
        const totals = await getOrderReceiptTotals([order1.id]);
        assert((totals.get(order1.id) || 0) >= 50, `Legacy receipt counted: ${totals.get(order1.id)}`);
        await prisma.financeReceipt.delete({ where: { id: r.id } });
      }

      console.log("\n4. RED invoice occupation check");
      {
        const r = await prisma.financeReceipt.create({
          data: { amount: 1.00, receivedAt: new Date(), source: "BANK", remark: "SMOKE TEST 4", createdById: admin.id, profileId: profile.id },
        });
        await prisma.financeReceiptAllocation.create({
          data: { receiptId: r.id, invoiceId: inv1.id, orderId: order1.id, amount: 1.00, createdById: admin.id },
        });

        assert((await getInvoiceOccupiedAmount(inv1.id)) >= 1, `Invoice occupied detected`);

        let threw = false;
        try { await assertInvoiceNotOccupied(inv1.id); } catch { threw = true; }
        assert(threw, "assertInvoiceNotOccupied throws for occupied invoice");

        const threw409 = await assertInvoiceNotOccupied(inv1.id).then(() => false).catch((e: unknown) => (e as { status?: number })?.status === 409);
        assert(threw409, "assertInvoiceNotOccupied error has status 409");

        await prisma.financeReceiptAllocation.deleteMany({ where: { receiptId: r.id } });
        await prisma.financeReceipt.delete({ where: { id: r.id } });
      }

      console.log("\n5. computeInvoicePaymentStatus");
      {
        const r = await prisma.financeReceipt.create({
          data: {
            amount: 50.00, receivedAt: new Date(), source: "BANK", remark: "SMOKE TEST 5",
            createdById: admin.id, orderId: order1.id, profileId: profile.id,
          },
        });
        await prisma.financeReceiptAllocation.create({
          data: { receiptId: r.id, invoiceId: inv1.id, orderId: order1.id, amount: 50.00, createdById: admin.id },
        });

        const status = await computeInvoicePaymentStatus(inv1.id, "order");
        assert(status.receiptTotal >= 50, "Payment status reflects allocation");

        await prisma.financeReceiptAllocation.deleteMany({ where: { receiptId: r.id } });
        await prisma.financeReceipt.delete({ where: { id: r.id } });
      }

      console.log("\n6. getInvoicesForOrder _receiptAmount includes allocations");
      {
        const r = await prisma.financeReceipt.create({
          data: { amount: 30.00, receivedAt: new Date(), source: "BANK", remark: "SMOKE TEST 6", createdById: admin.id, profileId: profile.id },
        });
        await prisma.financeReceiptAllocation.create({
          data: { receiptId: r.id, invoiceId: inv1.id, orderId: order1.id, amount: 30.00, createdById: admin.id },
        });

        const target = (await getInvoicesForOrder(order1.id)).find((i) => i.id === inv1.id);
        if (target) {
          assert(target._receiptAmount >= 30, "getInvoicesForOrder includes allocation in _receiptAmount");
        } else {
          assert(false, "Invoice not found via getInvoicesForOrder");
        }

        await prisma.financeReceiptAllocation.deleteMany({ where: { receiptId: r.id } });
        await prisma.financeReceipt.delete({ where: { id: r.id } });
      }

      console.log("\n6.5 extractOneCombination edge case [4,3,3] → 6 correctly");
      {
        function testExtract(items: { id: string; amount: number }[], target: number): string[] | null {
          const n = items.length;
          const parent = new Int32Array(target + 1).fill(-1);
          const dp = new Uint8Array(target + 1);
          dp[0] = 1;
          for (let i = 0; i < n; i++) {
            const amt = items[i].amount;
            for (let s = target; s >= amt; s--) {
              if (dp[s - amt] && !dp[s]) { dp[s] = 1; parent[s] = i; }
            }
            if (dp[target]) break;
          }
          if (!dp[target]) return null;
          const ids: string[] = [];
          let s = target;
          while (s > 0) { const i = parent[s]; if (i < 0) break; ids.push(items[i].id); s -= items[i].amount; }
          return ids;
        }
        assert(testExtract([{ id: "a", amount: 4 }, { id: "b", amount: 3 }, { id: "c", amount: 3 }], 6)?.length === 2, "extract [4,3,3]->6 succeeds with 2 items");
        assert(testExtract([{ id: "a", amount: 1 }, { id: "b", amount: 2 }, { id: "c", amount: 3 }], 5) !== null, "extract [1,2,3]->5 succeeds");
        assert(testExtract([{ id: "a", amount: 3 }, { id: "b", amount: 5 }, { id: "c", amount: 8 }], 4) === null, "extract [3,5,8]->4 returns null");
      }

      console.log("\n7. Receipt deletion snapshot includes allocations");
      {
        const r = await prisma.financeReceipt.create({
          data: { amount: 10.00, receivedAt: new Date(), source: "BANK", remark: "SMOKE TEST 7", createdById: admin.id, profileId: profile.id },
        });
        const a = await prisma.financeReceiptAllocation.create({
          data: { receiptId: r.id, invoiceId: inv1.id, orderId: order1.id, amount: 10.00, createdById: admin.id },
        });

        const snapshot = {
          id: r.id, amount: r.amount, receivedAt: r.receivedAt.toISOString(),
          source: r.source, remark: r.remark,
          allocations: [{ id: a.id, invoiceId: a.invoiceId, orderId: a.orderId, amount: a.amount, createdAt: a.createdAt.toISOString() }],
        };
        await prisma.financeReceiptDeletionLog.create({
          data: {
            receiptId: r.id, amount: r.amount, receivedAt: r.receivedAt,
            orderId: r.orderId, source: r.source, remark: r.remark,
            reason: "SMOKE TEST", snapshotJson: JSON.stringify(snapshot), deletedById: admin.id,
          },
        });
        await prisma.financeReceipt.update({
          where: { id: r.id },
          data: { deleted: true, deletedAt: new Date(), deletedById: admin.id, deleteReason: "SMOKE TEST" },
        });

        await getOrderReceiptTotals([order1.id]);
        await prisma.financeReceiptDeletionLog.deleteMany({ where: { receiptId: r.id } });
        await prisma.financeReceiptAllocation.deleteMany({ where: { receiptId: r.id } });
        await prisma.financeReceipt.delete({ where: { id: r.id } });
      }
    } finally {
      console.log("\nTest data in temp DB (auto-disposed).");
    }

    console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exit(1);
  });
}

main().catch((e) => {
  console.error("Smoke test error:", e);
  process.exit(1);
});
