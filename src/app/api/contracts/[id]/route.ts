import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { businessActorFromSessionUser } from "@/lib/application/actor";
import { ApplicationError } from "@/lib/application/errors";
import { getContractDetailForActor } from "@/lib/contracts/application/get-contract-detail";

// T8.1b 起走 canonical application service：全部覆盖订单可见才可读，
// partial/none fail-closed 为 404（旧口径为「任一订单可见」→ 403）。
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const actor = businessActorFromSessionUser(session.user);
    const { id } = await params;
    const contract = await getContractDetailForActor(actor, id);
    return NextResponse.json({ contract });
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }
}
