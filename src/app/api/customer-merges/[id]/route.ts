import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getMergePreview } from "@/lib/customers/customer-dedup";

/** GET /api/customer-merges/[id] — get merge preview */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const currentUser = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!currentUser || currentUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const preview = await getMergePreview(id);
  if (!preview) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(preview);
}

/**
 * PATCH /api/customer-merges/[id] — guarded task status transition.
 *
 * 双向条件更新（4-B.2 + 4-B.3），所有迁移用 updateMany + 条件 where + count===0 → 409：
 *  - ignore / supersede：PENDING → IGNORED / SUPERSEDED
 *  - reopen：IGNORED → PENDING（无条件）
 *  - reset：PROCESSING → PENDING（需 updatedAt < now-5min，避免误重置正在执行的合并）
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const currentUser = await prisma.user.findUnique({ where: { id: session.user.id }, select: { id: true, role: true } });
  if (!currentUser || currentUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();
  const { status, resolutionNote } = body;

  if (!["IGNORED", "SUPERSEDED", "PENDING"].includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  // 条件前置：reopen/reset（→PENDING）从 IGNORED 或 (PROCESSING 且 >5min) 转入；
  // ignore/supersede（→IGNORED/SUPERSEDED）只允许从 PENDING 转入。
  // 条件前置：reopen/reset（->PENDING）从 IGNORED、STALE 或 (PROCESSING 且 >5min) 转入；
  // ignore/supersede（->IGNORED/SUPERSEDED）只允许从 PENDING 转入。
  const STALE_PROCESSING_MS = 5 * 60 * 1000;
  const whereClause: Record<string, unknown> =
    status === "PENDING"
      ? {
          id,
          OR: [
            { status: "IGNORED" },
            { status: "STALE" },
            { status: "PROCESSING", updatedAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) } },
          ],
        }
      : { id, status: "PENDING" };

  const result = await prisma.customerMergeTask.updateMany({
    where: whereClause,
    data: {
      status,
      // reopen/reset 清空处理人，回到全新待处理；ignore/supersede 记录处理人
      resolvedById: status === "PENDING" ? null : currentUser.id,
      resolvedAt: status === "PENDING" ? null : new Date(),
      resolutionNote: resolutionNote || null,
    },
  });

  if (result.count === 0) {
    const current = await prisma.customerMergeTask.findUnique({ where: { id }, select: { status: true } });
    return NextResponse.json({ error: `任务状态已变更（当前: ${current?.status ?? "不存在"}）` }, { status: 409 });
  }

  // updateMany 不返回更新后的对象；前端各 mutation 的 onSuccess 不读返回值（仅靠 invalidate 刷新）。
  return NextResponse.json({ ok: true, status });
}
