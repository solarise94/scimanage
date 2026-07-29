/**
 * Canonical actor-aware project list/search/count query service (T3.1).
 *
 * Shared by:
 *  - `GET /api/projects` / `GET /api/projects/count`
 *  - Agent `projects.search`
 *
 * Capability is implicit for authenticated actors that can use the Agent/Web
 * surfaces; object scope uses `getReadableProjectIds` (ADMIN = unrestricted).
 * Filter AND-composition, deleted/archived口径, sorting and pagination live here.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { ForbiddenError, ValidationError } from "@/lib/application/errors";
import { getReadableProjectIds } from "@/lib/permissions";
import { getCustomerOrganizationName } from "@/lib/customer-organization";
import { centsToYuan } from "@/lib/finance/money";

/** List include — matches the historical page payload shape. */
export const PROJECT_LIST_INCLUDE = {
  members: {
    include: {
      user: {
        select: { id: true, name: true, email: true, avatar: true },
      },
    },
  },
  rep: {
    select: { id: true, name: true, email: true },
  },
  profile: {
    select: {
      id: true,
      name: true,
      customerCode: true,
      organization: true,
      organizationId: true,
      org: { select: { canonicalName: true } },
    },
  },
  _count: {
    select: { tickets: true, comments: true },
  },
} satisfies Prisma.ProjectInclude;

export type ProjectListRecord = Prisma.ProjectGetPayload<{ include: typeof PROJECT_LIST_INCLUDE }>;

/** Slimmer select for Agent search cards. */
export const PROJECT_SEARCH_SELECT = {
  id: true,
  name: true,
  status: true,
  representative: true,
  updatedAt: true,
  profile: {
    select: {
      name: true,
      organization: true,
      org: { select: { canonicalName: true } },
    },
  },
} satisfies Prisma.ProjectSelect;

export type ProjectSearchRecord = Prisma.ProjectGetPayload<{ select: typeof PROJECT_SEARCH_SELECT }>;

export type ProjectListFilters = {
  search?: string | null;
  status?: string | null;
  archived?: string | null;
  includeDeleted?: boolean;
  dateRange?: string | null;
  representativeId?: string | null;
  representativeName?: string | null;
  profileId?: string | null;
  customerName?: string | null;
  /** Count chips ignore the active status filter. */
  ignoreStatus?: boolean;
};

export type ProjectListSort = { key?: string | null; dir?: "asc" | "desc" | null };

export type ProjectListParams = {
  filters?: ProjectListFilters;
  sort?: ProjectListSort;
  /** When set, paginate; when omitted, return up to `unpagedTake` (default 1000). */
  page?: number | null;
  pageSize?: number | null;
  unpagedTake?: number;
};

export type ProjectListResult = {
  projects: ProjectListRecord[];
  total: number | null;
  page: number | null;
  pageSize: number | null;
  totalPages: number | null;
};

const SORTABLE_MAP: Record<string, { field: string; defaultDir: "asc" | "desc" } | null> = {
  progress: { field: "progress", defaultDir: "desc" },
  createdAt: { field: "createdAt", defaultDir: "desc" },
  updatedAt: { field: "updatedAt", defaultDir: "desc" },
};

function applyDateRange(
  where: Prisma.ProjectWhereInput,
  dateRange: string | null | undefined,
): void {
  if (!dateRange) return;
  const now = new Date();
  const gte = new Date();
  switch (dateRange) {
    case "7d":
      gte.setDate(now.getDate() - 7);
      break;
    case "30d":
      gte.setDate(now.getDate() - 30);
      break;
    case "90d":
      gte.setDate(now.getDate() - 90);
      break;
    case "1y":
      gte.setFullYear(now.getFullYear() - 1);
      break;
    default:
      return;
  }
  where.createdAt = { gte };
}

/**
 * Build the shared Project WHERE for list/search/count.
 * Returns `{ empty: true }` when the actor has no readable projects.
 */
