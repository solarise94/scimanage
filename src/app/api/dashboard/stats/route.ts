import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getReadableProjectIds, isRepresentative } from "@/lib/permissions";
import { normalProjectSystemTypeFilter } from "@/lib/projects/application/operational-where";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const isAdmin = session.user.role === "ADMIN";

  // null = no filter (admin)；非 ADMIN 走 getReadableProjectIds（含部门 fail-closed）
  let projectIds: string[] | null = null;
  if (!isAdmin) {
    projectIds = await getReadableProjectIds(
      session.user.id,
      session.user.role,
      prisma,
      session.user.department,
    );
  }
  if (projectIds !== null && projectIds.length === 0) {
    return NextResponse.json({
      totalProjects: 0,
      inProgressProjects: 0,
      completedProjects: 0,
      pendingTickets: 0,
      weekProjects: 0,
      weekTickets: 0,
      statusDistribution: [],
      ticketTrend: [],
    });
  }

  const projectIdFilter = projectIds ? { in: projectIds } : undefined;
  // Phase 0 review #3：横切防污染——所有项目聚合排除 GOVERNANCE_BUCKET（如 PRJ-OTHER）。
  // 治理桶不计入项目总数、本周新增、状态分布等 KPI。
  const baseProjectWhere = projectIds
    ? { id: projectIdFilter, deleted: false, ...normalProjectSystemTypeFilter() }
    : { deleted: false, ...normalProjectSystemTypeFilter() };
  const baseTicketWhere = isRepresentative(session.user.role)
    ? { projectId: projectIdFilter, project: { deleted: false, ...normalProjectSystemTypeFilter() }, createdBy: session.user.id }
    : projectIds
      ? { projectId: projectIdFilter, project: { deleted: false, ...normalProjectSystemTypeFilter() } }
      : { project: { deleted: false, ...normalProjectSystemTypeFilter() } };

  const [
    totalProjects,
    inProgressProjects,
    completedProjects,
    pendingTickets,
    weekProjects,
    weekTickets,
  ] = await Promise.all([
    prisma.project.count({ where: baseProjectWhere }),
    prisma.project.count({ where: { ...baseProjectWhere, status: "IN_PROGRESS" } }),
    prisma.project.count({ where: { ...baseProjectWhere, status: "COMPLETED" } }),
    prisma.ticket.count({ where: { ...baseTicketWhere, status: { not: "CLOSED" } } }),
    prisma.project.count({ where: { ...baseProjectWhere, createdAt: { gte: weekAgo } } }),
    prisma.ticket.count({ where: { ...baseTicketWhere, createdAt: { gte: weekAgo } } }),
  ]);

  const statusDistribution = await prisma.project.groupBy({
    by: ["status"],
    where: baseProjectWhere,
    _count: { status: true },
  });

  // SQLite parameterized raw query for ticket trend
  // Phase 0 review #3：raw SQL 也需排除治理桶（systemType = 'NORMAL'）
  let ticketTrend;
  if (isRepresentative(session.user.role) && projectIds) {
    const projectIdList = projectIds.map(() => "?").join(",");
    ticketTrend = await prisma.$queryRawUnsafe(
      `SELECT date(Ticket.createdAt) as date, COUNT(*) as count
       FROM Ticket
       JOIN Project ON Ticket.projectId = Project.id
       WHERE Ticket.projectId IN (${projectIdList})
         AND Project.deleted = 0
         AND Project.systemType = 'NORMAL'
         AND Ticket.createdBy = ?
         AND Ticket.createdAt >= datetime('now', '-7 days')
       GROUP BY date(Ticket.createdAt)
       ORDER BY date(Ticket.createdAt)`,
      ...projectIds, session.user.id
    );
  } else if (projectIds) {
    const projectIdList = projectIds.map(() => "?").join(",");
    ticketTrend = await prisma.$queryRawUnsafe(
      `SELECT date(Ticket.createdAt) as date, COUNT(*) as count
       FROM Ticket
       JOIN Project ON Ticket.projectId = Project.id
       WHERE Ticket.projectId IN (${projectIdList})
         AND Project.deleted = 0
         AND Project.systemType = 'NORMAL'
         AND Ticket.createdAt >= datetime('now', '-7 days')
       GROUP BY date(Ticket.createdAt)
       ORDER BY date(Ticket.createdAt)`,
      ...projectIds
    );
  } else {
    // ADMIN: all non-deleted non-governance projects
    ticketTrend = await prisma.$queryRawUnsafe(
      `SELECT date(Ticket.createdAt) as date, COUNT(*) as count
       FROM Ticket
       JOIN Project ON Ticket.projectId = Project.id
       WHERE Project.deleted = 0
         AND Project.systemType = 'NORMAL'
         AND Ticket.createdAt >= datetime('now', '-7 days')
       GROUP BY date(Ticket.createdAt)
       ORDER BY date(Ticket.createdAt)`
    );
  }

  return NextResponse.json({
    totalProjects,
    inProgressProjects,
    completedProjects,
    pendingTickets,
    weekProjects,
    weekTickets,
    statusDistribution,
    ticketTrend,
  });
}
