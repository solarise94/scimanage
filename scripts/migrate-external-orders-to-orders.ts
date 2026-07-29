/**
 * Migrate ExternalOrder → unified Order model.
 *
 * Idempotent: re-running will skip already-migrated records (matched by
 * OrderSourceRecord.source + OrderSourceRecord.externalOrderNo AND
 * Order.legacyExternalOrderId).
 *
 * Usage:
 *   npx tsx scripts/migrate-external-orders-to-orders.ts              # write mode
 *   npx tsx scripts/migrate-external-orders-to-orders.ts --dry-run    # report only
 *   npx tsx scripts/migrate-external-orders-to-orders.ts --json       # JSON report
 *   npx tsx scripts/migrate-external-orders-to-orders.ts --user=xxx   # use specific user as createdBy
 *
 * Safety:
 *   - Never deletes or modifies ExternalOrder rows.
 *   - Merged source orders (by mergedIntoId OR duplicateStatus=MERGED)
 *     get archived=true, deleted=true, financeTreatment=EXCLUDED.
 *   - Every ExternalOrder creates both an Order and an OrderSourceRecord.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const ORDER_CATEGORY = { SERVICE: "SERVICE", PRODUCT: "PRODUCT", MIXED: "MIXED", UNKNOWN: "UNKNOWN" } as const;
const ORDER_STATUS = { DRAFT: "DRAFT", CONFIRMED: "CONFIRMED", CANCELLED: "CANCELLED", CLOSED: "CLOSED" } as const;
const ORDER_FINANCE_TREATMENT = { AUTO: "AUTO", STANDALONE: "STANDALONE", PROJECT_INCLUDED: "PROJECT_INCLUDED", EXCLUDED: "EXCLUDED" } as const;
const ORDER_DELIVERY_STATUS = { PENDING: "PENDING", DELIVERED: "DELIVERED" } as const;

interface MigrateReport {
  dryRun: boolean;
  totalExternalOrders: number;
  created: number;
  skipped: number;
  recovered: number; // partially-migrated records completed on retry
  failed: number;
  ordersCreated: number;
  sourceRecordsCreated: number;
  linesCreated: number;
  projectLinksCreated: number;
  mergesCreated: number;
  receiptLinksUpdated: number;
  errors: string[];
}

function pad(n: number, w: number) {
  return String(n).padStart(w, "0");
}

function genOrderNo(source: string, date: Date, seq: number): string {
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1, 2);
  const d = pad(date.getDate(), 2);
  const prefix = source === "PINGOODMICE" ? "PO" : "IO";
  return `${prefix}-${y}${m}${d}-${pad(seq, 4)}`;
}

function isMergedSource(eo: { mergedIntoId: string | null; duplicateStatus: string | null }): boolean {
  return !!eo.mergedIntoId || eo.duplicateStatus === "MERGED";
}

function mapCategory(financeCategory: string): string {
  if (financeCategory === "PRODUCT") return ORDER_CATEGORY.PRODUCT;
  if (financeCategory === "SERVICE") return ORDER_CATEGORY.SERVICE;
  return ORDER_CATEGORY.UNKNOWN;
}

function mapDeliveryStatus(category: string, projectStatus: string | null): string {
  if (category === ORDER_CATEGORY.PRODUCT) return ORDER_DELIVERY_STATUS.DELIVERED;
  if (projectStatus === "COMPLETED") return ORDER_DELIVERY_STATUS.DELIVERED;
  return ORDER_DELIVERY_STATUS.PENDING;
}

function computeTotalAmount(eo: {
  paidAmount: number | null;
  grossAmount: number | null;
  priceAdjustment: number | null;
  shippingFee: number | null;
}): number {
  if (eo.paidAmount != null && eo.paidAmount > 0) return eo.paidAmount;
  const parts: number[] = [eo.grossAmount ?? 0, eo.priceAdjustment ?? 0, eo.shippingFee ?? 0];
  const sum = parts.reduce((s, v) => s + v, 0);
  return sum > 0 ? sum : 0;
}

function normalizeSource(raw: string): string {
  const aliases: Record<string, string> = { PINGOODMICE: "PINGOODMICE", "微信小商店": "PINGOODMICE", "拼好鼠": "PINGOODMICE" };
  return aliases[raw] ?? raw;
}

function buildOrderData(
  eo: Record<string, unknown>,
  date: Date,
  seq: number,
  merged: boolean,
  projectStatus: string | null,
  migrationUserId: string,
) {
  const category = mapCategory(String(eo.financeCategory ?? "UNKNOWN"));

  return {
    orderNo: genOrderNo(normalizeSource(String(eo.source ?? "MANUAL")), date, seq),
    source: normalizeSource(String(eo.source ?? "MANUAL")),
    sourcePlatform: eo.platform as string | null,
    externalOrderNo: eo.externalOrderNo as string | null,
    merchantOrderNo: eo.merchantOrderNo as string | null,
    legacyExternalOrderId: eo.id as string,

    title: (eo.productNamesRaw as string) ||
      `${eo.receiverName || "未知"}的拼好鼠订单` ||
      String(eo.externalOrderNo || "订单"),
    description: null,
    category,
    status: ORDER_STATUS.CONFIRMED,
    deliveryStatus: mapDeliveryStatus(category, projectStatus),
    orderedAt: (eo.orderAt as Date) ?? null,
    confirmedAt: (eo.paidAt as Date) ?? null,
    deliveredAt: category === ORDER_CATEGORY.PRODUCT ? (eo.paidAt as Date ?? new Date()) : null,

    customerId: eo.customerId as string | null,
    buyerNameSnapshot: eo.receiverName as string | null,
    buyerPhoneSnapshot: eo.receiverPhone as string | null,
    buyerWechatSnapshot: eo.orderUser as string | null,
    // NOTE: storeName is the platform shop name (e.g. "总店"), not the customer's real org.
    // For orders with customerId, run scripts/fix-imported-order-org-snapshot.ts to backfill.
    buyerOrgNameSnapshot: (eo.storeName as string) || null,
    buyerAddressSnapshot: eo.receiverAddress as string | null,

    customerMatchStatus: eo.customerMatchStatus as string ?? "UNMATCHED",
    customerMatchScore: eo.customerMatchScore as number | null,
    customerMatchReason: eo.customerMatchReason as string | null,

    totalAmount: computeTotalAmount({
      paidAmount: eo.paidAmount as number | null,
      grossAmount: eo.grossAmount as number | null,
      priceAdjustment: eo.priceAdjustment as number | null,
      shippingFee: eo.shippingFee as number | null,
    }),
    financeAmountOverride: eo.financeAmountOverride as number | null,
    financeTreatment: merged
      ? ORDER_FINANCE_TREATMENT.EXCLUDED
      : (eo.financeTreatment as string) ?? ORDER_FINANCE_TREATMENT.AUTO,
    financeNote: eo.financeNote as string | null,

    ownerUserId: null,
    representativeId: null,
    createdById: migrationUserId,
    archived: merged,
    deleted: merged,
    deletedAt: merged ? new Date() : null,
  };
}

/** Resolve a valid User ID for createdById on migrated orders. */
async function resolveMigrationUserId(cliArg: string | undefined): Promise<string> {
  // 1. Explicit --user=xxx flag
  if (cliArg) {
    const u = await prisma.user.findUnique({ where: { id: cliArg }, select: { id: true } });
    if (u) return u.id;
    console.error(`指定的 --user=${cliArg} 不存在，回退到自动解析`);
  }

  // 2. First ADMIN
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (admin) return admin.id;

  // 3. Any user
  const anyUser = await prisma.user.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  if (anyUser) return anyUser.id;

  throw new Error("数据库中无用户，无法确定迁移 createdById。请先用 --user=xxx 指定或先创建用户。");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const json = process.argv.includes("--json");
  const userArg = process.argv.find((a) => a.startsWith("--user="))?.split("=")[1];

  const migrationUserId = await resolveMigrationUserId(userArg);

  if (!json) console.log(`迁移用户: ${migrationUserId}`);

  const report: MigrateReport = {
    dryRun,
    totalExternalOrders: 0,
    created: 0,
    skipped: 0,
    recovered: 0,
    failed: 0,
    ordersCreated: 0,
    sourceRecordsCreated: 0,
    linesCreated: 0,
    projectLinksCreated: 0,
    mergesCreated: 0,
    receiptLinksUpdated: 0,
    errors: [],
  };

  // Fetch all ExternalOrders sorted for stable orderNo generation
  const externalOrders = await prisma.externalOrder.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      project: { select: { status: true } },
      importBatch: { select: { createdById: true } },
    },
  });

  report.totalExternalOrders = externalOrders.length;

  // Build legacyExternalOrderId → new Order.id mapping (for merge + receipt migration)
  const legacyToNewId = new Map<string, string>();

  // Sequence counters per date key for orderNo generation.
  // Initialised from existing Orders so retry-after-failure doesn't collide.
  const seqMap = new Map<string, number>();

  // Pre-seed seqMap from already-existing Order.orderNo values
  const existingOrders = await prisma.order.findMany({
    where: { legacyExternalOrderId: { not: null } },
    select: { orderNo: true, legacyExternalOrderId: true, id: true },
  });

  for (const o of existingOrders) {
    if (o.legacyExternalOrderId) {
      legacyToNewId.set(o.legacyExternalOrderId, o.id);
    }
    // Advance seqMap past this orderNo
    const match = o.orderNo.match(/^(?:PO|IO)-(\d{4})(\d{2})(\d{2})-(\d+)$/);
    if (match) {
      const dateKey = `${match[1]}${match[2]}${match[3]}`;
      const seq = parseInt(match[4], 10);
      const cur = seqMap.get(dateKey) ?? 0;
      if (seq >= cur) seqMap.set(dateKey, seq);
    }
  }

  function nextSeq(date: Date): number {
    const key = `${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}`;
    const cur = seqMap.get(key) ?? 0;
    seqMap.set(key, cur + 1);
    return cur + 1;
  }

  // For advancing seqMap past skipped records (avoids reusing orderNo on retry)
  function ensureSeqAdvanced(date: Date) {
    const key = `${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}`;
    const cur = seqMap.get(key) ?? 0;
    seqMap.set(key, cur + 1);
  }

  if (!json) {
    console.log(`模式: ${dryRun ? "DRY-RUN (只读，不写入)" : "WRITE (执行写入)"}`);
    console.log(`ExternalOrder 总数: ${externalOrders.length}`);
    if (existingOrders.length > 0) console.log(`已存在迁移订单: ${existingOrders.length}`);
    console.log("");
  }

  for (const eo of externalOrders) {
    try {
      // ── Idempotency check: both OrderSourceRecord AND legacyExternalOrderId ──
      const existingSrc = await prisma.orderSourceRecord.findUnique({
        where: {
          source_externalOrderNo: {
            source: normalizeSource(eo.source as string),
            externalOrderNo: eo.externalOrderNo,
          },
        },
        select: { orderId: true, id: true },
      });

      // Also check by legacyExternalOrderId (catches partial writes where Order was created
      // but OrderSourceRecord wasn't)
      const existingOrderByLegacy = !existingSrc?.orderId
        ? await prisma.order.findUnique({
            where: { legacyExternalOrderId: eo.id },
            select: { id: true },
          })
        : null;

      const existingOrderId = existingSrc?.orderId ?? existingOrderByLegacy?.id;

      if (existingOrderId) {
        legacyToNewId.set(eo.id, existingOrderId);
        const wasPartial = !existingSrc?.orderId && !!existingOrderByLegacy?.id;

        // Advance seqMap so retry doesn't reuse the same orderNo
        const refDate = eo.orderAt ?? eo.paidAt ?? eo.createdAt;
        ensureSeqAdvanced(refDate);

        if (wasPartial) {
          // Recover: create missing OrderSourceRecord and OrderLine
          if (!dryRun) {
            await recoverPartialMigration(eo, existingOrderId, migrationUserId, report);
          }
          report.recovered++;
        } else {
          report.skipped++;
        }
        continue;
      }

      // ── Determine merge status (double check: mergedIntoId || duplicateStatus === MERGED) ──
      const merged = isMergedSource(eo);

      const refDate = eo.orderAt ?? eo.paidAt ?? eo.createdAt;
      const seq = nextSeq(refDate);
      const orderData = buildOrderData(
        eo as unknown as Record<string, unknown>,
        refDate,
        seq,
        merged,
        eo.project?.status ?? null,
        migrationUserId,
      );

      if (dryRun) {
        report.created++;
        continue;
      }

      // ── Write Phase (per-order transaction) ──
      await prisma.$transaction(async (tx) => {
        // 1. Create Order
        const order = await tx.order.create({ data: orderData as never });
        report.ordersCreated++;
        legacyToNewId.set(eo.id, order.id);

        // 2. Create OrderSourceRecord
        const rawJson = buildRawJson(eo);
        await tx.orderSourceRecord.create({
          data: {
            orderId: order.id,
            importBatchId: eo.importBatchId,
            source: normalizeSource(eo.source as string),
            platform: eo.platform,
            externalOrderNo: eo.externalOrderNo,
            merchantOrderNo: eo.merchantOrderNo,
            duplicateGroupId: eo.duplicateGroupId,
            duplicateStatus: eo.duplicateStatus,
            rawJson,
            rawText: eo.rawJson ?? undefined,
          },
        });
        report.sourceRecordsCreated++;

        // 3. Create OrderLine(s)
        const linesCreated = await createOrderLines(tx as typeof prisma, eo, order.id, orderData.category, orderData.totalAmount);
        report.linesCreated += linesCreated;

        // 4. Create OrderProjectLink if projectId exists
        if (eo.projectId) {
          await tx.orderProjectLink.create({
            data: {
              orderId: order.id,
              projectId: eo.projectId,
              relationType: "LINKED",
              treatment: merged
                ? ORDER_FINANCE_TREATMENT.EXCLUDED
                : mapTreatment(eo.financeTreatment),
              isPrimary: true,
            },
          });
          report.projectLinksCreated++;
        }
      });

      report.created++;
    } catch (err) {
      report.failed++;
      const msg = `[${eo.id}] ${eo.externalOrderNo}: ${err instanceof Error ? err.message : String(err)}`;
      report.errors.push(msg);
      if (!json) console.error(`  ✗ ${msg}`);
    }
  }

  // ── Phase 2: Merge records ──
  if (!dryRun) {
    for (const eo of externalOrders) {
      const merged = isMergedSource(eo);
      if (!merged) continue;
      if (!eo.mergedIntoId) continue; // MERGED status but no target — skip merge record

      const sourceOrderId = legacyToNewId.get(eo.id);
      const targetOrderId = legacyToNewId.get(eo.mergedIntoId);
      if (!sourceOrderId || !targetOrderId) continue;

      const existingMerge = await prisma.orderMerge.findUnique({
        where: {
          sourceOrderId_targetOrderId: {
            sourceOrderId,
            targetOrderId,
          },
        },
      });
      if (!existingMerge) {
        await prisma.orderMerge.create({
          data: {
            sourceOrderId,
            targetOrderId,
            reason: `迁移自 ExternalOrder ${eo.id} → ${eo.mergedIntoId}`,
          },
        });
        report.mergesCreated++;
      }
    }
  }

  // ── Phase 3: Receipt orderId backfill ──
  if (!dryRun) {
    const receipts = await prisma.financeReceipt.findMany({
      where: { externalOrderId: { not: null }, orderId: null },
      select: { id: true, externalOrderId: true },
    });

    for (const r of receipts) {
      const newOrderId = legacyToNewId.get(r.externalOrderId!);
      if (newOrderId) {
        await prisma.financeReceipt.update({
          where: { id: r.id },
          data: { orderId: newOrderId },
        });
        report.receiptLinksUpdated++;
      }
    }
  }

  // ── Output ──
  printReport(report, dryRun, json);

  await prisma.$disconnect();
}

