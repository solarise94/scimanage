import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { scanDuplicateCustomerPairs } from "@/lib/customers/customer-dedup";

/** POST /api/customer-merges/scan - trigger dedup scan */
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const currentUser = await prisma.user.findUnique({ where: { id: session.user.id }, select: { id: true, role: true } });
  if (!currentUser || currentUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { pairs, skippedNoOrg, truncatedAliasBuckets } = await scanDuplicateCustomerPairs();

    let created = 0;
    let skipped = 0;
    const errors: Array<{ pair: string; error: string }> = [];

    // 收集本次扫描命中的所有 pair key，用于后续将不再命中的 PENDING 任务标记为 STALE
    const scannedPairKeys = new Set<string>();

    for (const pair of pairs) {
      // Ensure consistent ordering: A < B by profile id
      const [profileIdA, profileIdB] = pair.profileIdA < pair.profileIdB
        ? [pair.profileIdA, pair.profileIdB]
        : [pair.profileIdB, pair.profileIdA];
      const pairKey = `${profileIdA}:${profileIdB}`;
      scannedPairKeys.add(pairKey);

      try {
        // Check existing task status before upsert (avoid nested query inside upsert)
        const existingTask = await prisma.customerMergeTask.findUnique({
          where: { profileIdA_profileIdB: { profileIdA, profileIdB } },
          select: { status: true },
        });

        // 4-B.1: 终态/中间态任务在重扫时跳过，不刷新元数据：
        // - MERGED：保留合并时的匹配快照（matchTier/score/reasons/diff 不变）
        // - SUPERSEDED：已被其他合并覆盖，无需刷新
        // - PROCESSING：正在合并中，不刷新
        // - STALE：本次暂未命中但可能重新命中，允许恢复为 PENDING（见下方 update 分支）
        if (
          existingTask?.status === "MERGED" ||
          existingTask?.status === "SUPERSEDED" ||
          existingTask?.status === "PROCESSING"
        ) {
          skipped++;
          continue;
        }

        await prisma.customerMergeTask.upsert({
          where: { profileIdA_profileIdB: { profileIdA, profileIdB } },
          create: {
            profileIdA,
            profileIdB,
            matchTier: pair.matchTier,
            matchScore: pair.matchScore,
            matchReasonsJson: JSON.stringify(pair.matchReasons),
            fieldDiffJson: JSON.stringify(pair.fieldDiff),
            status: "PENDING",
            scannedById: currentUser.id,
            scannedAt: new Date(),
          },
          update: {
            // 仅刷新匹配元数据。
            // 到这里 existingTask 只可能是 PENDING、IGNORED 或 STALE。
            // IGNORED 保持 IGNORED（不复活），重新处理走前端「重新打开」按钮（见 4-B.3）。
            // STALE 重新命中时恢复为 PENDING。
            matchTier: pair.matchTier,
            matchScore: pair.matchScore,
            matchReasonsJson: JSON.stringify(pair.matchReasons),
            fieldDiffJson: JSON.stringify(pair.fieldDiff),
            scannedById: currentUser.id,
            scannedAt: new Date(),
            ...(existingTask?.status === "STALE" ? { status: "PENDING" } : {}),
          },
        });
        created++;
      } catch (err) {
        skipped++;
        errors.push({
          pair: pairKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // E3: 将本次重扫不再命中的旧 PENDING 任务标记为 STALE（而非 SUPERSEDED），
    // 允许后续重扫重新命中时恢复为 PENDING。因客户已合并产生的 SUPERSEDED 保持终态。
    let stale = 0;
    const stalePendingTasks = await prisma.customerMergeTask.findMany({
      where: { status: "PENDING" },
      select: { id: true, profileIdA: true, profileIdB: true },
    });
    const staleTaskIds: string[] = [];
    for (const task of stalePendingTasks) {
      const [a, b] = task.profileIdA < task.profileIdB
        ? [task.profileIdA, task.profileIdB]
        : [task.profileIdB, task.profileIdA];
      if (!scannedPairKeys.has(`${a}:${b}`)) {
        staleTaskIds.push(task.id);
      }
    }
    if (staleTaskIds.length > 0) {
      const result = await prisma.customerMergeTask.updateMany({
        where: { id: { in: staleTaskIds }, status: "PENDING" },
        data: { status: "STALE" },
      });
      stale = result.count;
    }

    return NextResponse.json({
      created,
      skipped,
      skippedNoOrg,
      truncatedAliasBuckets,
      stale,
      errors,
      totalPairs: pairs.length,
    });
  } catch (error) {
    console.error("[MERGE_SCAN]", error);
    return NextResponse.json({ error: "扫描失败" }, { status: 500 });
  }
}
