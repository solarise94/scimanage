import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { isGlmOcrConfigured, ocrVoucherImage } from "@/lib/finance/glm-ocr";

// GLM-OCR 官方仅声明 PDF / JPG / PNG（不含 WebP）
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "application/pdf",
]);

function normalizeMime(file: File): string {
  const t = (file.type || "").toLowerCase().trim();
  if (t && ALLOWED_MIME.has(t)) return t === "image/jpg" ? "image/jpeg" : t;
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  return t || "application/octet-stream";
}

/**
 * POST /api/finance/payment-vouchers/ocr
 * multipart/form-data:
 *   - file: 单文件（兼容）
 *   - files: 多文件（批量，最多 10）
 *
 * 仅 ADMIN/USER。返回 OCR 预填字段，不写库、不自动核销。
 */
export async function POST(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (session.user.role !== "ADMIN" && session.user.role !== "USER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!isGlmOcrConfigured()) {
    return NextResponse.json(
      { error: "GLM-OCR 未配置（缺少 ZHIPU_API_KEY）" },
      { status: 503 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "无效的 multipart 请求" }, { status: 400 });
  }

  const files: File[] = [];
  const multi = form.getAll("files");
  // 只要请求带了 files 字段（批量导入），即使只有 1 张也走 results[] 契约，
  // 失败时仍 200 + ok:false，便于前端进入可编辑预览补录。
  // 向导单张走 file 字段：成功扁平返回，失败 502。
  const batchMode = multi.length > 0;
  for (const item of multi) {
    if (item instanceof File && item.size > 0) files.push(item);
  }
  const single = form.get("file");
  if (files.length === 0 && single instanceof File && single.size > 0) {
    files.push(single);
  }

  if (files.length === 0) {
    return NextResponse.json({ error: "请上传回单图片或 PDF" }, { status: 400 });
  }
  if (files.length > 10) {
    return NextResponse.json({ error: "单次最多 10 个文件" }, { status: 400 });
  }

  const results: Array<{
    fileName: string;
    ok: boolean;
    fields?: {
      payerName: string | null;
      amountYuan: number | null;
      receivedAt: string | null;
      remark: string | null;
    };
    rawText?: string;
    warnings?: string[];
    error?: string;
  }> = [];

  // 串行调用，避免打爆配额
  for (const file of files) {
    const mime = normalizeMime(file);
    if (!ALLOWED_MIME.has(mime) && mime !== "image/jpeg") {
      results.push({
        fileName: file.name || "unknown",
        ok: false,
        error: `不支持的文件类型: ${mime || file.type || "unknown"}`,
      });
      continue;
    }
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      const parsed = await ocrVoucherImage(buf, mime);
      results.push({
        fileName: file.name || "unknown",
        ok: true,
        fields: parsed.fields,
        rawText: parsed.rawText,
        warnings: parsed.warnings,
      });
    } catch (err) {
      results.push({
        fileName: file.name || "unknown",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const configured = true;
  // 批量（files 字段）：始终 results[]，含单张失败
  if (batchMode) {
    return NextResponse.json({ configured, results });
  }

  // 向导单张（file 字段）：成功扁平；失败 502
  const r = results[0];
  if (!r?.ok) {
    return NextResponse.json({ error: r?.error || "OCR 失败", configured }, { status: 502 });
  }
  return NextResponse.json({
    configured,
    fields: r.fields,
    rawText: r.rawText,
    warnings: r.warnings || [],
    fileName: r.fileName,
  });
}

export async function GET() {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (session.user.role !== "ADMIN" && session.user.role !== "USER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json({ configured: isGlmOcrConfigured() });
}
