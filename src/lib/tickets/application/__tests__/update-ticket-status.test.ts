import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent" },
});

/**
 * T4.3: canonical update-ticket command shared by PATCH /api/tickets/[id] and
 * Agent tickets.update_status confirm path.
 */
describe("T4.3 updateTicketForActor", () => {
  it("enforces manage gate, invalid status, ActivityLog and Agent/Web parity", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { updateTicketForActor } = await import(
        "@/lib/tickets/application/update-ticket-status"
      );
      const {
        ForbiddenError,
        NotFoundError,
        ValidationError,
      } = await import("@/lib/application/errors");
      const { buildInvocationContext } = await import("@/lib/application/actor");
      const { executeAgentAction } = await import("@/lib/agent-actions/registry");

      const userA = await prisma.user.create({
        data: { email: "t43-usera@example.com", name: "UserA", password: "h", role: "USER" },
      });
      const userB = await prisma.user.create({
        data: { email: "t43-userb@example.com", name: "UserB", password: "h", role: "USER" },
      });

      const userAActor = { userId: userA.id, role: "USER" };
      const userBActor = { userId: userB.id, role: "USER" };
      const webInvocation = buildInvocationContext({ channel: "web" });

      const pActive = await prisma.project.create({
        data: {
          name: "Active 项目",
          members: { create: { userId: userA.id, role: "OWNER" } },
        },
      });
      const pDeleted = await prisma.project.create({
        data: {
          name: "Deleted 项目",
          deleted: true,
          members: { create: { userId: userA.id, role: "OWNER" } },
        },
      });

      const activeTicket = await prisma.ticket.create({
        data: {
          title: "活跃工单",
          projectId: pActive.id,
          createdBy: userA.id,
          status: "OPEN",
          priority: "MEDIUM",
        },
      });
      const deletedProjectTicket = await prisma.ticket.create({
        data: {
          title: "删除项目工单",
          projectId: pDeleted.id,
          createdBy: userA.id,
          status: "OPEN",
          priority: "MEDIUM",
        },
      });

      // manage gate (non-member)
      await expect(
        updateTicketForActor(userBActor, webInvocation, {
          ticketId: activeTicket.id,
          status: "IN_PROGRESS",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // missing ticket
      await expect(
        updateTicketForActor(userAActor, webInvocation, {
          ticketId: "missing-ticket-id",
          status: "CLOSED",
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      // deleted project
      await expect(
        updateTicketForActor(userAActor, webInvocation, {
          ticketId: deletedProjectTicket.id,
          status: "CLOSED",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      // invalid status
      await expect(
        updateTicketForActor(userAActor, webInvocation, {
          ticketId: activeTicket.id,
          status: "INVALID",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      const { ticket: webTicket, previousStatus: webPrev, statusChanged } =
        await updateTicketForActor(userAActor, webInvocation, {
          ticketId: activeTicket.id,
          status: "IN_PROGRESS",
          priority: "HIGH",
          assigneeId: userA.id,
        });

      expect(webPrev).toBe("OPEN");
      expect(statusChanged).toBe(true);
      expect(webTicket.status).toBe("IN_PROGRESS");
      expect(webTicket.priority).toBe("HIGH");
      expect(webTicket.assigneeId).toBe(userA.id);

      const webLog = await prisma.activityLog.findFirst({
        where: {
          projectId: pActive.id,
          type: "TICKET_UPDATED",
          userId: userA.id,
        },
        orderBy: { createdAt: "desc" },
      });
      expect(webLog?.content).toContain("活跃工单");
      expect(webLog?.content).toContain("IN_PROGRESS");
      const webMeta = JSON.parse(webLog!.metadata!);
      expect(webMeta.oldStatus).toBe("OPEN");
      expect(webMeta.newStatus).toBe("IN_PROGRESS");
      expect(webMeta.ticketId).toBe(activeTicket.id);

      const agentUpdated = await executeAgentAction<{
        ticket: {
          id: string;
          title: string;
          status: string;
          previousStatus: string;
        };
      }>(
        agentExecCtx(userAActor),
        "tickets.update_status",
        {
          ticketId: activeTicket.id,
          status: "CLOSED",
        },
        { allowConfirm: true },
      );

      expect(agentUpdated.result.ticket.status).toBe("CLOSED");
      expect(agentUpdated.result.ticket.previousStatus).toBe("IN_PROGRESS");
      expect(agentUpdated.result.ticket.id).toBe(activeTicket.id);

      const agentLog = await prisma.activityLog.findFirst({
        where: {
          projectId: pActive.id,
          type: "TICKET_UPDATED",
          userId: userA.id,
          content: { contains: "CLOSED" },
        },
        orderBy: { createdAt: "desc" },
      });
      expect(agentLog).toBeTruthy();
      const agentMeta = JSON.parse(agentLog!.metadata!);
      expect(agentMeta.oldStatus).toBe("IN_PROGRESS");
      expect(agentMeta.newStatus).toBe("CLOSED");
    });
  }, 120_000);
});
