import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { prisma } from "@/lib/prisma";
import { assertInvoiceNotOccupied, validateTouchedOrders } from "@/lib/finance/order-invoices";
import { releaseInvoiceClaimsForRequest } from "@/lib/finance/invoice-claims";
import { syncOrderInvoiceStatus } from "@/lib/external-order";
import { yuanToCents, centsToYuan } from "@/lib/finance/money";
import { sendInvoiceAdjustedEmail } from "@/lib/business-email/notify";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const original = await prisma.externalOrderInvoiceRequest.findUnique({
    where: { id },
    include: {
      orderCoverage: { select: { orderId: true, amount: true } },
      order: { select: { id: true } },
    },
  });

  if (!original) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (original.status !== "ISSUED") {
    return NextResponse.json({ error: "只有已开票的发票才能重开" }, { status: 400 });
  }

  // Check if already has any adjustment
  const existingAdjustment = await prisma.invoiceAdjustment.findFirst({
    where: { originalInvoiceId: id },
  });
  if (existingAdjustment?.kind === "RED") {
    return NextResponse.json({ error: "该发票已冲红，不能重开" }, { status: 400 });
  }
  if (existingAdjustment?.kind === "REISSUE") {
    return NextResponse.json({ error: "该发票已重开，不能重复重开" }, { status: 400 });
  }

  // §9.1: Check invoice occupation before allowing REISSUE (same as RED)
  try {
    await assertInvoiceNotOccupied(id);
  } catch (err: unknown) {
    const e = err as { status?: number; body?: unknown };
    if (e.status === 409) {
      return NextResponse.json(e.body, { status: 409 });
    }
    throw err;
  }

  const body = await req.json();
  const {
    reason,
    contactName, sellerProfileId,
    sellerName,
    buyerOrganizationId, buyerOrganizationName, buyerTaxId,
    invoiceType, contentSummary, remark, items, taxIdFromLookup,
    coverageAllocations,
  } = body as Record<string, unknown>;

  // 解析 coverageAllocations（新契约）
  const rawAllocations = Array.isArray(coverageAllocations) ? coverageAllocations : [];
  const parsedAllocations: Array<{ orderId: string; amountCents: number }> = [];
  for (const a of rawAllocations) {
    if (!a || typeof a !== "object") continue;
    const oid = (a as Record<string, unknown>).orderId;
    const amt = (a as Record<string, unknown>).amountCents;
    if (typeof oid !== "string" || typeof amt !== "number" || !Number.isFinite(amt) || amt <= 0) {
      return NextResponse.json({ error: "coverageAllocations 每项需包含 orderId 与正整数 amountCents" }, { status: 400 });
    }
    parsedAllocations.push({ orderId: oid, amountCents: Math.round(amt) });
  }

  const itemRows = (Array.isArray(items) ? items : []).filter((it: Record<string, unknown>) => (it.itemName as string)?.trim());
  const totalAmount = itemRows.reduce((sum: number, it: Record<string, unknown>) => sum + yuanToCents(Number(it.amount) || 0), 0);
  if (totalAmount <= 0) {
    return NextResponse.json({ error: "发票金额必须大于 0" }, { status: 400 });
  }

  // 单主订单恒等派生：未传 coverageAllocations 时，按发票全额归属原主订单
  const allocByOrder = new Map<string, number>();
  for (const a of parsedAllocations) {
    allocByOrder.set(a.orderId, (allocByOrder.get(a.orderId) || 0) + a.amountCents);
  }
  if (parsedAllocations.length === 0) {
    if (!original.orderId) {
      return NextResponse.json({ error: "原发票未关联订单，无法自动派生 coverageAllocations" }, { status: 400 });
    }
    allocByOrder.set(original.orderId, totalAmount);
  }

  const touchedOrderIds = [...allocByOrder.keys()];

  // 主订单必须包含在 coverageAllocations 中（完整分摊表）
  if (original.orderId && !touchedOrderIds.includes(original.orderId)) {
    return NextResponse.json({ error: "coverageAllocations 必须包含原发票主订单" }, { status: 400 });
  }

  // 校验所有 touched 订单：存在、有结构化购买方机构、剩余可开票额度充足、跨机构校验
  // （与 POST 创建路径共享同一份校验逻辑；excludeInvoiceId 跳过正在被重开的原发票自身）
  const touchedValidation = await validateTouchedOrders(touchedOrderIds, allocByOrder, {
    allowCrossOrgInvoice: !!(body as Record<string, unknown>).allowCrossOrgInvoice,
    excludeInvoiceId: id,
  });
  if (!touchedValidation.ok) {
    return NextResponse.json(touchedValidation.body, { status: touchedValidation.status });
  }

  if (!buyerOrganizationName || !(buyerOrganizationName as string).trim()) {
    return NextResponse.json({ error: "对方公司名称不能为空" }, { status: 400 });
  }

  // G2.1: Verify buyer org is invoice subject（与 POST 创建路径一致）
  if (buyerOrganizationId) {
    const buyerOrg = await prisma.organization.findUnique({
      where: { id: buyerOrganizationId as string },
      select: { isInvoiceSubject: true, deleted: true },
    });
    if (!buyerOrg || buyerOrg.deleted) {
      return NextResponse.json({ error: "指定的买方单位不存在" }, { status: 400 });
    }
    if (!buyerOrg.isInvoiceSubject) {
      return NextResponse.json({ error: "指定的买方单位未完成税务验真，不能作开票买方" }, { status: 400 });
    }
  }

  // Resolve seller profile
  let sellerSnapshot: Record<string, unknown> = {};
  if (sellerProfileId) {
    const profile = await prisma.billingProfile.findUnique({ where: { id: sellerProfileId as string } });
    if (profile) {
      sellerSnapshot = {
        sellerProfileId: profile.id, sellerName: profile.name,
        sellerTaxId: profile.taxId || null, sellerBankName: profile.bankName || null,
        sellerBankAccount: profile.bankAccount || null, sellerAddress: profile.address || null,
        sellerPhone: profile.phone || null,
      };
    }
  }
  if (!sellerSnapshot.sellerName && (sellerName as string)?.trim()) {
    sellerSnapshot.sellerName = (sellerName as string).trim();
  }

  const coverageTotal = [...allocByOrder.values()].reduce((s, v) => s + v, 0);
  if (coverageTotal !== totalAmount) {
    return NextResponse.json(
      { error: `coverageAllocations 合计 ${coverageTotal / 100} 元与发票金额 ${totalAmount / 100} 元不一致` },
      { status: 400 },
    );
  }

  // Build remark with reissue note appended
  const finalRemark = remark
    ? `${remark}\n[重开原发票: ${id}]`
    : `[重开原发票: ${id}]`;

  let newInvoice;
  try {
    newInvoice = await prisma.$transaction(async (tx) => {
      // 事务内再次复核剩余可开票额度（原发票已按 excludeInvoiceId 释放额度）
      const txValidation = await validateTouchedOrders(touchedOrderIds, allocByOrder, {
        allowCrossOrgInvoice: !!(body as Record<string, unknown>).allowCrossOrgInvoice,
        excludeInvoiceId: id,
        tx,
      });
      if (!txValidation.ok) {
        throw Object.assign(new Error("INVOICEABLE_EXCEEDED"), {
          status: txValidation.status,
          body: txValidation.body,
        });
      }

      const inv = await tx.externalOrderInvoiceRequest.create({
        data: {
          orderId: original.orderId,
          externalOrderId: original.externalOrderId,
          contactName: (contactName as string)?.trim() || null,
          ...sellerSnapshot,
          buyerOrganizationId: (buyerOrganizationId as string) || null,
          buyerOrganizationName: (buyerOrganizationName as string).trim(),
          buyerTaxId: (buyerTaxId as string)?.trim() || null,
          buyerTaxIdFromLookup: !!taxIdFromLookup,
          invoiceType: invoiceType === "SPECIAL" ? "SPECIAL" : "NORMAL",
          contentSummary: (contentSummary as string)?.trim() || null,
          totalAmount,
          remark: finalRemark,
          status: "DRAFT",
          createdById: session.user.id,
          items: itemRows.length > 0 ? {
            create: itemRows.map((it: Record<string, unknown>, i: number) => ({
              itemName: (it.itemName as string).trim(),
              spec: (it.spec as string)?.trim() || null,
              unit: (it.unit as string)?.trim() || null,
              quantity: it.quantity != null ? Number(it.quantity) : null,
              amount: yuanToCents(Number(it.amount) || 0),
              sortOrder: i,
            })),
          } : undefined,
        },
      });

      // §3.1 / §4.1：为所有 touched order 写 coverage 行 + amount
      for (const [oid, amount] of allocByOrder.entries()) {
        await tx.orderInvoiceCoverage.create({
          data: { invoiceRequestId: inv.id, orderId: oid, amount },
        });
      }

      // Create adjustment record
      await tx.invoiceAdjustment.create({
        data: {
          kind: "REISSUE",
          reason: (reason as string)?.trim() || null,
          originalInvoiceId: id,
          newInvoiceId: inv.id,
          createdById: session.user.id,
        },
      });

      // 原发票被重开后不再计入「有效发票」判重，释放占用锁
      await releaseInvoiceClaimsForRequest(tx, id);

      return inv;
    });
  } catch (err) {
    if (err && typeof err === "object" && "message" in err && (err as { message: string }).message === "INVOICEABLE_EXCEEDED") {
      const e = err as unknown as { status: number; body: Record<string, unknown> };
      return NextResponse.json(e.body, { status: e.status });
    }
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002") {
      return NextResponse.json({ error: "该发票已冲红或已重开，不能重开" }, { status: 409 });
    }
    throw err;
  }

  const full = await prisma.externalOrderInvoiceRequest.findUnique({
    where: { id: newInvoice.id },
    include: {
      items: { orderBy: { sortOrder: "asc" } },
      createdBy: { select: { id: true, name: true } },
      orderCoverage: { select: { amount: true, order: { select: { id: true, orderNo: true } } } },
    },
  });

  // Sync legacy ExternalOrder.invoiceStatus for all touched orders（与 POST 创建路径一致）
  for (const oid of touchedOrderIds) {
    const ord = await prisma.order.findUnique({
      where: { id: oid },
      select: { legacyExternalOrderId: true },
    });
    const legacyId = ord?.legacyExternalOrderId ?? null;
    if (legacyId) {
      await syncOrderInvoiceStatus(prisma, legacyId, oid);
    }
    await syncOrderInvoiceStatus(prisma, oid, oid);
  }

  // 邮件 F：发票重开，通知财务部（引用新发票，fail-closed，不阻塞）
  await sendInvoiceAdjustedEmail({
    invoiceId: newInvoice.id,
    kind: "REISSUE",
    reason: (reason as string)?.trim() || null,
    operatorName: session.user.name || "管理员",
  });

  return NextResponse.json({
    invoice: full
      ? {
          ...full,
          totalAmount: centsToYuan(full.totalAmount),
          items: full.items.map((it) => ({ ...it, amount: centsToYuan(it.amount) })),
          orderCoverage: full.orderCoverage.map((c) => ({ ...c, amount: centsToYuan(c.amount) })),
        }
      : null,
  }, { status: 201 });
}
