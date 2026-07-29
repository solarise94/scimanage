import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { businessActorFromSessionUser, buildInvocationContext } from "@/lib/application/actor";
import { ApplicationError } from "@/lib/application/errors";
import { createFollowUpTaskForActor } from "@/lib/crm/application/create-followup-task";
import { toPublicFollowUpProfile } from "@/lib/crm/public-dto";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status") || "OPEN";
  const ownerUserId = searchParams.get("ownerUserId") || "";
  const mine = searchParams.get("mine") === "true";

  const { prisma } = await import("@/lib/prisma");
  const {
    isRepresentativeRole,
    isRegionalManagerRole,
    getEffectiveCrmVisibleProfileIds,
  } = await import("@/lib/crm/permissions");
  const { resolveDashboardScope } = await import("@/lib/crm/dashboard-data");
  const { resolveActorDepartmentOrNull } = await import("@/lib/department");

  const isScoped = isRepresentativeRole(session.user.role) || isRegionalManagerRole(session.user.role);

  let visibleProfileIds: Set<string> | null = null;
  if (isScoped) {
    if (mine) {
      const scope = await resolveDashboardScope(session.user.id, session.user.role);
      visibleProfileIds = scope.myProfileIds;
    } else {
      visibleProfileIds = await getEffectiveCrmVisibleProfileIds(session.user.id, session.user.role);
    }
  }

  const conditions: Record<string, unknown>[] = [{ status }];
  // §6.6 末条 / §8.6：非 ADMIN 列表查询 AND departmentSnapshot = actor 部门。
  // ADMIN 不加该过滤（可跨部门运营记录按部门标签展示）。
  // Fail-closed（设计 §6.1）：部门无法权威解析时返回空集，不静默降级 FIELD_SALES。
  if (session.user.role !== "ADMIN") {
    const actorDept = await resolveActorDepartmentOrNull(session.user.id);
    if (!actorDept) {
      return NextResponse.json({ tasks: [] });
    }
    conditions.push({ departmentSnapshot: actorDept });
  }
  if (mine) {
    conditions.push({ ownerUserId: session.user.id });
  } else if (ownerUserId) {
    conditions.push({ ownerUserId });
  }

  if (isScoped) {
    const profileIds = visibleProfileIds ? [...visibleProfileIds] : [];
    if (mine) {
      // Personal workbench must be both owned by the current user and attached to
      // a profile in their own effective CRM scope. Never broaden with an OR.
      conditions.push({ profileId: { in: profileIds } });
    } else {
      conditions.push({
        OR: [
          { profileId: { in: profileIds } },
          { ownerUserId: session.user.id },
        ],
      });
    }
  }

  const where = { AND: conditions };

  const tasks = await prisma.crmFollowUpTask.findMany({
    where,
    include: {
      ownerUser: { select: { id: true, name: true } },
      createdByUser: { select: { id: true, name: true } },
      profile: {
        select: {
          id: true,
          name: true,
          customerCode: true,
        },
      },
    },
    orderBy: { dueAt: "asc" },
  });

  return NextResponse.json({
    tasks: tasks.map((task) => ({
      ...task,
      profile: task.profile ? toPublicFollowUpProfile(task.profile) : task.profile,
    })),
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const actor = businessActorFromSessionUser(session.user);
    const invocation = buildInvocationContext({ channel: "web" });
    const { task } = await createFollowUpTaskForActor(actor, invocation, {
      profileId: body.profileId,
      ownerUserId: body.ownerUserId,
      title: body.title,
      dueAt: body.dueAt,
      taskType: body.taskType,
    });

    return NextResponse.json(
      {
        task: {
          ...task,
          profile: task.profile ? toPublicFollowUpProfile(task.profile) : task.profile,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }
}
