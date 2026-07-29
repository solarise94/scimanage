import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseOrderText, decodeImportFile } from "@/lib/external-order";
import { normalizeOrderSource, ORDER_CATEGORY, OrderCategory, OrderCategoryValidationError, assertValidOrderCategory } from "@/lib/orders/constants";
import * as XLSX from "xlsx";
import {
  applyColumnMapping,
  createMatchContext,
  resolveRowAgainstContext,
  reviewStatusFromResolution,
  summarizeRows,
  ROW_STATUS,
  SESSION_STATUS,
} from "@/lib/orders/import-session";

function tryParseXlsx(buffer: Buffer): string | null {
  try {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return null;
    return XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]);
  } catch {
    return null;
  }
}

interface ExtractedInput {
  source: string;
  sourceRemark?: string;
  category?: string;
  rawText: string;
  columnMapping: Record<string, string> | null;
  fileName: string | null;
}

async function extractInput(req: NextRequest): Promise<ExtractedInput | { error: string; status: number }> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const source = (form.get("source") as string | null)?.trim() || "OTHER_IMPORT";
    const sourceRemark = (form.get("sourceRemark") as string | null)?.trim() || undefined;
    const category = (form.get("category") as string | null)?.trim() || undefined;
    const mappingStr = (form.get("columnMapping") as string | null)?.trim();
    let columnMapping: Record<string, string> | null = null;
    if (mappingStr) {
      try { columnMapping = JSON.parse(mappingStr) as Record<string, string>; } catch { /* ignore */ }
    }
    const file = form.get("file") as File | null;
    if (!file) return { error: "缺少 file", status: 400 };
    const buf = Buffer.from(await file.arrayBuffer());
    let rawText: string;
    if (file.name.endsWith(".xlsx") || file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
      const csv = tryParseXlsx(buf);
      if (!csv) return { error: "无法解析 .xlsx 文件", status: 422 };
      rawText = csv;
    } else {
      rawText = decodeImportFile(buf);
    }
    return { source, sourceRemark, category, rawText, columnMapping, fileName: file.name };
  }

  const body = await req.json().catch(() => null);
  if (!body) return { error: "无效请求体", status: 400 };
  const source = (body.source as string)?.trim() || "OTHER_IMPORT";
  const sourceRemark = (body.sourceRemark as string)?.trim() || undefined;
  const category = (body.category as string)?.trim() || undefined;
  const rawText = (body.rawText as string)?.trim() || "";
  let columnMapping: Record<string, string> | null = null;
  if (body.columnMapping && typeof body.columnMapping === "object") {
    columnMapping = body.columnMapping as Record<string, string>;
  }
  if (!rawText) return { error: "缺少 rawText", status: 400 };
  return { source, sourceRemark, category, rawText, columnMapping, fileName: null };
}

/**
 * POST /api/orders/import/sessions
 *
 * 创建导入确认会话（§7.1 的职责，落在专用端点上以兼容「先 AI 规范化、再进入确认页」流程）。
 * 解析文件/文本 → 应用列映射 → 冻结每行 normalizedPayload → Profile-first 匹配三态 →
 * 持久化 OrderImportSession + OrderImportRow[]。返回 { sessionId, status, summary }，前端跳转确认页。
 *
 * 纯 staging：本端点不创建任何 Customer / Order，只读匹配。
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const input = await extractInput(req);
  if ("error" in input) return NextResponse.json({ error: input.error }, { status: input.status });

  const { source, sourceRemark, category, columnMapping, fileName } = input;

  let normalizedCategory: OrderCategory;
  try {
    const candidate = category ?? ORDER_CATEGORY.SERVICE;
    assertValidOrderCategory(candidate);
    normalizedCategory = candidate;
  } catch (e) {
    if (e instanceof OrderCategoryValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }

  const rawText = applyColumnMapping(input.rawText, columnMapping);

  const { rows, errors: parseErrors, format } = parseOrderText(source, rawText);
  if (rows.length === 0 && parseErrors.length === 0) {
    return NextResponse.json({ error: "未解析到任何数据行" }, { status: 422 });
  }

  // 一次性加载匹配上下文（in-memory），逐行匹配，避免每行重复查库。
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
  for (const row of rows) {
    const resolution = resolveRowAgainstContext(ctx, row);
    const reviewStatus = reviewStatusFromResolution(resolution);
    rowCreates.push({
      rowNo,
      rawPayloadJson: JSON.stringify(row),
      normalizedPayloadJson: JSON.stringify(row),
      reviewStatus,
      // suggested* 仅作「默认选中谁」提示（§6.4.1）；commit 不信任它。
      suggestedProfileId: resolution.status === "AUTO_SUGGESTED" ? resolution.suggestedProfileId : null,
      suggestedScore: resolution.best?.score ?? null,
      suggestedReason: resolution.best?.reason ?? null,
    });
    rowNo++;
  }

  // 解析失败行：持久化为 PARSE_FAILED，rowNo 接在已解析行之后（满足 @@unique([sessionId, rowNo])）。
  for (const pe of parseErrors) {
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
        source: normalizeOrderSource(source),
        sourceRemark: sourceRemark ?? null,
        category: normalizedCategory,
        status: SESSION_STATUS.REVIEWING,
        fileName,
        rawColumnsJson: format ? JSON.stringify(format) : null,
        summaryJson: JSON.stringify(summary),
        createdById: session.user.id,
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

  return NextResponse.json(
    {
      sessionId: created.id,
      status: SESSION_STATUS.REVIEWING,
      summary: {
        rowCount: summary.rowCount,
        autoSuggested: summary.autoSuggested,
        ambiguous: summary.ambiguous,
        noMatch: summary.noMatch,
        parseFailed: summary.parseFailed,
      },
    },
    { status: 201 },
  );
}
