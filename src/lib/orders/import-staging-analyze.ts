/**
 * 订单导入 staging 文件分析共享逻辑（§6.1 / §6.2）。
 *
 * orders.analyze_import_file 与 orders.apply_import_column_mapping 都需要：
 *   buffer → 文本 → (可选列映射) → parseOrderText → 匹配 → 事务创建 session + rows。
 * 抽到这里避免两处 action 复制 Prisma 写入与匹配口径。
 *
 * 不写正式 Order；只创建 OrderImportSession + OrderImportRow[]（纯 staging）。
 */
import * as XLSX from "xlsx";
import { prisma } from "@/lib/prisma";
import { decodeImportFile, parseOrderText } from "@/lib/external-order";
import {
  applyColumnMapping,
  createMatchContext,
  resolveRowAgainstContext,
  reviewStatusFromResolution,
  summarizeRows,
  ROW_STATUS,
  SESSION_STATUS,
} from "@/lib/orders/import-session";
import { normalizeOrderSource, ORDER_CATEGORY, assertValidOrderCategory } from "@/lib/orders/constants";
import { IMPORT_STAGING_MAX_ROWS } from "@/lib/import-staging";

/** 把 staging buffer 转为可解析文本（XLSX → CSV；其他走 decodeImportFile）。 */
export function decodeStagingBufferToText(
  buffer: Buffer,
  mimeType: string,
  originalName: string,
): { text: string } | { error: string } {
  const isXlsx =
    originalName.toLowerCase().endsWith(".xlsx")
    || mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    || mimeType === "application/zip";
  if (isXlsx) {
    try {
      const wb = XLSX.read(buffer, { type: "buffer" });
      const sheetName = wb.SheetNames[0];
      if (!sheetName) return { error: "Excel 文件无工作表" };
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]);
      return { text: csv };
    } catch (err) {
      console.warn("[import-staging-analyze] xlsx parse failed:", err instanceof Error ? err.message : err);
      return { error: "Excel 文件可能已损坏，无法解析" };
    }
  }
  return { text: decodeImportFile(buffer) };
}

export interface ParsedImportPayload {
  rows: ReturnType<typeof parseOrderText>["rows"];
  parseErrors: ReturnType<typeof parseOrderText>["errors"];
  format: ReturnType<typeof parseOrderText>["format"];
}

/** 解析文本（可叠加列映射）为标准化行 + 解析错误。 */
export function parseImportText(
  source: string,
  rawText: string,
  columnMapping?: Record<string, string> | null,
): ParsedImportPayload {
  const mappedText = applyColumnMapping(rawText, columnMapping ?? null);
  const { rows, errors, format } = parseOrderText(source, mappedText);
  return { rows, parseErrors: errors, format };
}

export interface CreateSessionResult {
  sessionId: string;
  rowCount: number;
  summary: ReturnType<typeof summarizeRows>;
  nextRowId: string | null;
}

/**
 * 在单事务内创建 OrderImportSession + OrderImportRow[]（AGENT 渠道）。
 * 口径与 src/app/api/orders/import/sessions/route.ts 完全一致（§7.1）。
 * source 固定由 parser 选择：PINGOODMICE 或 OTHER_IMPORT。
 */
