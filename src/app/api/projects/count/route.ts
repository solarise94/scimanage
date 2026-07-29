import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { businessActorFromSessionUser } from "@/lib/application/actor";
import { ApplicationError } from "@/lib/application/errors";
import {
  countProjectsByStatusForActor,
  projectListFiltersFromSearchParams,
} from "@/lib/projects/application/query-projects";

/**
 * GET /api/projects/count
 *
 * 按状态分组返回项目计数，供前端状态 chip 渲染。
 * 复用与列表接口相同的筛选条件（权限 + search/dateRange/archived/representative/customer），
 * 但**忽略 status 参数**（chip 要显示各状态计数，不能被当前选中的状态筛选影响）。
 *
 * 返回：{ counts: { NOT_STARTED, IN_PROGRESS, COMPLETED, ON_HOLD, TERMINATED, _total } }
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const actor = businessActorFromSessionUser(session.user);

  try {
    const filters = projectListFiltersFromSearchParams(searchParams);
    const counts = await countProjectsByStatusForActor(actor, filters);
    return NextResponse.json({ counts });
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }
}
