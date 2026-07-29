import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { businessActorFromSessionUser } from "@/lib/application/actor";
import { ApplicationError } from "@/lib/application/errors";
import {
  classifyContractOrderGateForActor,
  queryContractsForActor,
} from "@/lib/contracts/application/query-contracts";

// T8.1b 起走 canonical application service（全覆盖 scope + 过滤后真实 total）。
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const actor = businessActorFromSessionUser(session.user);
    const url = req.nextUrl;
    const orderId = url.searchParams.get("orderId");

    // 历史 envelope：orderId 越界/不存在时返回不含 page/pageSize 的空壳。
    if (orderId) {
      const gate = await classifyContractOrderGateForActor(actor, orderId);
      if (gate === "empty") {
        return NextResponse.json({ contracts: [], total: 0 });
      }
    }

    const { contracts, total, page, pageSize } = await queryContractsForActor(actor, {
      orderId,
      page: parseInt(url.searchParams.get("page") || "1"),
      pageSize: parseInt(url.searchParams.get("pageSize") || "20"),
    });

    // Web 响应保持历史形态（原响应无 template 键）；category 仅 Agent shape 使用。
    return NextResponse.json({
      contracts: contracts.map((record) => {
        const row: Record<string, unknown> = { ...record };
        delete row.template;
        return row;
      }),
      total,
      page,
      pageSize,
    });
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }
}
