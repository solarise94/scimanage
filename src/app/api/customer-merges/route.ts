import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { executeMerge } from "@/lib/customers/customer-merge";

/** GET /api/customer-merges — list merge tasks (W4: profileA/B 为主展示) */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const currentUser = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!currentUser || currentUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status") || "PENDING";
  const tier = searchParams.get("tier") || "";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(10, parseInt(searchParams.get("pageSize") || "20") || 20));

  const where: Record<string, unknown> = {};
  if (status !== "ALL") where.status = status;
  if (tier) where.matchTier = tier;

  const profileSelect = {
    id: true,
    deleted: true,
    name: true,
    customerCode: true,
    organization: true,
    org: { select: { canonicalName: true } },
  } as const;

  const [tasks, total] = await Promise.all([
    prisma.customerMergeTask.findMany({
      where,
      include: {
        profileA: { select: profileSelect },
        profileB: { select: profileSelect },
      },
      orderBy: [{ matchTier: "asc" }, { matchScore: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.customerMergeTask.count({ where }),
  ]);

  return NextResponse.json({ tasks, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
}

/**
 * POST /api/customer-merges — execute a merge from the review console.
 *
 * W4：sourceProfileId / targetProfileId 为合并主键（CrmCustomerProfile.id）。
 * sourceId / targetId 仅为同义字段名别名，值必须是 Profile ID，不接受 Customer.id。
 * 状态机不变：
 *   PENDING →(原子抢占)→ PROCESSING →(preflight 失败)→ SUPERSEDED
 *                                    →(executeMerge 成功)→ MERGED
 *                                    →(executeMerge 异常)→ 停留 PROCESSING（由 reset 治理）
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const currentUser = await prisma.user.findUnique({ where: { id: session.user.id }, select: { id: true, role: true } });
  if (!currentUser || currentUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const {
    taskId,
    sourceProfileId: bodySourceProfileId,
    targetProfileId: bodyTargetProfileId,
    sourceId,
    targetId,
    profileResolution,
    orgResolution,
  } = body;

  const sourceProfileId = bodySourceProfileId ?? sourceId;
  const targetProfileId = bodyTargetProfileId ?? targetId;

  if (!taskId || !sourceProfileId || !targetProfileId) {
    return NextResponse.json(
      {
        error:
          "taskId、sourceProfileId、targetProfileId 均为必填（sourceId/targetId 为 Profile ID 别名，非 Customer.id）",
      },
      { status: 400 },
    );
  }
  if (sourceProfileId === targetProfileId) {
    return NextResponse.json({ error: "源客户与目标客户不能相同" }, { status: 400 });
  }

  const taskPair = await prisma.customerMergeTask.findUnique({
    where: { id: taskId },
    select: { profileIdA: true, profileIdB: true },
  });
  if (!taskPair) {
    return NextResponse.json({ error: "合并任务不存在" }, { status: 404 });
  }
  const requestedPair = new Set([sourceProfileId, targetProfileId]);
  if (
    requestedPair.size !== 2
    || !requestedPair.has(taskPair.profileIdA)
    || !requestedPair.has(taskPair.profileIdB)
  ) {
    return NextResponse.json({ error: "源/目标客户与合并任务不匹配" }, { status: 400 });
  }

  const claimed = await prisma.customerMergeTask.updateMany({
    where: { id: taskId, status: "PENDING" },
    data: { status: "PROCESSING", resolvedById: currentUser.id },
  });
  if (claimed.count === 0) {
    const current = await prisma.customerMergeTask.findUnique({ where: { id: taskId }, select: { status: true } });
    return NextResponse.json(
      { error: `任务状态已变更（当前: ${current?.status ?? "不存在"}），无法合并` },
      { status: 409 },
    );
  }

  const [src, tgt] = await Promise.all([
    prisma.crmCustomerProfile.findUnique({
      where: { id: sourceProfileId },
      select: { deleted: true, mergedIntoProfileId: true },
    }),
    prisma.crmCustomerProfile.findUnique({
      where: { id: targetProfileId },
      select: { deleted: true, mergedIntoProfileId: true },
    }),
  ]);
  if (!src || src.deleted || src.mergedIntoProfileId || !tgt || tgt.deleted || tgt.mergedIntoProfileId) {
    await prisma.customerMergeTask.update({
      where: { id: taskId },
      data: { status: "SUPERSEDED", resolvedAt: new Date(), resolutionNote: "合并前检测到客户已被合并或删除" },
    });
    return NextResponse.json({ error: "源/目标客户已被合并或删除" }, { status: 409 });
  }

  try {
    const result = await executeMerge(
      sourceProfileId,
      targetProfileId,
      profileResolution || "KEEP_SOURCE",
      orgResolution || "KEEP_TARGET_ORG",
      currentUser.id,
    );

    const finalized = await prisma.customerMergeTask.updateMany({
      where: { id: taskId, status: "PROCESSING", resolvedById: currentUser.id },
      data: {
        status: "MERGED",
        resolvedAt: new Date(),
        mergeLogId: result.mergeLogId,
      },
    });

    if (finalized.count === 0) {
      console.warn(
        `[CUSTOMER_MERGE] task ${taskId} 合并完成时已不再由本请求持有（疑似并发 reset+重新抢占），mergeLogId=${result.mergeLogId}`,
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "合并失败" }, { status: 400 });
  }
}
