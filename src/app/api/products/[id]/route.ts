/**
 * GET  /api/products/[id]   产品详情（含 SKU/别名/变更日志）
 * PATCH /api/products/[id]  更新产品（名称/类型/业务域/描述/状态）
 */
import { NextRequest, NextResponse } from "next/server";
import { requireActorFromSession, mapDomainErrorToHttp } from "@/lib/application/http-error-mapping";
import { getProductForActor } from "@/lib/products/application/query-products";
import { updateProductForActor } from "@/lib/products/application/create-product";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireActorFromSession();
  if (!auth.ok) return auth.response;
  const { id } = await params;
  try {
    const product = await getProductForActor(auth.actor, id);
    return NextResponse.json({ product });
  } catch (err) {
    return mapDomainErrorToHttp(err, "Failed to get product");
  }
}

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
    const result = await updateProductForActor(auth.actor, id, {
      name: typeof body.name === "string" ? body.name : undefined,
      kind: typeof body.kind === "string" ? body.kind : undefined,
      domain: body.domain === null ? null : typeof body.domain === "string" ? body.domain : undefined,
      description: body.description === null ? null : typeof body.description === "string" ? body.description : undefined,
      status: typeof body.status === "string" ? body.status : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    return mapDomainErrorToHttp(err, "Failed to update product");
  }
}
