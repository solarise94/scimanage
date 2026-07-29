/**
 * GET  /api/products/governance/unmapped-lines  未映射订单行治理队列
 * POST /api/products/governance/unmapped-lines  批量绑定订单行到 SKU
 *   body: { bindings: [{ orderLineId, productSkuId, source? }] }
 */
import { NextRequest, NextResponse } from "next/server";
import { requireActorFromSession, mapDomainErrorToHttp } from "@/lib/application/http-error-mapping";
import {
  listUnmappedOrderLinesForActor,
  bindOrderLinesForActor,
} from "@/lib/products/application/governance-query";

export async function GET(req: NextRequest) {
  const auth = await requireActorFromSession();
  if (!auth.ok) return auth.response;

  const limitParam = req.nextUrl.searchParams.get("limit");
  const orderId = req.nextUrl.searchParams.get("orderId") || undefined;
  const limit = limitParam ? parseInt(limitParam, 10) : undefined;
  try {
    const items = await listUnmappedOrderLinesForActor(auth.actor, { limit, orderId });
    return NextResponse.json({ items });
  } catch (err) {
    return mapDomainErrorToHttp(err, "Failed to list unmapped order lines");
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireActorFromSession();
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const bindingsRaw = Array.isArray(body.bindings) ? body.bindings : [];
  const bindings = bindingsRaw
    .filter((b): b is { orderLineId: string; productSkuId: string; source?: string } =>
      typeof b === "object" && b !== null && typeof (b as { orderLineId?: unknown }).orderLineId === "string" && typeof (b as { productSkuId?: unknown }).productSkuId === "string")
    .map((b) => ({
      orderLineId: b.orderLineId,
      productSkuId: b.productSkuId,
      source: typeof b.source === "string" ? b.source : undefined,
    }));

  if (bindings.length === 0) {
    return NextResponse.json({ error: "bindings 必填且每项需 orderLineId + productSkuId" }, { status: 400 });
  }
  try {
    const result = await bindOrderLinesForActor(auth.actor, bindings);
    return NextResponse.json(result);
  } catch (err) {
    return mapDomainErrorToHttp(err, "Failed to bind order lines");
  }
}
