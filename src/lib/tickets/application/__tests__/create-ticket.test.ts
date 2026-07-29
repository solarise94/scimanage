import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent" },
});

/**
 * T4.2: canonical create-ticket command shared by POST /api/tickets and
 * Agent tickets.create_from_text confirm path.
 */
describe("T4.2 createTicketForActor", () => {
  it("enforces contribute gate, deleted project, validation and Agent/Web parity", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { createTicketForActor } = await import(
        "@/lib/tickets/application/create-ticket"
      );
      const {
        ForbiddenError,
        NotFoundError,
        ValidationError,
      } = await import("@/lib/application/errors");
      const { buildInvocationContext } = await import("@/lib/application/actor");
      const { executeAgentAction } = await import("@/lib/agent-actions/registry");

      const userA = await prisma.user.create({
        data: { email: "t42-usera@example.com", name: "UserA", password: "h", role: "USER" },
      });
      const userB = await prisma.user.create({
        data: { email: "t42-userb@example.com", name: "UserB", password: "h", role: "USER" },
      });

      const userAActor = { userId: userA.id, role: "USER" };
      const userBActor = { userId: userB.id, role: "USER" };
      const webInvocation = buildInvocationContext({ channel: "web" });

      const pA = await prisma.project.create({
        data: {
          name: "Alpha 项目",
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

      // contribute gate
      await expect(
        createTicketForActor(userBActor, webInvocation, {
          projectId: pA.id,
          title: "越权工单",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // deleted project
      await expect(
        createTicketForActor(userAActor, webInvocation, {
          projectId: pDeleted.id,
          title: "删除项目工单",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      // missing project
      await expect(
        createTicketForActor(userAActor, webInvocation, {
          projectId: "missing-project-id",
          title: "不存在",
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      // invalid priority / assignee / reminder
      await expect(
        createTicketForActor(userAActor, webInvocation, {
          projectId: pA.id,
          title: "坏优先级",
          priority: "INVALID",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      await expect(
        createTicketForActor(userAActor, webInvocation, {
          projectId: pA.id,
          title: "坏负责人",
          assigneeId: userB.id,
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      await expect(
        createTicketForActor(userAActor, webInvocation, {
          projectId: pA.id,
          title: "坏提醒",
          reminderDate: "not-a-date",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      const reminderDate = "2026-08-15T08:00:00.000Z";
      const { ticket: webTicket } = await createTicketForActor(userAActor, webInvocation, {
        projectId: pA.id,
        title: "Web 工单",
        description: "测序问题",
        priority: "HIGH",
        assigneeId: userA.id,
        reminderDate,
      });

      expect(webTicket.title).toBe("Web 工单");
      expect(webTicket.description).toBe("测序问题");
      expect(webTicket.priority).toBe("HIGH");
      expect(webTicket.status).toBe("OPEN");
      expect(webTicket.assigneeId).toBe(userA.id);
      expect(webTicket.createdBy).toBe(userA.id);
      expect(webTicket.reminderDate?.toISOString()).toBe(reminderDate);
      expect(webTicket.project.id).toBe(pA.id);

      const webLog = await prisma.activityLog.findFirst({
        where: { projectId: pA.id, type: "TICKET_CREATED", userId: userA.id },
        orderBy: { createdAt: "desc" },
      });
      expect(webLog?.content).toContain("Web 工单");
      expect(JSON.parse(webLog!.metadata!).ticketId).toBe(webTicket.id);

      const prevMinimaxKey = process.env.MINIMAX_API_KEY;
      process.env.MINIMAX_API_KEY = "vitest-draft-key";
      try {
        const agentCreated = await executeAgentAction<{
        ticket: {
          id: string;
          projectId: string;
          title: string;
          status: string;
          priority: string;
          assigneeId: string | null;
        };
      }>(
        agentExecCtx(userAActor),
        "tickets.create_from_text",
        {
          projectId: pA.id,
          title: "Agent 工单",
          description: "Agent 描述",
          priority: "URGENT",
          assigneeId: userA.id,
          reminderDate,
        },
        { allowConfirm: true },
      );

      expect(agentCreated.result.ticket.title).toBe("Agent 工单");
      expect(agentCreated.result.ticket.priority).toBe("URGENT");
      expect(agentCreated.result.ticket.status).toBe("OPEN");
      expect(agentCreated.result.ticket.projectId).toBe(pA.id);
      expect(agentCreated.result.ticket.assigneeId).toBe(userA.id);

      const agentRow = await prisma.ticket.findUnique({
        where: { id: agentCreated.result.ticket.id },
      });
      expect(agentRow?.description).toBe("Agent 描述");
      expect(agentRow?.createdBy).toBe(userA.id);
      expect(agentRow?.reminderDate?.toISOString()).toBe(reminderDate);

      const agentLog = await prisma.activityLog.findFirst({
        where: {
          projectId: pA.id,
          type: "TICKET_CREATED",
          userId: userA.id,
          content: { contains: "Agent 工单" },
        },
      });
      expect(agentLog).toBeTruthy();
      } finally {
        if (prevMinimaxKey === undefined) {
          delete process.env.MINIMAX_API_KEY;
        } else {
          process.env.MINIMAX_API_KEY = prevMinimaxKey;
        }
      }
    });
  }, 120_000);
});
