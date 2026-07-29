import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent" },
});

/**
 * T4.1: actor-aware ticket list/detail shared by GET /api/tickets(+[id])
 * and Agent tickets.list.
 */
describe("T4.1 ticket query services", () => {
  it("enforces scope, filters, detail disclosure and Agent parity", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { queryTickets, listTicketsForProject, shapeTicketListItemForAgent } = await import(
        "@/lib/tickets/application/query-tickets"
      );
      const { getTicketDetailForActor } = await import(
        "@/lib/tickets/application/get-ticket-detail"
      );
      const { ForbiddenError, NotFoundError } = await import("@/lib/application/errors");
      const { executeAgentAction } = await import("@/lib/agent-actions/registry");

      const admin = await prisma.user.create({
        data: { email: "t41-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const userA = await prisma.user.create({
        data: { email: "t41-usera@example.com", name: "UserA", password: "h", role: "USER" },
      });
      const userB = await prisma.user.create({
        data: { email: "t41-userb@example.com", name: "UserB", password: "h", role: "USER" },
      });
      const repUser = await prisma.user.create({
        data: { email: "t41-rep@example.com", name: "RepUser", password: "h", role: "REPRESENTATIVE" },
      });

      const adminActor = { userId: admin.id, role: "ADMIN" };
      const userAActor = { userId: userA.id, role: "USER" };
      const userBActor = { userId: userB.id, role: "USER" };
      const repActor = { userId: repUser.id, role: "REPRESENTATIVE" };

      const rep = await prisma.representative.create({
        data: { name: "代表一", email: repUser.email },
      });

      const pA = await prisma.project.create({
        data: {
          name: "Alpha 项目",
          members: { create: { userId: userA.id, role: "OWNER" } },
          representativeId: rep.id,
        },
      });
      const pB = await prisma.project.create({
        data: {
          name: "Beta 项目",
          members: { create: { userId: userB.id, role: "OWNER" } },
        },
      });
      const pDeleted = await prisma.project.create({
        data: {
          name: "Deleted 项目",
          deleted: true,
          members: { create: { userId: userA.id, role: "OWNER" } },
        },
      });

      const tA = await prisma.ticket.create({
        data: {
          title: "Alpha ticket",
          description: "测序问题",
          status: "OPEN",
          projectId: pA.id,
          createdBy: userA.id,
        },
      });
      const tB = await prisma.ticket.create({
        data: {
          title: "Beta ticket",
          status: "IN_PROGRESS",
          projectId: pB.id,
          createdBy: userB.id,
        },
      });
      const tDel = await prisma.ticket.create({
        data: {
          title: "Deleted project ticket",
          status: "OPEN",
          projectId: pDeleted.id,
          createdBy: userA.id,
        },
      });

      await prisma.ticketReply.create({
        data: { ticketId: tA.id, content: "收到", authorId: userA.id },
      });

      const ids = (r: { tickets: Array<{ id: string }> }) => r.tickets.map((t) => t.id).sort();

      // USER A global list: own project only (not deleted project)
      const listA = await queryTickets(userAActor);
      expect(ids(listA)).toEqual([tA.id]);

      // USER B cannot see A's tickets
      const listB = await queryTickets(userBActor);
      expect(ids(listB)).toEqual([tB.id]);

      // ADMIN sees all tickets including on deleted projects
      const listAdmin = await queryTickets(adminActor);
      expect(ids(listAdmin)).toEqual([tA.id, tB.id, tDel.id].sort());

      // Search AND-composed with scope
      const searchA = await queryTickets(userAActor, { filters: { search: "测序" } });
      expect(ids(searchA)).toEqual([tA.id]);
      const searchB = await queryTickets(userBActor, { filters: { search: "测序" } });
      expect(searchB.total).toBe(0);

      // projectId filter in-scope
      const byProject = await queryTickets(userAActor, { filters: { projectId: pA.id } });
      expect(ids(byProject)).toEqual([tA.id]);

      // projectId missing → empty (not error)
      const missingProject = await queryTickets(userAActor, {
        filters: { projectId: "missing-project-id" },
      });
      expect(missingProject.total).toBe(0);

      // projectId out-of-scope → Forbidden
      await expect(
        queryTickets(userBActor, { filters: { projectId: pA.id } }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // Detail in-scope
      const detail = await getTicketDetailForActor(userAActor, tA.id);
      expect(detail.ticket.id).toBe(tA.id);
      expect(detail.replies).toHaveLength(1);
      expect(detail.permissions.canContribute).toBe(true);

      // Out-of-scope detail → NotFound (no existence leak)
      await expect(getTicketDetailForActor(userBActor, tA.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(getTicketDetailForActor(userBActor, "missing-ticket")).rejects.toBeInstanceOf(
        NotFoundError,
      );

      // REPRESENTATIVE via representativeId linkage
      const repList = await listTicketsForProject(repActor, { projectId: pA.id, limit: 10 });
      expect(repList.map((t) => t.id)).toEqual([tA.id]);
      const repDetail = await getTicketDetailForActor(repActor, tA.id);
      expect(repDetail.ticket.id).toBe(tA.id);

      // Agent parity
      const direct = await listTicketsForProject(userAActor, { projectId: pA.id, limit: 10 });
      const agentResult = await executeAgentAction<{ items: Array<{ id: string }> }>(
        agentExecCtx(userAActor),
        "tickets.list",
        { projectId: pA.id, limit: 10 },
      );
      expect(agentResult.result.items.map((i) => i.id)).toEqual(direct.map((t) => t.id));
      expect(agentResult.result.items[0]).toMatchObject(shapeTicketListItemForAgent(direct[0]!));

      await expect(
        executeAgentAction(agentExecCtx(userBActor), "tickets.list", { projectId: pA.id }),
      ).rejects.toMatchObject({ status: 403 });
    });
  }, 120_000);
});
