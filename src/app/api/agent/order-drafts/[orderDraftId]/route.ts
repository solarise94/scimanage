/**
 * Phase C: GenUI PATCH order draft route（修正 6/7，不是模型工具）。
 *
 * PATCH /api/agent/order-drafts/[orderDraftId]
 *   body: { expectedVersion, rows: [{ rowRef, serviceCatalogId, projectTypeOptionId,
 *           quantity, unitPriceYuan }] }
 *
 * - NextAuth session 鉴权（GenUI 是浏览器侧）。
 * - 校验 actor、orderDraftId（真实 id）、expectedVersion 乐观锁。
 * - 只接受产品/项目类型/数量/单价的行级 patch。
 * - 返回新 version + titleSnapshot。
 *
 * 不是模型工具：模型侧只有 propose_order(orderDraftId)，不能重新传入行字段。
 * owner 校验由 service patchOrderDraftForActor（ownerUserId === actor.userId）承担。
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import { patchOrderDraftForActor } from "@/lib/orders/application/order-drafts";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/application/errors";

function mapDomainErrorToHttp(err: unknown): NextResponse {
  if (err instanceof ValidationError) {
    // version 不匹配也走 ValidationError → 409（乐观锁冲突）
    if (err.message.includes("版本不匹配")) {
      return NextResponse.json({ error: err.message, code: "VERSION_CONFLICT" }, { status: 409 });
    }
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err instanceof NotFoundError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  console.error("order-draft PATCH failed:", err);
  return NextResponse.json({ error: "Failed to update order draft" }, { status: 500 });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ orderDraftId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const actor = requireBusinessActorFromSession(session);

  const { orderDraftId } = await params;
  if (!orderDraftId) {
    return NextResponse.json({ error: "orderDraftId is required" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Request body must be an object" }, { status: 400 });
  }

  const expectedVersion = typeof body.expectedVersion === "number" ? body.expectedVersion : null;
  if (expectedVersion == null) {
    return NextResponse.json({ error: "expectedVersion is required" }, { status: 400 });
  }
  if (!Array.isArray(body.rows)) {
    return NextResponse.json({ error: "rows must be an array" }, { status: 400 });
  }

  // 字段白名单校验：只允许产品/项目类型/数量/单价。
  for (const row of body.rows) {
    if (!row || typeof row !== "object") {
      return NextResponse.json({ error: "each row must be an object" }, { status: 400 });
    }
    const allowed = new Set(["rowRef", "serviceCatalogId", "projectTypeOptionId", "quantity", "unitPriceYuan"]);
    for (const key of Object.keys(row)) {
      if (!allowed.has(key)) {
        return NextResponse.json({ error: `row field not allowed: ${key}` }, { status: 400 });
      }
    }
  }

  try {
    const result = await patchOrderDraftForActor(actor, {
      orderDraftId,
      expectedVersion,
      rows: body.rows,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return mapDomainErrorToHttp(err);
  }
}