function buildRawJson(eo: Record<string, unknown>): string {
  return JSON.stringify({
    id: eo.id, source: eo.source, platform: eo.platform,
    externalOrderNo: eo.externalOrderNo, merchantOrderNo: eo.merchantOrderNo,
    storeName: eo.storeName, orderType: eo.orderType,
    receiverName: eo.receiverName, receiverPhone: eo.receiverPhone,
    receiverAddress: eo.receiverAddress, orderUser: eo.orderUser,
    orderUserTags: eo.orderUserTags,
    productNamesRaw: eo.productNamesRaw, productNamesJson: eo.productNamesJson,
    itemCount: eo.itemCount, itemTypeCount: eo.itemTypeCount,
    orderAt: eo.orderAt, paidAt: eo.paidAt,
    scheduledDeliveryText: eo.scheduledDeliveryText,
    sellerMessage: eo.sellerMessage, merchantRemark: eo.merchantRemark,
    formNote: eo.formNote,
    grossAmount: eo.grossAmount, priceAdjustment: eo.priceAdjustment,
    paidAmount: eo.paidAmount, shippingFee: eo.shippingFee,
    duplicateGroupId: eo.duplicateGroupId, duplicateStatus: eo.duplicateStatus,
    mergedIntoId: eo.mergedIntoId, reviewNote: eo.reviewNote,
    customerMatchStatus: eo.customerMatchStatus,
    customerMatchScore: eo.customerMatchScore,
    customerMatchReason: eo.customerMatchReason,
    financeCategory: eo.financeCategory, financeTreatment: eo.financeTreatment,
    financeAmountOverride: eo.financeAmountOverride,
    financeNote: eo.financeNote, rawJson: eo.rawJson,
  });
}

