import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isOrderAccessBlocked, getOrderScopeWhere } from "@/lib/orders/permissions";
import { yuanToCents, centsToYuan, roundForDisplay } from "@/lib/finance/money";
import type { Prisma } from "@prisma/client";

function formatYYYYMM(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();
  const {
    newTotalAmount,
    reason,
    effectiveAt,
    lines,
    allocations,
    syncProjectBudget,
  } = body as {
    newTotalAmount: number;
    reason: string;
    effectiveAt?: string;
    lines?: Array<{ id?: string; name: string; quantity?: number; unitPrice?: number; amount: number }>;
    allocations?: Array<{ projectId: string; allocatedAmount: number }>;
    syncProjectBudget?: boolean;
  };

  if (typeof newTotalAmount !== "number" || newTotalAmount < 0) {
    return NextResponse.json({ error: "新金额必须 >= 0" }, { status: 400 });
  }
  // 前端传入的是元，数据库存储是分，立即转换统一口径
  const newTotalAmountCents = yuanToCents(newTotalAmount);
  const linesCents = lines?.map((l) => ({
    ...l,
    unitPrice: l.unitPrice != null ? yuanToCents(l.unitPrice) : null,
    amount: yuanToCents(l.amount),
  }));
  const allocationsCents = allocations?.map((a) => ({
    ...a,
    allocatedAmount: yuanToCents(a.allocatedAmount),
  }));
  if (!reason || !reason.trim()) {
    return NextResponse.json({ error: "修订原因不能为空" }, { status: 400 });
  }

  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { sortOrder: "asc" } },
      projectLinks: { include: { project: { select: { id: true, status: true, startDate: true, createdAt: true, endDate: true } } } },
      receipts: { where: { deleted: false }, select: { amount: true } },
      invoiceRequests: {
        where: {
          status: { in: ["DRAFT", "REQUESTED", "ISSUED"] },
          adjustmentsAsOriginal: { none: { kind: "RED" } },
        },
        select: { id: true, totalAmount: true },
      },
      invoiceCoverage: {
        where: {
          invoiceRequest: {
            status: { in: ["DRAFT", "REQUESTED", "ISSUED"] },
            adjustmentsAsOriginal: { none: { kind: "RED" } },
          },
        },
        select: { invoiceRequest: { select: { id: true, totalAmount: true } } },
      },
    },
  });

  if (!order || order.deleted) {
    return NextResponse.json({ error: "订单不存在或已删除" }, { status: 404 });
  }

  const oldTotalAmount = order.totalAmount;
  const oldFinanceAmount = order.financeAmountOverride ?? oldTotalAmount;
  const newFinanceAmount = newTotalAmountCents;
  const deltaFinanceAmount = newFinanceAmount - oldFinanceAmount;

  if (Math.abs(deltaFinanceAmount) < 0.001) {
    return NextResponse.json({ error: "金额无变化，无需修订" }, { status: 400 });
  }

  // Compute issued/requested invoice total (dedup)
  const invoiceSeen = new Set<string>();
  let issuedInvoiceAmount = 0;
  for (const inv of order.invoiceRequests) {
    if (!invoiceSeen.has(inv.id)) {
      invoiceSeen.add(inv.id);
      issuedInvoiceAmount += inv.totalAmount;
    }
  }
  for (const cov of order.invoiceCoverage) {
    const inv = cov.invoiceRequest;
    if (inv && !invoiceSeen.has(inv.id)) {
      invoiceSeen.add(inv.id);
      issuedInvoiceAmount += inv.totalAmount;
    }
  }

  if (newFinanceAmount < issuedInvoiceAmount) {
    return NextResponse.json(
      { error: `新金额 ¥${centsToYuan(newFinanceAmount).toLocaleString()} 小于已开票金额 ¥${centsToYuan(issuedInvoiceAmount).toLocaleString()}，请先冲红或重开发票` },
      { status: 400 },
    );
  }

  const receivedAmount = order.receipts.reduce((s, r) => s + r.amount, 0);
  const overReceived = newFinanceAmount < receivedAmount;

  // Multi-project validation
  if (order.projectLinks.length > 1) {
    if (!allocationsCents || allocationsCents.length === 0) {
      return NextResponse.json({ error: "多项目订单必须提供分摊金额" }, { status: 400 });
    }
    // Must cover all linked projects exactly once
    if (allocationsCents.length !== order.projectLinks.length) {
      return NextResponse.json(
        { error: `分摊项目数 (${allocationsCents.length}) 与关联项目数 (${order.projectLinks.length}) 不一致` },
        { status: 400 },
      );
    }
    const allocProjectIds = allocationsCents.map((a) => a.projectId);
    if (new Set(allocProjectIds).size !== allocProjectIds.length) {
      return NextResponse.json({ error: "分摊项目 ID 重复" }, { status: 400 });
    }
    for (const alloc of allocationsCents) {
      if (!Number.isFinite(alloc.allocatedAmount) || alloc.allocatedAmount < 0) {
        return NextResponse.json({ error: `项目 ${alloc.projectId} 的分摊金额无效` }, { status: 400 });
      }
      if (!order.projectLinks.some((l) => l.projectId === alloc.projectId)) {
        return NextResponse.json({ error: `项目 ${alloc.projectId} 未关联到此订单` }, { status: 400 });
      }
      // Require existing allocatedAmount for multi-project orders
      const link = order.projectLinks.find((l) => l.projectId === alloc.projectId)!;
      if (link.allocatedAmount == null) {
        return NextResponse.json(
          { error: `项目 ${alloc.projectId} 的当前分摊金额未设置，请先在订单详情中补齐分摊` },
          { status: 400 },
        );
      }
    }
    const allocSum = allocationsCents.reduce((s, a) => s + a.allocatedAmount, 0);
    if (Math.abs(allocSum - newFinanceAmount) > 0.01) {
      return NextResponse.json(
        { error: `分摊合计 ¥${centsToYuan(allocSum).toLocaleString()} 不等于新金额 ¥${centsToYuan(newFinanceAmount).toLocaleString()}` },
        { status: 400 },
      );
    }
  }

  let effectiveAtDate: Date;
  if (effectiveAt) {
    effectiveAtDate = new Date(effectiveAt);
    if (Number.isNaN(effectiveAtDate.getTime())) {
      return NextResponse.json({ error: "生效日期格式无效" }, { status: 400 });
    }
  } else {
    effectiveAtDate = new Date();
  }
  if (effectiveAtDate > new Date()) {
    return NextResponse.json({ error: "生效日期不能是未来日期" }, { status: 400 });
  }
  const effectivePeriod = formatYYYYMM(effectiveAtDate);

  // Compute next revisionNo
  const lastRevision = await prisma.orderRevision.findFirst({
    where: { orderId: id },
    orderBy: { revisionNo: "desc" },
    select: { revisionNo: true },
  });
  const revisionNo = (lastRevision?.revisionNo ?? 0) + 1;

  // Build snapshot (all values in cents)
  const snapshot = {
    oldTotalAmount,
    newTotalAmount: newTotalAmountCents,
    oldFinanceAmount,
    newFinanceAmount,
    deltaFinanceAmount,
    lines: order.lines.map((l) => ({
      itemName: l.itemName, quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount,
    })),
    projectLinks: order.projectLinks.map((l) => ({
      projectId: l.projectId, treatment: l.treatment, allocatedAmount: l.allocatedAmount, isPrimary: l.isPrimary,
    })),
    receivedAmount,
    issuedInvoiceAmount,
    overReceived,
  };

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Create revision record
      const revision = await tx.orderRevision.create({
        data: {
          orderId: id,
          revisionNo,
          oldTotalAmount,
          newTotalAmount: newTotalAmountCents,
          deltaTotalAmount: newTotalAmountCents - oldTotalAmount,
          oldFinanceAmount,
          newFinanceAmount,
          deltaFinanceAmount,
          effectiveAt: effectiveAtDate,
          effectivePeriod,
          reason: reason.trim(),
          snapshotJson: JSON.stringify(snapshot),
          createdById: session.user.id,
        },
      });

      // 2. Update order totalAmount
      await tx.order.update({
        where: { id },
        data: { totalAmount: newTotalAmountCents, financeAmountOverride: newFinanceAmount },
      });

      // 3. Sync OrderLine if provided
      if (linesCents) {
        // Delete and re-create lines
        await tx.orderLine.deleteMany({ where: { orderId: id } });
        for (let i = 0; i < linesCents.length; i++) {
          const l = linesCents[i];
          await tx.orderLine.create({
            data: {
              orderId: id,
              itemName: l.name,
              quantity: l.quantity ?? null,
              unitPrice: l.unitPrice ?? null,
              amount: l.amount,
              sortOrder: i,
            },
          });
        }
      }

      // 4. Sync OrderProjectLink
      // Profile-only：快照只写 profileId。
      const adjustments: Prisma.ProgressReceivableAdjustmentUncheckedCreateInput[] = [];

      if (order.projectLinks.length === 1) {
        const link = order.projectLinks[0];
        const oldAllocated = link.allocatedAmount ?? oldFinanceAmount;
        const newAllocated = newFinanceAmount;
        const deltaAllocated = newAllocated - oldAllocated;

        await tx.orderProjectLink.update({
          where: { id: link.id },
          data: { allocatedAmount: newAllocated },
        });

        if (syncProjectBudget) {
          const project = await tx.project.findUnique({
            where: { id: link.projectId },
            select: { id: true, budgetAmount: true, budgetAmountSource: true },
          });
          if (project && (project.budgetAmountSource === "ORDER_LINK" || project.budgetAmountSource == null)) {
            const newBudget = (project.budgetAmount ?? 0) + deltaAllocated;
            await tx.project.update({
              where: { id: link.projectId },
              data: { budgetAmount: Math.max(0, newBudget), budgetAmountSource: "ORDER_LINK" },
            });
          }
        }

        // Compute adjustment for single project
        const adjAmount = computeRevisionAdjustment(
          order.category,
          order.financeTreatment,
          deltaAllocated,
          link.project,
        );
        if (Math.abs(adjAmount) > 0.001) {
          adjustments.push({
            sourceType: "ORDER_REVISION",
            sourceId: revision.id,
            orderId: id,
            projectId: link.projectId,
            profileId: order.profileId,
            periodKey: effectivePeriod,
            occurredAt: effectiveAtDate,
            amount: adjAmount,
            category: "ORDER_REVISION",
            reason: reason.trim(),
            createdById: session.user.id,
          });
        }
      } else if (order.projectLinks.length > 1 && allocationsCents) {
        for (const alloc of allocationsCents) {
          const link = order.projectLinks.find((l) => l.projectId === alloc.projectId)!;
          const oldAllocated = link.allocatedAmount!;
          const deltaAllocated = alloc.allocatedAmount - oldAllocated;

          await tx.orderProjectLink.update({
            where: { id: link.id },
            data: { allocatedAmount: alloc.allocatedAmount },
          });

          if (syncProjectBudget) {
            const project = await tx.project.findUnique({
              where: { id: link.projectId },
              select: { id: true, budgetAmount: true, budgetAmountSource: true },
            });
            if (project && (project.budgetAmountSource === "ORDER_LINK" || project.budgetAmountSource == null)) {
              const newBudget = (project.budgetAmount ?? 0) + deltaAllocated;
              await tx.project.update({
                where: { id: link.projectId },
                data: { budgetAmount: Math.max(0, newBudget), budgetAmountSource: "ORDER_LINK" },
              });
            }
          }

          const adjAmount = computeRevisionAdjustment(
            order.category,
            order.financeTreatment,
            deltaAllocated,
            link.project,
          );
          if (Math.abs(adjAmount) > 0.001) {
            adjustments.push({
              sourceType: "ORDER_REVISION",
              sourceId: revision.id,
              orderId: id,
              projectId: link.projectId,
              profileId: order.profileId,
              periodKey: effectivePeriod,
              occurredAt: effectiveAtDate,
              amount: adjAmount,
              category: "ORDER_REVISION",
              reason: reason.trim(),
              createdById: session.user.id,
            });
          }
        }
      } else {
        // Standalone (no project links)
        const adjAmount = computeRevisionAdjustment(
          order.category,
          order.financeTreatment,
          deltaFinanceAmount,
          null,
        );
        if (Math.abs(adjAmount) > 0.001) {
          adjustments.push({
            sourceType: "ORDER_REVISION",
            sourceId: revision.id,
            orderId: id,
            projectId: null,
            profileId: order.profileId,
            periodKey: effectivePeriod,
            occurredAt: effectiveAtDate,
            amount: adjAmount,
            category: "ORDER_REVISION",
            reason: reason.trim(),
            createdById: session.user.id,
          });
        }
      }

      // 5. Create adjustments
      const createdAdjustments = [];
      for (const adj of adjustments) {
        const created = await tx.progressReceivableAdjustment.create({ data: adj });
        createdAdjustments.push(created);
      }

      // 6. Log status history
      await tx.orderStatusHistory.create({
        data: {
          orderId: id,
          oldStatus: order.status,
          newStatus: order.status,
          note: `金额修订 #${revisionNo}: ¥${centsToYuan(oldTotalAmount).toLocaleString()} → ¥${centsToYuan(newTotalAmountCents).toLocaleString()} (${deltaFinanceAmount >= 0 ? "+" : ""}¥${centsToYuan(deltaFinanceAmount).toLocaleString()})`,
          createdById: session.user.id,
        },
      });

      return { revision, adjustments: createdAdjustments };
    });

    const updatedOrder = await prisma.order.findUnique({
      where: { id },
      select: { id: true, orderNo: true, totalAmount: true },
    });

    return NextResponse.json({
      revision: result.revision,
      adjustments: result.adjustments,
      order: updatedOrder,
      warning: overReceived ? `新金额 ¥${centsToYuan(newFinanceAmount).toLocaleString()} 小于已到款 ¥${centsToYuan(receivedAmount).toLocaleString()}，订单已超收` : undefined,
    }, { status: 201 });
  } catch (e: unknown) {
    if (e instanceof Error) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}

