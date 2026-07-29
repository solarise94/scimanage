import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { parseOrderText, decodeImportFile } from "@/lib/external-order";
import { ORDER_CATEGORY, OrderCategoryValidationError, assertValidOrderCategory } from "@/lib/orders/constants";
import { IMPORT_PARSER_KEY } from "@/lib/import-staging";
import { createImportSessionFromRows } from "@/lib/orders/import-staging-analyze";

/**
 * §10.2 Phase A：拼好鼠过渡入口。
 *
 * 该路由不再直接写订单（旧 created/updated/skipped 201 响应已移除）。
 * 相同输入被转换为 OrderImportSession + OrderImportRow[]（source=PINGOODMICE，
 * inputChannel=PAGE），后续逐行确认走单行领域服务。
 *
 * 返回 202 + deprecation / Location / Retry-After 头。
 * Phase B（最终 410）不在此实现。
 */
async function extractInput(req: NextRequest): Promise<{ source: string; rawText: string; sourceRemark?: string; category?: string } | { error: string }> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const source = (form.get("source") as string | null)?.trim();
    const sourceRemark = (form.get("sourceRemark") as string | null)?.trim() || undefined;
    const category = (form.get("category") as string | null)?.trim() || undefined;
    const file = form.get("file") as File | null;
    if (!source || !file) return { error: "缺少 source 或 file" };
    const buf = Buffer.from(await file.arrayBuffer());
    return { source, rawText: decodeImportFile(buf), sourceRemark, category };
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body.source !== "string" || typeof body.rawText !== "string") {
    return { error: "缺少 source 或 rawText" };
  }
  const source = body.source.trim();
  const sourceRemark = (body.sourceRemark as string)?.trim() || undefined;
  const category = (body.category as string)?.trim() || undefined;
  const rawText = body.rawText.trim();
  if (!source || !rawText) return { error: "source 和 rawText 不能为空" };
  return { source, rawText, sourceRemark, category };
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const input = await extractInput(req);
  if ("error" in input) return NextResponse.json({ error: input.error }, { status: 400 });

  const { source, rawText, sourceRemark, category } = input;
  let orderCategory: "SERVICE" | "PRODUCT";
  try {
    const candidate = category ?? ORDER_CATEGORY.SERVICE;
    assertValidOrderCategory(candidate);
    orderCategory = candidate;
  } catch (e) {
    if (e instanceof OrderCategoryValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }

  // 复用现有确定性 parser（拼好鼠格式），不调用 LLM。
  const { rows, errors: parseErrors, format } = parseOrderText(source, rawText);
  if (rows.length === 0 && parseErrors.length > 0) {
    return NextResponse.json({ error: parseErrors[0].message, errors: parseErrors, format }, { status: 422 });
  }

  // 转换为确认会话（source=PINGOODMICE，inputChannel=PAGE），不写正式订单。
  const result = await createImportSessionFromRows({
    createdById: session.user.id,
    stagingFileId: null,
    parserKey: IMPORT_PARSER_KEY.PINGOODMICE,
    sourceRemark: sourceRemark ?? null,
    fileName: null,
    category: orderCategory,
    payload: { rows, parseErrors, format },
    inputChannel: "PAGE",
  });

  const reviewUrl = `/orders/import/${result.sessionId}`;
  const statusUrl = `/api/orders/import/sessions/${result.sessionId}`;
  const body = {
    accepted: true,
    sessionId: result.sessionId,
    status: "REVIEWING",
    ordersCreated: 0,
    reviewUrl,
    statusUrl,
    deprecated: true,
    detail: "输入已转为确认会话，尚未创建或更新订单",
  };

  return NextResponse.json(body, {
    status: 202,
    headers: {
      "Deprecation": "true",
      "Location": statusUrl,
      "Retry-After": "2",
    },
  });
}