function mapTreatment(financeTreatment: string | null): string {
  if (financeTreatment === ORDER_FINANCE_TREATMENT.PROJECT_INCLUDED) return ORDER_FINANCE_TREATMENT.PROJECT_INCLUDED;
  if (financeTreatment === ORDER_FINANCE_TREATMENT.STANDALONE) return ORDER_FINANCE_TREATMENT.STANDALONE;
  if (financeTreatment === ORDER_FINANCE_TREATMENT.EXCLUDED) return ORDER_FINANCE_TREATMENT.EXCLUDED;
  return ORDER_FINANCE_TREATMENT.AUTO;
}

async function createOrderLines(
  tx: PrismaClient,
  eo: Record<string, unknown>,
  orderId: string,
  category: string,
  totalAmount: number,
): Promise<number> {
  let count = 0;
  const productNamesJson = eo.productNamesJson as string | null;

  if (productNamesJson) {
    try {
      const parsed = JSON.parse(productNamesJson);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const itemName = typeof item === "string" ? item : (item?.name || item?.itemName || `商品${i + 1}`);
        const amount = typeof item === "object" ? (item?.amount || item?.price || 0) : 0;
        await tx.orderLine.create({
          data: {
            orderId,
            itemName: String(itemName).slice(0, 200),
            spec: typeof item === "object" ? (item?.spec || null) : null,
            unit: typeof item === "object" ? (item?.unit || null) : null,
            quantity: typeof item === "object" ? (item?.quantity ?? null) : null,
            unitPrice: typeof item === "object" ? (item?.unitPrice ?? null) : null,
            amount: Number(amount) || 0,
            category,
            sortOrder: i,
            rawJson: typeof item === "object" ? JSON.stringify(item) : null,
          },
        });
        count++;
      }
    } catch {
      // Not valid JSON — fall through to fallback
    }
  }

  if (count === 0) {
    const itemName = (eo.productNamesRaw as string) || (eo.externalOrderNo as string) || "订单明细";
    await tx.orderLine.create({
      data: {
        orderId,
        itemName: String(itemName).slice(0, 200),
        amount: totalAmount,
        category,
        sortOrder: 0,
      },
    });
    count++;
  }

  return count;
}

