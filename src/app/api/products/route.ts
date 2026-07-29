/**
 * 产品与服务目录 API。
 *
 * GET  /api/products            列表（支持 search/kind/domain/status/sellableOnly 筛选）
 * POST /api/products            创建产品（领 PRD- 编号 + 可选别名）
 *
 * 内部员工（ADMIN/USER）可读写。service 层做角色校验与编号生成。
 */
import { NextRequest, NextResponse } from "next/server";
import { requireActorFromSession, mapDomainErrorToHttp } from "@/lib/application/http-error-mapping";
import { buildInvocationContext } from "@/lib/application/actor";
import {
  listProductsForActor,
  getSellableSkuOptionsForActor,
  getPurchasableSkuOptionsForActor,
} from "@/lib/products/application/query-products";
import { createProductForActor } from "@/lib/products/application/create-product";

export async function GET(req: NextRequest) {
  const auth = await requireActorFromSession();
  if (!auth.ok) return auth.response;

  const url = req.nextUrl;
  const search = url.searchParams.get("search")?.trim() || null;
  const kind = url.searchParams.get("kind")?.trim() || null;
  const domain = url.searchParams.get("domain")?.trim() || null;
  const status = url.searchParams.get("status")?.trim() || null;
  const sellableOnly = url.searchParams.get("sellableOnly") === "true";

  // 专用端点模式：?options=sellable 返回 GenUI/Agent 可销售 SKU 候选
  if (url.searchParams.get("options") === "sellable") {
    try {
      const options = await getSellableSkuOptionsForActor(auth.actor);
      return NextResponse.json({ options });
    } catch (err) {
      return mapDomainErrorToHttp(err, "Failed to list sellable SKUs");
    }
  }
  // review #4：?options=purchasable 返回可采购 SKU（报价表单用）
  if (url.searchParams.get("options") === "purchasable") {
    try {
      const options = await getPurchasableSkuOptionsForActor(auth.actor);
      return NextResponse.json({ options });
    } catch (err) {
      return mapDomainErrorToHttp(err, "Failed to list purchasable SKUs");
    }
  }

  try {
    const items = await listProductsForActor(auth.actor, { search, kind, domain, status, sellableOnly });
    return NextResponse.json({ items });
  } catch (err) {
    return mapDomainErrorToHttp(err, "Failed to list products");
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

  const invocation = buildInvocationContext({ channel: "web" });
  try {
    const result = await createProductForActor(auth.actor, {
      name: String(body.name ?? ""),
      kind: typeof body.kind === "string" ? body.kind : undefined,
      domain: typeof body.domain === "string" ? body.domain : null,
      description: typeof body.description === "string" ? body.description : null,
      status: typeof body.status === "string" ? body.status : undefined,
      aliases: Array.isArray(body.aliases) ? body.aliases.map(String) : undefined,
    });
    void invocation;
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return mapDomainErrorToHttp(err, "Failed to create product");
  }
}
