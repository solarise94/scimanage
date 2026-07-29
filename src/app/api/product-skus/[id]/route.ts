/**
 * PATCH /api/product-skus/[id]  更新 SKU（名称/规格/单位/可售/可采/履约模式/默认售价/状态）
 */
import { NextRequest, NextResponse } from "next/server";
import { requireActorFromSession, mapDomainErrorToHttp } from "@/lib/application/http-error-mapping";
import { updateSkuForActor } from "@/lib/products/application/create-product";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireActorFromSession();
  if (!auth.ok) return auth.response;
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await updateSkuForActor(auth.actor, id, {
      name: typeof body.name === "string" ? body.name : undefined,
      spec: body.spec === null ? null : typeof body.spec === "string" ? body.spec : undefined,
      standardUnit: typeof body.standardUnit === "string" ? body.standardUnit : undefined,
      sellable: typeof body.sellable === "boolean" ? body.sellable : undefined,
      purchasable: typeof body.purchasable === "boolean" ? body.purchasable : undefined,
      fulfillmentMode: typeof body.fulfillmentMode === "string" ? body.fulfillmentMode : undefined,
      defaultSalesPriceYuan:
        typeof body.defaultSalesPriceYuan === "number"
          ? body.defaultSalesPriceYuan
          : body.defaultSalesPriceYuan === null
            ? null
            : undefined,
      status: typeof body.status === "string" ? body.status : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    return mapDomainErrorToHttp(err, "Failed to update SKU");
  }
}