async function recoverPartialMigration(
  eo: Record<string, unknown>,
  orderId: string,
  migrationUserId: string,
  report: MigrateReport,
) {
  // Create missing OrderSourceRecord
  const existingSrc = await prisma.orderSourceRecord.findUnique({
    where: {
      source_externalOrderNo: {
        source: normalizeSource(eo.source as string),
        externalOrderNo: eo.externalOrderNo as string,
      },
    },
  });

  if (!existingSrc) {
    await prisma.orderSourceRecord.create({
      data: {
        orderId,
        importBatchId: eo.importBatchId as string | null,
        source: normalizeSource(eo.source as string),
        platform: eo.platform as string | null,
        externalOrderNo: eo.externalOrderNo as string,
        merchantOrderNo: eo.merchantOrderNo as string | null,
        duplicateGroupId: eo.duplicateGroupId as string | null,
        duplicateStatus: (eo.duplicateStatus as string) ?? "UNREVIEWED",
        rawJson: buildRawJson(eo),
        rawText: eo.rawJson as string | undefined,
      },
    });
    report.sourceRecordsCreated++;
  }

  // Create missing OrderLines (only if none exist)
  const existingLines = await prisma.orderLine.count({ where: { orderId } });
  if (existingLines === 0) {
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { category: true, totalAmount: true } });
    if (order) {
      const count = await createOrderLines(
        prisma,
        eo,
        orderId,
        order.category,
        order.totalAmount,
      );
      report.linesCreated += count;
    }
  }

  // Create missing OrderProjectLink
  if (eo.projectId) {
    const existingLink = await prisma.orderProjectLink.findUnique({
      where: { orderId_projectId: { orderId, projectId: eo.projectId as string } },
    });
    if (!existingLink) {
      await prisma.orderProjectLink.create({
        data: {
          orderId,
          projectId: eo.projectId as string,
          relationType: "LINKED",
          treatment: isMergedSource({
            mergedIntoId: eo.mergedIntoId as string | null,
            duplicateStatus: eo.duplicateStatus as string | null,
          })
            ? ORDER_FINANCE_TREATMENT.EXCLUDED
            : mapTreatment(eo.financeTreatment as string | null),
          isPrimary: true,
        },
      });
      report.projectLinksCreated++;
    }
  }
}

