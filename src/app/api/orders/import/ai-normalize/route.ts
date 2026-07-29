import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { parseOrderText, decodeImportFile } from "@/lib/external-order";
import { parse as csvParse } from "csv-parse/sync";
import { chunkColumns, ORDER_IMPORT_MAX_COLUMNS, buildAiNormalizePrompt } from "@/lib/orders/import-ai";
import * as XLSX from "xlsx";

type XlsxParseResult = { ok: true; csv: string } | { ok: false; reason: "notXlsx" | "parseError" };

function tryParseXlsx(buffer: Buffer): XlsxParseResult {
  try {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return { ok: false, reason: "notXlsx" };
    return { ok: true, csv: XLSX.utils.sheet_to_csv(sheet) };
  } catch (err) {
    console.warn("[XLSX] parse failed, treating as corrupt Excel:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "parseError" };
  }
}

function extractRawColumns(rawText: string): string[] {
  const firstLine = rawText.split(/\r?\n/)[0] || "";
  try {
    const records: string[][] = csvParse(firstLine + "\n", { relax_column_count: true, skip_empty_lines: true });
    if (records.length > 0) return records[0].map((c: string) => c.trim()).filter(Boolean);
  } catch { /* not CSV */ }
  const tsv = firstLine.split("\t").map((c) => c.trim()).filter(Boolean);
  if (tsv.length > 1) return tsv;
  return firstLine.split(",").map((c) => c.trim()).filter(Boolean);
}

function extractSampleRows(rawText: string, columns: string[], count: number): string[][] {
  const lines = rawText.split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(1, 1 + count).map((line) => {
    let cells: string[];
    try {
      const records: string[][] = csvParse(line, { relax_column_count: true, skip_empty_lines: true });
      cells = records[0] || [];
    } catch {
      cells = line.includes("\t") ? line.split("\t") : line.split(",");
    }
    return columns.map((_, i) => (cells[i] || "").trim());
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const ct = req.headers.get("content-type") || "";
  let source: string;
  let rawText: string;

  let sourceRemark: string | undefined;

  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    source = (form.get("source") as string | null)?.trim() || "OTHER_IMPORT";
    sourceRemark = (form.get("sourceRemark") as string | null)?.trim() || undefined;
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "缺少 file" }, { status: 400 });
    const buf = Buffer.from(await file.arrayBuffer());
    if (file.name.endsWith(".xlsx")) {
      const parsed = tryParseXlsx(buf);
      if (!parsed.ok) {
        const msg = parsed.reason === "parseError" ? "Excel 文件可能已损坏，无法解析" : "无法解析 .xlsx 文件";
        return NextResponse.json({ error: msg }, { status: 422 });
      }
      rawText = parsed.csv;
    } else {
      rawText = decodeImportFile(buf);
    }
  } else {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.rawText !== "string") return NextResponse.json({ error: "缺少 rawText" }, { status: 400 });
    source = (body.source as string)?.trim() || "OTHER_IMPORT";
    sourceRemark = (body.sourceRemark as string)?.trim() || undefined;
    rawText = body.rawText.trim();
  }

  if (!source || !rawText) return NextResponse.json({ error: "source 和 rawText 不能为空" }, { status: 400 });

  const { format } = parseOrderText(source, rawText);

  // When the parser can't recognize headers, extract columns directly from raw text
  const rawColumns = format.headerHits > 0
    ? format.recognizedHeaders
    : extractRawColumns(rawText);

  if (rawColumns.length === 0) {
    return NextResponse.json({ error: "无法识别文件中的列", rawColumns: [], rowCount: 0 }, { status: 422 });
  }

  const sampleRows = extractSampleRows(rawText, rawColumns, 5);
  const rowCount = rawText.split(/\r?\n/).filter((l) => l.trim()).length - 1; // minus header

  if (rawColumns.length > ORDER_IMPORT_MAX_COLUMNS) {
    const chunks = chunkColumns(rawColumns);
    return NextResponse.json({
      needsChunking: true,
      chunkCount: chunks.length,
      chunks: chunks.map((cols, i) => ({
        index: i,
        columns: cols,
        prompt: buildAiNormalizePrompt(cols, cols.map((c) => {
          const ci = rawColumns.indexOf(c);
          return sampleRows.map((r) => r[ci] || "").slice(0, 3);
        })),
      })),
      rawColumns,
      rowCount,
      suggestedMode: "AI_NORMALIZE",
      sourceRemark,
    });
  }

  return NextResponse.json({
    needsChunking: false,
    prompt: buildAiNormalizePrompt(rawColumns, sampleRows),
    rawColumns,
    rowCount,
    suggestedMode: "AI_NORMALIZE",
    sourceRemark,
  });
}
