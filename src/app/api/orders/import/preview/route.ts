import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseOrderText, decodeImportFile } from "@/lib/external-order";
import { resolveOrCreateOrganizationForImport, matchExistingCustomerForImport } from "@/lib/orders/import-masterdata";
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

  const { rows, errors, format } = parseOrderText(source, rawText);

  const rawColumns = format.recognizedHeaders.length > 0
    ? format.recognizedHeaders
    : (rows.length > 0 ? Object.keys(JSON.parse(rows[0].rawJson || "{}")) : []);

  const directImportable = format.headerHits >= 5;
  const suggestedMode = directImportable ? ("DIRECT" as const) : ("AI_NORMALIZE" as const);

  const previewRows = rows.slice(0, 10).map((r) => {
    const raw = JSON.parse(r.rawJson || "{}") as Record<string, string>;
    return { externalOrderNo: r.externalOrderNo, receiverName: r.receiverName, totalAmount: r.paidAmount ?? r.grossAmount, ...raw };
  });

  // ── U3：未匹配客户预检（只读） ────────────────────────────────────────────
  // 对每行跑 MATCH_ONLY 客户匹配，统计无法匹配到现有客户的行。前端据此提示"先建档
  // 再导入"。口径与 commit-batch（import-batch.ts）一致：先 RESOLVE_ONLY 解析机构启用
  // 机构召回，再 matchExistingCustomerForImport 打分（≥60 视为命中）。
  // matchExistingCustomerForImport 是纯只读（不创建客户、不 ensure profile），预检无写副作用。
  // 大文件按 CAP 截断预检，避免预览阶段过多查询；截断信息回传前端提示。
  const MATCH_PREFLIGHT_CAP = 300;
  const preflightRows = rows.slice(0, MATCH_PREFLIGHT_CAP);
  const unmatchedRows: Array<{ row: number; buyerName: string | null; buyerOrg: string | null; score: number | null }> = [];
  let matchedCount = 0;
  for (let i = 0; i < preflightRows.length; i++) {
    const r = preflightRows[i];
    const buyerName = r.receiverName?.trim() || null;
    const buyerOrg = r.storeName?.trim() || null;
    if (!buyerName) {
      // 无买方姓名 → 必然无法匹配
      unmatchedRows.push({ row: i + 1, buyerName: null, buyerOrg, score: null });
      continue;
    }
    try {
      const orgResult = await resolveOrCreateOrganizationForImport(r.storeName, "RESOLVE_ONLY", prisma);
      const matched = await matchExistingCustomerForImport(
        {
          buyerName,
          buyerPhone: r.receiverPhone,
          buyerWechat: r.orderUser,
          buyerCustomerCode: r.customerCode,
          buyerOrgName: r.storeName,
          buyerAddress: r.receiverAddress,
        },
        orgResult.organizationId,
        prisma,
      );
      if (matched.profileId) matchedCount++;
      else unmatchedRows.push({ row: i + 1, buyerName, buyerOrg, score: matched.score });
    } catch (err) {
      // 预检失败不阻断预览，按未匹配保守上报
      console.warn("[import-preview] match preflight failed for row", i + 1, err instanceof Error ? err.message : err);
      unmatchedRows.push({ row: i + 1, buyerName, buyerOrg, score: null });
    }
  }

  return NextResponse.json({
    format,
    rawColumns,
    rowCount: rows.length,
    errorCount: errors.length,
    directImportable,
    suggestedMode,
    previewRows,
    rows,
    errors: errors.slice(0, 20),
    sourceRemark,
    // U3 未匹配预检结果
    matchPreflightCount: preflightRows.length,
    matchPreflightTruncated: rows.length > MATCH_PREFLIGHT_CAP,
    matchedCount,
    unmatchedCount: unmatchedRows.length,
    unmatchedRows: unmatchedRows.slice(0, 100),
  });
}
