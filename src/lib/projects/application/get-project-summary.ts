/**
 * Canonical actor-aware project summary query (T3.1).
 *
 * Consumed by Agent `projects.get_summary`. Object scope uses `canReadProject`;
 * out-of-scope and missing projects both raise NotFoundError (§2.3 disclosure).
 */
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { NotFoundError } from "@/lib/application/errors";
import { canReadProject } from "@/lib/permissions";
import { getCustomerOrganizationName } from "@/lib/customer-organization";

export type ProjectSummaryResult = {
  project: {
    id: string;
    name: string;
    status: string;
    customerName: string | null;
    representative: string | null;
    updatedAt: string;
    customerOrganization: string | null;
  };
  counts: {
    tickets: number;
    comments: number;
    attachments: number;
    linkedOrders: number;
    members: number;
  };
  recentTickets: Array<{
    id: string;
    title: string;
    status: string;
    updatedAt: string;
  }>;
  recentNotes: Array<{
    id: string;
    category: string;
    content: string;
    authorName: string | null;
    createdAt: string;
  }>;
};

export async function getProjectSummaryForActor(
  actor: BusinessActor,
  projectId: string,
): Promise<ProjectSummaryResult> {
  const readable = await canReadProject(projectId, actor.userId, actor.role);
  if (!readable) {
    throw new NotFoundError(`找不到项目「${projectId}」，或没有查看权限`);
  }

  const limitedSalesView = actor.role === "REPRESENTATIVE";
  const canViewNotes = actor.role === "ADMIN" || actor.role === "USER";

  const [project, recentNotes] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        status: true,
        representative: true,
        updatedAt: true,
        client: true,
        profile: {
          select: {
            name: true,
            organization: true,
            org: { select: { canonicalName: true } },
          },
        },
        _count: {
          select: {
            tickets: true,
            comments: true,
            attachments: { where: { status: "READY", archived: false } },
            members: true,
            orderLinks: true,
          },
        },
        tickets: {
          take: 5,
          orderBy: { updatedAt: "desc" },
          select: { id: true, title: true, status: true, updatedAt: true },
        },
      },
    }),
    canViewNotes
      ? prisma.projectNote.findMany({
          where: { projectId, visibility: "INTERNAL" },
          take: 5,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            category: true,
            content: true,
            authorNameSnapshot: true,
            createdAt: true,
          },
        })
      : Promise.resolve([]),
  ]);

  if (!project) {
    throw new NotFoundError(`找不到项目「${projectId}」，或没有查看权限`);
  }

  return {
    project: {
      id: project.id,
      name: project.name,
      status: project.status,
      customerName: project.profile?.name ?? project.client ?? null,
      representative: project.representative ?? null,
      updatedAt: project.updatedAt.toISOString(),
      customerOrganization: project.profile
        ? getCustomerOrganizationName({
            organization: project.profile.organization,
            org: project.profile.org,
          })
        : null,
    },
    counts: {
      tickets: limitedSalesView ? 0 : project._count.tickets,
      comments: limitedSalesView ? 0 : project._count.comments,
      attachments: limitedSalesView ? 0 : project._count.attachments,
      linkedOrders: project._count.orderLinks,
      members: project._count.members,
    },
    recentTickets: limitedSalesView
      ? []
      : project.tickets.map((ticket) => ({
          id: ticket.id,
          title: ticket.title,
          status: ticket.status,
          updatedAt: ticket.updatedAt.toISOString(),
        })),
    recentNotes: canViewNotes
      ? recentNotes.map((note) => ({
          id: note.id,
          category: note.category,
          content:
            note.content.length > 100
              ? `${note.content.slice(0, 100)}…`
              : note.content,
          authorName: note.authorNameSnapshot,
          createdAt: note.createdAt.toISOString(),
        }))
      : [],
  };
}