export async function createImportSessionFromRows(opts: {
  createdById: string;
  agentRunId?: string | null;
  /** staging 文件 ID；来自旧直写入口（如 pingoodmice 过渡）时可为 null。 */
  stagingFileId?: string | null;
  parserKey: "PINGOODMICE" | "ORDER_GENERIC";
  sourceRemark?: string | null;
  fileName: string | null;
  category?: string | null;
  payload: ParsedImportPayload;
  /** 默认 AGENT；pingoodmice 过渡等页面入口传 PAGE。 */
  inputChannel?: "AGENT" | "PAGE";
}): Promise<CreateSessionResult> {
  // 行数硬上限收口在共享函数内：agent action 与页面入口（pingoodmice 过渡）
  // 都经过这里，不能只靠调用方自觉，否则页面粘贴可创建无上限的 OrderImportRow。
  const totalRows = opts.payload.rows.length + opts.payload.parseErrors.length;
  if (totalRows > IMPORT_STAGING_MAX_ROWS) {
    throw new Error(
      `导入行数 ${totalRows} 超过上限 ${IMPORT_STAGING_MAX_ROWS}，请拆分后重试`,
    );
  }

  const source = opts.parserKey === "PINGOODMICE" ? "PINGOODMICE" : "OTHER_IMPORT";
  const normalizedSource = normalizeOrderSource(source);

  let category: "SERVICE" | "PRODUCT";
  try {
    assertValidOrderCategory(opts.category ?? ORDER_CATEGORY.SERVICE);
    category = (opts.category as "SERVICE" | "PRODUCT") ?? ORDER_CATEGORY.SERVICE;
  } catch {
    category = ORDER_CATEGORY.SERVICE;
  }

  const ctx = await createMatchContext();

  type RowCreate = {
    rowNo: number;
    rawPayloadJson: string;
    normalizedPayloadJson: string;
    reviewStatus: string;
    suggestedProfileId: string | null;
    suggestedScore: number | null;
    suggestedReason: string | null;
  };
  const rowCreates: RowCreate[] = [];

  let rowNo = 0;
  for (const row of opts.payload.rows) {
    const resolution = resolveRowAgainstContext(ctx, row);
    const reviewStatus = reviewStatusFromResolution(resolution);
    rowCreates.push({
      rowNo,
      rawPayloadJson: JSON.stringify(row),
      normalizedPayloadJson: JSON.stringify(row),
      reviewStatus,
      suggestedProfileId: resolution.status === "AUTO_SUGGESTED" ? resolution.suggestedProfileId : null,
      suggestedScore: resolution.best?.score ?? null,
      suggestedReason: resolution.best?.reason ?? null,
    });
    rowNo++;
  }

  for (const pe of opts.payload.parseErrors) {
    rowCreates.push({
      rowNo,
      rawPayloadJson: JSON.stringify({ parseError: pe }),
      normalizedPayloadJson: "{}",
      reviewStatus: ROW_STATUS.PARSE_FAILED,
      suggestedProfileId: null,
      suggestedScore: null,
      suggestedReason: pe.message ?? "解析失败",
    });
    rowNo++;
  }

  const summary = summarizeRows(rowCreates);

  const created = await prisma.$transaction(async (tx) => {
    const sess = await tx.orderImportSession.create({
      data: {
        source: normalizedSource,
        sourceRemark: opts.sourceRemark ?? null,
        category,
        status: SESSION_STATUS.REVIEWING,
        fileName: opts.fileName,
        rawColumnsJson: JSON.stringify(opts.payload.format),
        summaryJson: JSON.stringify(summary),
        createdById: opts.createdById,
        inputChannel: opts.inputChannel ?? "AGENT",
        stagingFileId: opts.stagingFileId ?? null,
        agentRunId: opts.agentRunId ?? null,
        parserKey: opts.parserKey,
        rowCount: rowCreates.length,
      },
      select: { id: true },
    });
    if (rowCreates.length > 0) {
      await tx.orderImportRow.createMany({
        data: rowCreates.map((r) => ({ ...r, sessionId: sess.id })),
      });
    }
    return sess;
  }, { timeout: 30000 });

  // 取第一条未终态行作为 nextRowId（顺序导入编排起点）。
  const nextRow = await prisma.orderImportRow.findFirst({
    where: {
      sessionId: created.id,
      reviewStatus: { in: ["PENDING", "AUTO_SUGGESTED", "AMBIGUOUS", "NO_MATCH", "REPRESENTATIVE_MISSING", "PARSE_FAILED"] },
    },
    orderBy: { rowNo: "asc" },
    select: { id: true },
  });

  return {
    sessionId: created.id,
    rowCount: rowCreates.length,
    summary,
    nextRowId: nextRow?.id ?? null,
  };
}