/**
 * Compute the progress receivable adjustment amount for a revision.
 * Matches the spec rules:
 *  - Product: 100% of delta
 *  - Standalone service: 30% of delta
 *  - Project-linked service: depends on project delivery status
 */
function computeRevisionAdjustment(
  category: string,
  financeTreatment: string,
  deltaAmountCents: number,
  project: { status: string; startDate: Date | null; createdAt: Date; endDate: Date | null } | null,
): number {
  // deltaAmountCents 是分（财务口径），结果存入 ProgressReceivableAdjustment（看板口径 Float 元）
  // 转回元做比例计算，roundForDisplay 收尾
  const deltaYuan = centsToYuan(deltaAmountCents);
  const treatment = financeTreatment === "AUTO" ? (project ? "PROJECT_INCLUDED" : "STANDALONE") : financeTreatment;

  if (category === "PRODUCT" || category === "UNKNOWN") {
    return roundForDisplay(deltaYuan);
  }

  // SERVICE
  if (treatment === "STANDALONE" || treatment === "EXCLUDED" || !project) {
    return roundForDisplay(deltaYuan * 0.3);
  }

  // PROJECT_INCLUDED service
  if (project.status === "NOT_STARTED") {
    return 0;
  }

  if (project.status === "COMPLETED") {
    return roundForDisplay(deltaYuan);
  }

  // IN_PROGRESS or other: 30%
  return roundForDisplay(deltaYuan * 0.3);
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isOrderAccessBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const order = await prisma.order.findUnique({
    where: { id },
    select: { id: true, deleted: true },
  });
  if (!order || order.deleted) return NextResponse.json({ error: "Not Found" }, { status: 404 });

  // Scope check: verify user can read this order
  if (session.user.role !== "ADMIN") {
    const scopeWhere = await getOrderScopeWhere(session.user.id, session.user.role, prisma, session.user.department);
    if (scopeWhere) {
      const inScope = await prisma.order.count({ where: { id, AND: [scopeWhere] } });
      if (inScope === 0) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const revisions = await prisma.orderRevision.findMany({
    where: { orderId: id },
    orderBy: { revisionNo: "desc" },
    include: {
      createdBy: { select: { id: true, name: true } },
      adjustments: true,
    },
  });

  return NextResponse.json({
    revisions: revisions.map((r) => ({
      ...r,
      oldTotalAmount: centsToYuan(r.oldTotalAmount),
      newTotalAmount: centsToYuan(r.newTotalAmount),
      deltaTotalAmount: centsToYuan(r.deltaTotalAmount),
      oldFinanceAmount: centsToYuan(r.oldFinanceAmount),
      newFinanceAmount: centsToYuan(r.newFinanceAmount),
      deltaFinanceAmount: centsToYuan(r.deltaFinanceAmount),
    })),
  });
}