function printReport(report: MigrateReport, dryRun: boolean, json: boolean) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("");
  console.log("═══════════════════════════════════════════");
  console.log("  迁移报告");
  console.log("═══════════════════════════════════════════");
  console.log(`ExternalOrder 总数:   ${report.totalExternalOrders}`);
  console.log(`新迁移:               ${report.created}`);
  console.log(`已迁移 (跳过):        ${report.skipped}`);
  console.log(`恢复 (补全):          ${report.recovered}`);
  console.log(`失败:                 ${report.failed}`);
  if (!dryRun) {
    console.log("");
    console.log("── 写入统计 ──");
    console.log(`Order 创建:           ${report.ordersCreated}`);
    console.log(`OrderSourceRecord:    ${report.sourceRecordsCreated}`);
    console.log(`OrderLine:            ${report.linesCreated}`);
    console.log(`OrderProjectLink:     ${report.projectLinksCreated}`);
    console.log(`OrderMerge:           ${report.mergesCreated}`);
    console.log(`回款 orderId 回填:    ${report.receiptLinksUpdated}`);
  }
  if (report.errors.length > 0) {
    console.log("");
    console.log(`── 错误 (${report.errors.length}) ──`);
    for (const e of report.errors) {
      console.log(`  ✗ ${e}`);
    }
  }
  if (dryRun) {
    console.log("");
    console.log("(dry-run 模式，未写入任何数据)");
  }
  console.log("═══════════════════════════════════════════");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
