import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { NormalizedOrderRow } from "@/lib/external-order";
import { normalizeOrderSource } from "@/lib/orders/constants";
import {
  resolveRowCustomer,
  writeOrderForRow,
  RepresentativeMissingError,
  type RowSnapshot,
} from "@/lib/orders/import-single-row";
import {
  ROW_STATUS,
  SESSION_STATUS,
  SESSION_TERMINAL_STATUSES,
  summarizeRows,
  healLegacyConfirmedImportRows,
} from "@/lib/orders/import-session";
import { transitionCrmStage } from "@/lib/crm/lifecycle";

/**
 * POST /api/orders/import/sessions/[id]/commit
 *
 * 「先确认、后落库」的最终落库（§9）。Phase A 升级：不再使用单个整批 `$transaction`，
 * 改为**逐行独立事务**调用单行领域服务（§5.5）。每行 CONFIRMED_* → IMPORTING（claim）→
 * writeOrderForRow → IMPORTED，一行失败不会回滚已成功的行。
 *
 * 关键不变量（与旧 route 保持一致）：
 *  - §9.1 A：所有未剔除行必须是 CONFIRMED_EXISTING / CONFIRMED_CREATE，否则 409。
 *  - §9.1 B/C：坏行可经 droppedRowIds 显式剔除，每条需 dropReason；剔除行转 DROPPED。
 *  - §9.4：代表绝不信任前端，统一由 resolveRowCustomer 经 effective resolver 解析。
 *  - REPRESENTATIVE_MISSING：任一行解析为 NONE → 中止后续行，相关行标记
 *    REPRESENTATIVE_MISSING，返回 409（已成功的行不回滚——这是 Phase A 相对旧 route
 *    的行为变化，由逐行事务语义决定）。
 *
 * 正式订单写入统一走 writeOrderForRow（与 commitImportRow 共用），本路由不复制 create/update 逻辑。
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const droppedRowIds: string[] = Array.isArray(body?.droppedRowIds) ? body.droppedRowIds : [];
  const dropReasons: Record<string, string> = (body?.dropReasons && typeof body.dropReasons === "object") ? body.dropReasons : {};

  const sess = await prisma.orderImportSession.findUnique({
    where: { id },
    select: { id: true, status: true, source: true, sourceRemark: true, category: true, createdById: true },
  });
  if (!sess) return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  if (sess.createdById !== session.user.id) {
    return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  }
  if (SESSION_TERMINAL_STATUSES.includes(sess.status as never)) {
    return NextResponse.json({ error: `会话已是终态（${sess.status}），不能提交` }, { status: 409 });
  }

  // W6.2c：commit 前再治愈一次，避免未打开 GET 的历史会话直接 409。
  await healLegacyConfirmedImportRows(id, prisma);

  const allRows = await prisma.orderImportRow.findMany({
    where: { sessionId: id },
    orderBy: { rowNo: "asc" },
    select: {
      id: true, rowNo: true, reviewStatus: true, decisionType: true,
      confirmedProfileId: true, createCustomerDraftJson: true,
      normalizedPayloadJson: true, suggestedScore: true,
    },
  });

  // ── 校验剔除集合（§9.1 B） ──
  const dropSet = new Set(droppedRowIds);
  const rowById = new Map(allRows.map((r) => [r.id, r]));
  const dropPlan: Array<{ rowId: string; reason: string; originalStatus: string }> = [];
  for (const rowId of droppedRowIds) {
    const r = rowById.get(rowId);
    if (!r) return NextResponse.json({ error: `剔除行不存在：${rowId}` }, { status: 400 });
    if (r.reviewStatus === ROW_STATUS.IMPORTED) {
      return NextResponse.json({ error: `行 #${r.rowNo + 1} 已导入，不能剔除` }, { status: 409 });
    }
    const reason = (dropReasons[rowId] ?? "").trim();
    if (!reason) return NextResponse.json({ error: `行 #${r.rowNo + 1} 缺少剔除原因` }, { status: 400 });
    dropPlan.push({ rowId, reason, originalStatus: r.reviewStatus });
  }

  // ── 门槛 A（§9.1）：未剔除行必须全部已确认 ──
  const CONFIRMED = [ROW_STATUS.CONFIRMED_EXISTING, ROW_STATUS.CONFIRMED_CREATE] as string[];
  const confirmedRows = allRows.filter((r) => !dropSet.has(r.id) && CONFIRMED.includes(r.reviewStatus));
  const blockingRows = allRows.filter(
    (r) => !dropSet.has(r.id) && !CONFIRMED.includes(r.reviewStatus) && r.reviewStatus !== ROW_STATUS.IMPORTED,
  );
  if (blockingRows.length > 0) {
    return NextResponse.json({
      error: `还有 ${blockingRows.length} 行未确认或未剔除，无法导入`,
      blockingRowNos: blockingRows.slice(0, 50).map((r) => r.rowNo + 1),
    }, { status: 409 });
  }
  if (confirmedRows.length === 0 && dropPlan.length === 0) {
    return NextResponse.json({ error: "没有可导入的已确认行" }, { status: 400 });
  }

  const normalizedSource = normalizeOrderSource(sess.source);
  const userId = session.user.id;

  // 1. 剔除行 → DROPPED（独立小事务，记录原状态+原因）
  if (dropPlan.length > 0) {
    await prisma.$transaction(async (tx) => {
      for (const d of dropPlan) {
        await tx.orderImportRow.update({
          where: { id: d.rowId },
          data: {
            reviewStatus: ROW_STATUS.DROPPED,
            finalError: `已剔除：${d.reason}（原状态 ${d.originalStatus}）`,
          },
        });
      }
    });
  }

  // 2. 逐行独立事务：CONFIRMED_* → IMPORTING（claim）→ writeOrderForRow → IMPORTED
  //    一行失败不回滚已成功行。
  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  const touchedProfileIds = new Set<string>();
  let repMissingProfileIds: string[] | null = null;
  let repMissingRowIds: string[] = [];

  for (const row of confirmedRows) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        // claim CONFIRMED_* → IMPORTING（页面路径无 proposalId，简化 claim）
        const claimed = await tx.orderImportRow.updateMany({
          where: { id: row.id, sessionId: id, reviewStatus: { in: CONFIRMED } },
          data: {
            reviewStatus: ROW_STATUS.IMPORTING,
            claimStartedAt: new Date(),
          },
        });
        if (claimed.count === 0) {
          // 行已不在 CONFIRMED_*（并发或重复提交）——交给外层 catch 处理。
          throw new RowStateError(row.id, row.rowNo);
        }

        const snapshot: RowSnapshot = row; // CONFIRMED_EXISTING / CONFIRMED_CREATE，resolveRowCustomer 据此分流
        const customer = await resolveRowCustomer(tx, snapshot, normalizedSource);

        let parsed: NormalizedOrderRow;
        try {
          parsed = JSON.parse(row.normalizedPayloadJson) as NormalizedOrderRow;
        } catch {
          throw new RowDataError(row.id, row.rowNo, "标准化数据损坏");
        }

        const writeResult = await writeOrderForRow(tx, {
          row: snapshot,
          customer,
          parsed,
          normalizedSource,
          sourceRemark: sess.sourceRemark,
          category: sess.category,
          userId,
          actorRole: session.user.role,
          actorName: session.user.name,
          actorEmail: session.user.email,
        });

        if (!writeResult.skippedMergeTarget) {
          await tx.orderImportRow.update({
            where: { id: row.id },
            data: {
              reviewStatus: ROW_STATUS.IMPORTED,
              finalOrderId: writeResult.orderId,
              finalError: null,
              claimStartedAt: null,
              version: { increment: 1 },
            },
          });
        } else {
          await tx.orderImportRow.update({
            where: { id: row.id },
            data: { claimStartedAt: null, version: { increment: 1 } },
          });
        }

        return { writeResult, profileId: customer.profileId };
      }, { timeout: 60000, maxWait: 10000 });

      if (result.writeResult.skippedMergeTarget) {
        skippedCount++;
      } else if (result.writeResult.created) {
        createdCount++;
      } else {
        updatedCount++;
      }
      touchedProfileIds.add(result.profileId);

      // 事务外 best-effort：CRM 阶段推进
      await transitionCrmStage(result.profileId, {
        type: "ORDER_CONFIRMED",
        orderId: result.writeResult.orderId,
      }).catch((err) => {
        console.error(`[CRM][ORDER_IMPORT_CONFIRM] ORDER_CONFIRMED transition failed for ${result.profileId}:`, err);
      });
    } catch (e) {
      if (e instanceof RepresentativeMissingError) {
        // §9.4：中止后续行，标记当前行 REPRESENTATIVE_MISSING，返回 409。
        repMissingProfileIds = [e.profileId ?? ""].filter(Boolean);
        repMissingRowIds = [row.id];
        await prisma.orderImportRow.update({
          where: { id: row.id },
          data: {
            reviewStatus: ROW_STATUS.REPRESENTATIVE_MISSING,
            finalError: "客户无可用负责代表（本部 fallback 缺失），请先配置代表后重试",
          },
        }).catch(() => undefined);
        break;
      }
      if (e instanceof RowStateError) {
        // 并发/重复提交：跳过本行，继续后续（保守起见中止并报错）。
        console.error(`[order-import-commit] row #${e.rowNo + 1} state conflict`);
        return NextResponse.json({
          ok: false,
          error: `行 #${e.rowNo + 1} 状态已变更（可能并发提交），已中止。已成功行不会回滚。`,
          created: createdCount,
          updated: updatedCount,
          skipped: skippedCount,
          dropped: dropPlan.length,
        }, { status: 409 });
      }
      if (e instanceof RowDataError) {
        return NextResponse.json({
          ok: false,
          error: `行 #${e.rowNo + 1} ${e.message}，已中止。已成功行不会回滚。`,
          created: createdCount,
          updated: updatedCount,
          skipped: skippedCount,
          dropped: dropPlan.length,
        }, { status: 422 });
      }
      console.error("[order-import-commit] row failed:", e);
      return NextResponse.json({
        ok: false,
        error: "导入失败（已中止，已成功行不会回滚）",
        detail: e instanceof Error ? e.message : String(e),
        created: createdCount,
        updated: updatedCount,
        skipped: skippedCount,
        dropped: dropPlan.length,
      }, { status: 500 });
    }
  }

  // 3. 会话摘要 + 状态
  const grouped = await prisma.orderImportRow.groupBy({ by: ["reviewStatus"], where: { sessionId: id }, _count: { _all: true } });
  const summary = summarizeRows(grouped.flatMap((g) => Array.from({ length: g._count._all }, () => ({ reviewStatus: g.reviewStatus }))));
  // 全部已处理（无 rep-missing 中止）→ COMMITTED；否则保持 REVIEWING 让用户修复后重试。
  const finalStatus = repMissingProfileIds ? SESSION_STATUS.REVIEWING : SESSION_STATUS.COMMITTED;
  await prisma.orderImportSession.update({
    where: { id },
    data: { status: finalStatus, summaryJson: JSON.stringify(summary) },
  });

  if (repMissingProfileIds) {
    return NextResponse.json({
      error: "部分客户无可用负责代表，已中止",
      detail: "请先为相关客户配置机构代表或确保系统本部代表存在，再重新提交。已成功行不会回滚。",
      representativeMissingRows: repMissingRowIds.length,
      created: createdCount,
      updated: updatedCount,
      skipped: skippedCount,
      dropped: dropPlan.length,
    }, { status: 409 });
  }

  return NextResponse.json({
    ok: true,
    sessionStatus: SESSION_STATUS.COMMITTED,
    imported: createdCount + updatedCount,
    created: createdCount,
    updated: updatedCount,
    skipped: skippedCount,
    dropped: dropPlan.length,
  });
}

// ── 内部错误类型：用于在逐行事务里区分中止原因 ──────────────────────────────────
class RowStateError extends Error {
  constructor(public rowId: string, public rowNo: number) {
    super("row_state_conflict");
    this.name = "RowStateError";
  }
}
class RowDataError extends Error {
  constructor(public rowId: string, public rowNo: number, message: string) {
    super(message);
    this.name = "RowDataError";
  }
}
