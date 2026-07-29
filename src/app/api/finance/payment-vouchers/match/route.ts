import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { businessActorFromSessionUser } from "@/lib/application/actor";
import { ApplicationError } from "@/lib/application/errors";
import { queryPaymentMatchForActor } from "@/lib/finance/application/query-payment-match";
import { yuanToCents } from "@/lib/finance/money";

export async function POST(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;

  let body: { organizationId?: string; amount?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { organizationId, amount } = body;

  if (!organizationId || typeof organizationId !== "string") {
    return NextResponse.json({ error: "organizationId 必填" }, { status: 400 });
  }
  if (!amount || typeof amount !== "number" || amount <= 0) {
    return NextResponse.json({ error: "凭证金额必须大于 0" }, { status: 400 });
  }

  const actor = businessActorFromSessionUser(session.user);

  try {
    const result = await queryPaymentMatchForActor(actor, {
      organizationId,
      amountCents: yuanToCents(amount),
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }
}
