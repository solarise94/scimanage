/**
 * Canonical actor-aware ticket list/search query service (T4.1).
 *
 * Shared by:
 *  - `GET /api/tickets`
 *  - Agent `tickets.list`
 *
 * Object scope uses `canReadProject` / `getReadableProjectIds` (project-scoped).
 * Filter AND-composition, sorting and pagination live here.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { ForbiddenError } from "@/lib/application/errors";
import { canReadProject, getReadableProjectIds } from "@/lib/permissions";

/** List include — matches the historical page payload shape. */
export const TICKET_LIST_INCLUDE = {
  project: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true, avatar: true } },
} satisfies Prisma.TicketInclude;

export type TicketListRecord = Prisma.TicketGetPayload<{ include: typeof TICKET_LIST_INCLUDE }>;

/** Slim select for Agent list cards. */
export const TICKET_AGENT_LIST_SELECT = {
  id: true,
  title: true,
  status: true,
  priority: true,
  updatedAt: true,
  assignee: { select: { name: true } },
} satisfies Prisma.TicketSelect;

export type TicketAgentListRecord = Prisma.TicketGetPayload<{ select: typeof TICKET_AGENT_LIST_SELECT }>;

export type TicketListFilters = {
  projectId?: string | null;
  status?: string | null;
  search?: string | null;
};

export type TicketListSort = {
  key?: "createdAt" | "updatedAt" | null;
  dir?: "asc" | "desc" | null;
};

export type TicketListParams = {
  filters?: TicketListFilters;
  sort?: TicketListSort;
  page?: number;
  pageSize?: number;
};

export type TicketListResult = {
  tickets: TicketListRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export function shapeTicketListItemForAgent(ticket: TicketAgentListRecord) {
  return {
    id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    priority: ticket.priority,
    assigneeName: ticket.assignee?.name ?? null,
    updatedAt: ticket.updatedAt.toISOString(),
  };
}

/**
 * Build the shared Ticket WHERE for list/search.
 * Returns `{ empty: true }` when the actor has no visible tickets (global list)
 * or when an explicit `projectId` does not exist.
 * Throws ForbiddenError when `projectId` is set but the actor cannot read that project.
 */
export async function resolveTicketListWhere(
  actor: BusinessActor,
  filters: TicketListFilters = {},
): Promise<{ where: Prisma.TicketWhereInput } | { empty: true }> {
  const and: Prisma.TicketWhereInput[] = [];
  const projectId = filters.projectId?.trim();

  if (projectId) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!project) return { empty: true };

    const readable = await canReadProject(projectId, actor.userId, actor.role);
    if (!readable) throw new ForbiddenError("Forbidden");

    and.push({ projectId });
  } else {
    const isAdmin = actor.role === "ADMIN";
    if (!isAdmin) {
      const readableIds = await getReadableProjectIds(actor.userId, actor.role);
      if (!readableIds || readableIds.length === 0) return { empty: true };
      and.push({ project: { deleted: false } });
      and.push({ projectId: { in: readableIds } });
    }
    // ADMIN: unrestricted (includes tickets on deleted projects, matching canReadProject)
  }

  const status = filters.status?.trim();
  if (status) and.push({ status });

  const search = filters.search?.trim();
  if (search) {
    and.push({
      OR: [{ title: { contains: search } }, { description: { contains: search } }],
    });
  }

  if (and.length === 0) return { where: {} };
  if (and.length === 1) return { where: and[0]! };
  return { where: { AND: and } };
}

function buildOrderBy(sort?: TicketListSort): Prisma.TicketOrderByWithRelationInput {
  const key = sort?.key === "updatedAt" ? "updatedAt" : "createdAt";
  const dir: "asc" | "desc" = sort?.dir === "asc" ? "asc" : "desc";
  return { [key]: dir };
}

/**
 * Paginated ticket list for Web (and any caller needing page/total).
 * Default sort: createdAt desc (historical page behavior).
 */
export async function queryTickets(
  actor: BusinessActor,
  params: TicketListParams = {},
): Promise<TicketListResult> {
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(params.pageSize ?? 20)));

  const resolved = await resolveTicketListWhere(actor, params.filters ?? {});
  if ("empty" in resolved) {
    return { tickets: [], total: 0, page, pageSize, totalPages: 0 };
  }

  const orderBy = buildOrderBy(params.sort ?? { key: "createdAt", dir: "desc" });

  const [tickets, total] = await Promise.all([
    prisma.ticket.findMany({
      where: resolved.where,
      include: TICKET_LIST_INCLUDE,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.ticket.count({ where: resolved.where }),
  ]);

  return {
    tickets,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

/** Agent-oriented list within one project: updatedAt desc, hard limit. */
export async function listTicketsForProject(
  actor: BusinessActor,
  input: { projectId: string; status?: string | null; limit?: number },
): Promise<TicketAgentListRecord[]> {
  const limit = Math.min(30, Math.max(1, Math.floor(input.limit ?? 10)));

  const resolved = await resolveTicketListWhere(actor, {
    projectId: input.projectId,
    status: input.status,
  });
  if ("empty" in resolved) return [];

  return prisma.ticket.findMany({
    where: resolved.where,
    take: limit,
    orderBy: { updatedAt: "desc" },
    select: TICKET_AGENT_LIST_SELECT,
  });
}
