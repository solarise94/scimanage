import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { targetOrderId, sourceOrderIds, reason } = body as { targetOrderId?: string; sourceOrderIds?: string[]; reason?: string };

  if (!targetOrderId || !sourceOrderIds || !Array.isArray(sourceOrderIds) || sourceOrderIds.length === 0) {
    return NextResponse.json({ error: "targetOrderId and sourceOrderIds are required" }, { status: 400 });
  }
  if (sourceOrderIds.includes(targetOrderId)) {
    return NextResponse.json({ error: "不能合并到自身" }, { status: 400 });
  }

  const target = await prisma.order.findUnique({ where: { id: targetOrderId }, select: { id: true, deleted: true } });
  if (!target) return NextResponse.json({ error: "目标订单不存在" }, { status: 404 });
  if (target.deleted) return NextResponse.json({ error: "目标订单已删除" }, { status: 400 });

  let merged = 0;
  const errors: string[] = [];

  for (const sourceId of sourceOrderIds) {
    try {
      const source = await prisma.order.findUnique({ where: { id: sourceId }, select: { id: true, deleted: true } });
      if (!source) { errors.push(`源订单 ${sourceId} 不存在`); continue; }
      if (source.deleted) { errors.push(`源订单 ${sourceId} 已删除`); continue; }

      const existingMerge = await prisma.orderMerge.findUnique({
        where: { sourceOrderId_targetOrderId: { sourceOrderId: sourceId, targetOrderId } },
      });
      if (existingMerge) continue;

      await prisma.$transaction(async (tx) => {
        // Migrate source records
        await tx.orderSourceRecord.updateMany({
          where: { orderId: sourceId },
          data: { orderId: targetOrderId },
        });

        // Migrate project links (skip conflicts)
        const sourceLinks = await tx.orderProjectLink.findMany({ where: { orderId: sourceId } });
        for (const link of sourceLinks) {
          const exists = await tx.orderProjectLink.findUnique({
            where: { orderId_projectId: { orderId: targetOrderId, projectId: link.projectId } },
          });
          if (!exists) {
            await tx.orderProjectLink.create({
              data: {
                orderId: targetOrderId,
                projectId: link.projectId,
                relationType: link.relationType,
                treatment: link.treatment,
                allocatedAmount: link.allocatedAmount,
                isPrimary: link.isPrimary,
                createdById: session.user.id,
              },
            });
          }
        }

        // Migrate receipts (skip deleted)
        await tx.financeReceipt.updateMany({
          where: { orderId: sourceId, deleted: false },
          data: { orderId: targetOrderId },
        });

        // Create merge record
        await tx.orderMerge.create({
          data: { sourceOrderId: sourceId, targetOrderId, reason: reason || null, createdById: session.user.id },
        });

        // Delete source
        await tx.order.update({
          where: { id: sourceId },
          data: { deleted: true, deletedAt: new Date(), archived: true, financeTreatment: "EXCLUDED" },
        });
      });

      merged++;
    } catch (err) {
      errors.push(`合并 ${sourceId} 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return NextResponse.json({ merged, errors });
}
