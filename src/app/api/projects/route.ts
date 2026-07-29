import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { centsToYuan } from "@/lib/finance/money";
import {
  businessActorFromSessionUser,
  buildInvocationContext,
} from "@/lib/application/actor";
import { ApplicationError } from "@/lib/application/errors";
import {
  projectListFiltersFromSearchParams,
  queryProjects,
  shapeProjectListRecord,
} from "@/lib/projects/application/query-projects";
import { createProjectForActor } from "@/lib/projects/application/create-project";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const pageParam = searchParams.get("page");
  const actor = businessActorFromSessionUser(session.user);

  try {
    const filters = projectListFiltersFromSearchParams(searchParams);
    const result = await queryProjects(actor, {
      filters,
      sort: {
        key: searchParams.get("sort")?.trim() || "",
        dir: (() => {
          const orderRaw = searchParams.get("order")?.trim();
          return orderRaw === "asc" || orderRaw === "desc" ? orderRaw : null;
        })(),
      },
      page: pageParam ? Math.max(1, Number(pageParam) || 1) : null,
      pageSize: pageParam
        ? Math.min(Math.max(1, Number(searchParams.get("pageSize")) || 20), 100)
        : null,
    });

    const projects = result.projects.map(shapeProjectListRecord);
    if (pageParam) {
      return NextResponse.json({
        projects,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: result.totalPages,
      });
    }
    return NextResponse.json({ projects });
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    // Profile-only 契约：旧 *CustomerId 系字段一律 400。
    const legacyKey = Object.keys(body as Record<string, unknown>).find((k) =>
      /customerids?$/i.test(k),
    );
    if (legacyKey) {
      return NextResponse.json(
        { error: `请使用 profileId 指定客户（不再接受 ${legacyKey}）` },
        { status: 400 },
      );
    }

    const actor = businessActorFromSessionUser(session.user);
    const invocation = buildInvocationContext({ channel: "web" });
    const { project } = await createProjectForActor(actor, invocation, {
      name: body.name,
      description: body.description,
      organization: body.organization,
      client: body.client,
      representativeId: body.representativeId,
      profileId: body.profileId,
      projectNo: body.projectNo,
      status: body.status,
      progress: body.progress,
      startDate: body.startDate,
      endDate: body.endDate,
      projectType: body.projectType,
      projectContent: body.projectContent,
      quantity: body.quantity,
      procurementSource: body.procurementSource,
      brand: body.brand,
      techSupport: body.techSupport,
      budgetAmount: body.budgetAmount,
      budgetCost: body.budgetCost,
    });

    return NextResponse.json(
      {
        project: {
          ...project,
          budgetAmount: project.budgetAmount != null ? centsToYuan(project.budgetAmount) : null,
          budgetCost: project.budgetCost != null ? centsToYuan(project.budgetCost) : null,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ApplicationError) {
      return NextResponse.json({ error: error.message }, { status: error.httpStatus });
    }
    console.error(error);
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      return NextResponse.json({ error: "项目号已被使用，请重试" }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to create project" }, { status: 500 });
  }
}