export async function resolveProjectListWhere(
  actor: BusinessActor,
  filters: ProjectListFilters = {},
): Promise<{ where: Prisma.ProjectWhereInput } | { empty: true }> {
  const isAdmin = actor.role === "ADMIN";

  let projectIds: string[] | null = null;
  if (!isAdmin) {
    projectIds = await getReadableProjectIds(actor.userId, actor.role, prisma, actor.department);
    if (!projectIds || projectIds.length === 0) return { empty: true };
  }

  const where: Prisma.ProjectWhereInput = {};
  if (projectIds) {
    where.id = { in: projectIds };
  }
  // 横切防污染（设计文档 §8.6）：所有正常项目聚合默认排除治理桶（GOVERNANCE_BUCKET）。
  // 只有治理专用 service 通过显式 systemType 过滤查询治理桶。
  where.systemType = "NORMAL";

  if (filters.includeDeleted) {
    if (!isAdmin) {
      throw new ForbiddenError("Forbidden");
    }
    where.deleted = true;
  } else {
    where.deleted = false;
  }

  if (filters.archived === "true") {
    where.archived = true;
  } else if (filters.archived === "false") {
    where.archived = false;
  }

  if (!filters.ignoreStatus) {
    const status = filters.status?.trim();
    if (status) {
      where.status = status.includes(",") ? { in: status.split(",") } : status;
    }
  }

  const search = filters.search?.trim();
  if (search) {
    // Unified search fields for Web + Agent (Agent historically searched more columns).
    where.OR = [
      { name: { contains: search } },
      { description: { contains: search } },
      { client: { contains: search } },
      { organization: { contains: search } },
      { representative: { contains: search } },
      { profile: { is: { name: { contains: search } } } },
    ];
  }

  applyDateRange(where, filters.dateRange);

  if (filters.representativeId) {
    where.representativeId = filters.representativeId;
  } else if (filters.representativeName) {
    where.representative = filters.representativeName;
  }
  if (filters.profileId) {
    where.profileId = filters.profileId;
  } else if (filters.customerName) {
    where.client = filters.customerName;
  }

  return { where };
}

function buildOrderBy(
  sort: ProjectListSort | undefined,
  paginated: boolean,
): Prisma.ProjectOrderByWithRelationInput[] {
  const key = (sort?.key ?? "").trim();
  const sortEntry = SORTABLE_MAP[key];
  const dir: "asc" | "desc" =
    sort?.dir === "asc" || sort?.dir === "desc"
      ? sort.dir
      : sortEntry?.defaultDir || "desc";

  if (paginated && sortEntry) {
    return [
      { deleted: "asc" },
      { archived: "asc" },
      { [sortEntry.field]: dir } as Prisma.ProjectOrderByWithRelationInput,
      { id: "asc" },
    ];
  }
  return [
    { deleted: "asc" },
    { archived: "asc" },
    { updatedAt: "desc" },
  ];
}

/** Shape list rows for the page JSON (cust DTO + yuan amounts). */
export function shapeProjectListRecord(p: ProjectListRecord) {
  const { profile, ...rest } = p;
  const cust = profile
    ? {
        id: profile.id,
        name: profile.name ?? null,
        customerCode: profile.customerCode ?? null,
        organization: getCustomerOrganizationName({
          organization: profile.organization,
          org: profile.org,
        }),
        organizationId: profile.organizationId ?? null,
      }
    : null;
  return {
    ...rest,
    cust,
    budgetAmount: p.budgetAmount != null ? centsToYuan(p.budgetAmount) : null,
    budgetCost: p.budgetCost != null ? centsToYuan(p.budgetCost) : null,
  };
}

export function shapeProjectSearchItem(project: ProjectSearchRecord) {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    customerName: project.profile?.name ?? null,
    representative: project.representative ?? null,
    updatedAt: project.updatedAt.toISOString(),
    customerOrganization: project.profile
      ? getCustomerOrganizationName({
          organization: project.profile.organization,
          org: project.profile.org,
        })
      : null,
  };
}

/**
 * List projects for an actor. Pass `page` for paginated list; omit for board/export
 * (capped by `unpagedTake`, default 1000).
 */
