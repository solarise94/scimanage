import { describe, expect, it, vi } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

// 本测试验证通知落库，不验证 SMTP。禁止后台任务访问 Ethereal/真实网络，
// 同时避免异步发送把刚创建的 pending 状态竞态改为 sent/failed。
vi.mock("@/lib/mail", () => ({
  sendMail: vi.fn(async () => ({ messageId: "test-message", transport: "test" as const })),
  sendMailInBackground: vi.fn(),
  smtpEnabled: vi.fn(() => false),
}));

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent" },
});

/**
 * T4.4: canonical reply-ticket command shared by POST /api/tickets/[id]/replies
 * and Agent tickets.reply confirm path.
 */
describe("T4.4 replyToTicketForActor", () => {
  it("enforces contribute gate, ActivityLog, creator notification and Agent/Web parity", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { replyToTicketForActor, resolveTicketCreatorUser } = await import(
        "@/lib/tickets/application/reply-ticket"
      );
      const {
        ForbiddenError,
        NotFoundError,
        ValidationError,
      } = await import("@/lib/application/errors");
      const { buildInvocationContext } = await import("@/lib/application/actor");
      const { executeAgentAction } = await import("@/lib/agent-actions/registry");

      const creator = await prisma.user.create({
        data: {
          email: "t44-creator@example.com",
          name: "Creator",
          password: "h",
          role: "USER",
          emailOnTicketReply: true,
        },
      });
      const replier = await prisma.user.create({
        data: {
          email: "t44-replier@example.com",
          name: "Replier",
          password: "h",
          role: "USER",
          emailOnTicketReply: true,
        },
      });
      const outsider = await prisma.user.create({
        data: {
          email: "t44-outsider@example.com",
          name: "Outsider",
          password: "h",
          role: "USER",
        },
      });
      const repCreator = await prisma.user.create({
        data: {
          email: "t44-rep@example.com",
          name: "RepCreator",
          password: "h",
          role: "REPRESENTATIVE",
          emailOnTicketReply: true,
        },
      });

      const creatorActor = { userId: creator.id, role: "USER" };
      const replierActor = { userId: replier.id, role: "USER" };
      const outsiderActor = { userId: outsider.id, role: "USER" };
      const webInvocation = buildInvocationContext({ channel: "web" });

      const project = await prisma.project.create({
        data: {
          name: "Reply 项目",
          members: {
            create: [
              { userId: creator.id, role: "OWNER" },
              { userId: replier.id, role: "MEMBER" },
            ],
          },
        },
      });
      const deletedProject = await prisma.project.create({
        data: {
          name: "Deleted 项目",
          deleted: true,
          members: { create: { userId: creator.id, role: "OWNER" } },
        },
      });

      const ticket = await prisma.ticket.create({
        data: {
          title: "待回复工单",
          projectId: project.id,
          createdBy: creator.id,
          status: "OPEN",
          priority: "MEDIUM",
        },
      });
      const deletedProjectTicket = await prisma.ticket.create({
        data: {
          title: "删除项目工单",
          projectId: deletedProject.id,
          createdBy: creator.id,
          status: "OPEN",
          priority: "MEDIUM",
        },
      });
      const legacyTicket = await prisma.ticket.create({
        data: {
          title: "Legacy 工单",
          projectId: project.id,
          createdBy: null,
          status: "OPEN",
          priority: "MEDIUM",
        },
      });
      await prisma.activityLog.create({
        data: {
          type: "TICKET_CREATED",
          content: `创建了工单 "Legacy 工单"`,
          metadata: JSON.stringify({ ticketId: legacyTicket.id }),
          projectId: project.id,
          userId: creator.id,
        },
      });
      const repTicket = await prisma.ticket.create({
        data: {
          title: "代表创建工单",
          projectId: project.id,
          createdBy: repCreator.id,
          status: "OPEN",
          priority: "MEDIUM",
        },
      });

      // contribute gate
      await expect(
        replyToTicketForActor(outsiderActor, webInvocation, {
          ticketId: ticket.id,
          content: "越权回复",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // missing ticket
      await expect(
        replyToTicketForActor(replierActor, webInvocation, {
          ticketId: "missing-ticket-id",
          content: "不存在",
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      // deleted project
      await expect(
        replyToTicketForActor(creatorActor, webInvocation, {
          ticketId: deletedProjectTicket.id,
          content: "删除项目",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      // empty content
      await expect(
        replyToTicketForActor(replierActor, webInvocation, {
          ticketId: ticket.id,
          content: "   ",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      const legacyCreator = await resolveTicketCreatorUser({
        ticketId: legacyTicket.id,
        projectId: project.id,
        createdBy: null,
      });
      expect(legacyCreator?.id).toBe(creator.id);

      const { reply: webReply } = await replyToTicketForActor(replierActor, webInvocation, {
        ticketId: ticket.id,
        content: "Web 回复内容",
      });

      expect(webReply.content).toBe("Web 回复内容");
      expect(webReply.authorId).toBe(replier.id);
      expect(webReply.ticketId).toBe(ticket.id);
      expect(webReply.author.name).toBe("Replier");

      const webLog = await prisma.activityLog.findFirst({
        where: {
          projectId: project.id,
          type: "TICKET_UPDATED",
          userId: replier.id,
          content: { contains: "待回复工单" },
        },
        orderBy: { createdAt: "desc" },
      });
      expect(webLog).toBeTruthy();
      expect(JSON.parse(webLog!.metadata!).ticketId).toBe(ticket.id);

      const creatorNotification = await prisma.notification.findFirst({
        where: {
          userId: creator.id,
          type: "TICKET_REPLY",
          title: { contains: "待回复工单" },
        },
      });
      expect(creatorNotification).toBeTruthy();
      expect(creatorNotification?.emailStatus).toBe("pending");
      expect(creatorNotification?.link).toBe(`/projects/${project.id}`);

      // self-reply should not notify
      const notificationsBeforeSelfReply = await prisma.notification.count({
        where: { userId: creator.id, type: "TICKET_REPLY" },
      });
      await replyToTicketForActor(creatorActor, webInvocation, {
        ticketId: ticket.id,
        content: "创建者自己回复",
      });
      const notificationsAfterSelfReply = await prisma.notification.count({
        where: { userId: creator.id, type: "TICKET_REPLY" },
      });
      expect(notificationsAfterSelfReply).toBe(notificationsBeforeSelfReply);

      // representative creator excluded from notification
      await replyToTicketForActor(replierActor, webInvocation, {
        ticketId: repTicket.id,
        content: "回复代表工单",
      });
      const repNotification = await prisma.notification.findFirst({
        where: {
          userId: repCreator.id,
          type: "TICKET_REPLY",
          title: { contains: "代表创建工单" },
        },
      });
      expect(repNotification).toBeNull();

      // legacy createdBy fallback still notifies creator
      await replyToTicketForActor(replierActor, webInvocation, {
        ticketId: legacyTicket.id,
        content: "Legacy 回复",
      });
      const legacyNotification = await prisma.notification.findFirst({
        where: {
          userId: creator.id,
          type: "TICKET_REPLY",
          title: { contains: "Legacy 工单" },
        },
      });
      expect(legacyNotification).toBeTruthy();

      const noEmailCreator = await prisma.user.create({
        data: {
          email: "t44-noemail@example.com",
          name: "NoEmail",
          password: "h",
          role: "USER",
          emailOnTicketReply: false,
        },
      });
      await prisma.projectMember.create({
        data: { projectId: project.id, userId: noEmailCreator.id, role: "MEMBER" },
      });
      const noEmailTicket = await prisma.ticket.create({
        data: {
          title: "无邮件偏好工单",
          projectId: project.id,
          createdBy: noEmailCreator.id,
          status: "OPEN",
          priority: "MEDIUM",
        },
      });
      await replyToTicketForActor(replierActor, webInvocation, {
        ticketId: noEmailTicket.id,
        content: "不触发邮件",
      });
      const noEmailNotification = await prisma.notification.findFirst({
        where: {
          userId: noEmailCreator.id,
          type: "TICKET_REPLY",
          title: { contains: "无邮件偏好工单" },
        },
      });
      expect(noEmailNotification).toBeTruthy();
      expect(noEmailNotification?.emailStatus).toBeNull();

      const agentReplied = await executeAgentAction<{
        reply: { id: string; ticketId: string; content: string };
      }>(
        agentExecCtx(replierActor),
        "tickets.reply",
        {
          ticketId: ticket.id,
          content: "Agent 回复内容",
        },
        { allowConfirm: true },
      );

      expect(agentReplied.result.reply.content).toBe("Agent 回复内容");
      expect(agentReplied.result.reply.ticketId).toBe(ticket.id);

      const agentLog = await prisma.activityLog.findFirst({
        where: {
          projectId: project.id,
          type: "TICKET_UPDATED",
          userId: replier.id,
          content: { contains: "待回复工单" },
        },
        orderBy: { createdAt: "desc" },
      });
      expect(agentLog).toBeTruthy();

      // post-commit notification failure must not fail the already-committed reply
      const notifySpy = vi
        .spyOn(prisma.notification, "create")
        .mockRejectedValueOnce(new Error("notification down"));
      const repliesBefore = await prisma.ticketReply.count({
        where: { ticketId: ticket.id },
      });
      const resilient = await replyToTicketForActor(replierActor, webInvocation, {
        ticketId: ticket.id,
        content: "通知挂了也要成功",
      });
      expect(resilient.reply.content).toBe("通知挂了也要成功");
      const repliesAfter = await prisma.ticketReply.count({
        where: { ticketId: ticket.id },
      });
      expect(repliesAfter).toBe(repliesBefore + 1);
      notifySpy.mockRestore();

    });
  }, 120_000);
});