export async function queryProjects(
  actor: BusinessActor,
  params: ProjectListParams = {},
): Promise<ProjectListResult> {
  const resolved = await resolveProjectListWhere(actor, params.filters ?? {});
  if ("empty" in resolved) {
    return {
      projects: [],
      total: params.page != null ? 0 : null,
      page: params.page != null ? Math.max(1, params.page || 1) : null,
      pageSize: params.page != null ? Math.min(Math.max(1, params.pageSize || 20), 100) : null,
      totalPages: params.page != null ? 0 : null,
    };
  }

  const paginated = params.page != null && params.page !== undefined;
  const orderBy = buildOrderBy(params.sort, paginated);

  if (paginated) {
    const pageNum = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(Math.max(1, Number(params.pageSize) || 20), 100);
    const [projects, total] = await Promise.all([
      prisma.project.findMany({
        where: resolved.where,
        include: PROJECT_LIST_INCLUDE,
        orderBy,
        skip: (pageNum - 1) * pageSize,
        take: pageSize,
      }),
      prisma.project.count({ where: resolved.where }),
    ]);
    return {
      projects,
      total,
      page: pageNum,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  const take = Math.min(Math.max(1, params.unpagedTake ?? 1000), 5000);
  const projects = await prisma.project.findMany({
    where: resolved.where,
    include: PROJECT_LIST_INCLUDE,
    orderBy,
    take,
  });
  return {
    projects,
    total: null,
    page: null,
    pageSize: null,
    totalPages: null,
  };
}

/** Agent-oriented search: same scope/filters, slim select, hard limit. */
export async function searchProjectsForActor(
  actor: BusinessActor,
  input: { query?: string | null; status?: string | null; limit?: number },
): Promise<ProjectSearchRecord[]> {
  const limit = Math.min(Math.max(1, input.limit ?? 10), 30);
  const resolved = await resolveProjectListWhere(actor, {
    search: input.query,
    status: input.status,
  });
  if ("empty" in resolved) return [];

  return prisma.project.findMany({
    where: resolved.where,
    take: limit,
    orderBy: { updatedAt: "desc" },
    select: PROJECT_SEARCH_SELECT,
  });
}

export type ProjectStatusCounts = {
  NOT_STARTED: number;
  IN_PROGRESS: number;
  COMPLETED: number;
  ON_HOLD: number;
  TERMINATED: number;
  _total: number;
  [status: string]: number;
};

/** Status chip counts — same filters as list, ignoring `status`. */
export async function countProjectsByStatusForActor(
  actor: BusinessActor,
  filters: ProjectListFilters = {},
): Promise<ProjectStatusCounts> {
  const resolved = await resolveProjectListWhere(actor, {
    ...filters,
    ignoreStatus: true,
  });
  const counts: ProjectStatusCounts = {
    NOT_STARTED: 0,
    IN_PROGRESS: 0,
    COMPLETED: 0,
    ON_HOLD: 0,
    TERMINATED: 0,
    _total: 0,
  };
  if ("empty" in resolved) return counts;

  const groups = await prisma.project.groupBy({
    by: ["status"],
    where: resolved.where,
    _count: { status: true },
  });
  let total = 0;
  for (const g of groups) {
    const n = g._count.status;
    counts[g.status] = n;
    total += n;
  }
  counts._total = total;
  return counts;
}

/** Parse URLSearchParams into ProjectListFilters (shared by list + count routes). */
export function projectListFiltersFromSearchParams(
  searchParams: URLSearchParams,
): ProjectListFilters {
  const legacyParam = [...searchParams.keys()].find((k) => /customerids?$/i.test(k));
  if (legacyParam) {
    throw new ValidationError(`请使用 profileId 筛选项目（不再接受 ${legacyParam}）`);
  }
  return {
    search: searchParams.get("search"),
    status: searchParams.get("status"),
    archived: searchParams.get("archived"),
    includeDeleted: searchParams.get("includeDeleted") === "true",
    dateRange: searchParams.get("dateRange"),
    representativeId: searchParams.get("representativeId"),
    representativeName: searchParams.get("representativeName"),
    profileId: searchParams.get("profileId"),
    customerName: searchParams.get("customerName"),
  };
}
