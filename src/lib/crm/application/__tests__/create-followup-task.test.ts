import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent" },
});

/**
 * T5.2: canonical create-followup-task command shared by POST /api/crm/follow-ups
 * and Agent crm.create_followup_task confirm path.
 */
describe("T5.2 createFollowUpTaskForActor", () => {
  it("enforces scope/ownership, lifecycle, notification, and Agent/Web parity", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { createFollowUpTaskForActor } = await import(
        "@/lib/crm/application/create-followup-task"
      );
      const {
        ForbiddenError,
        NotFoundError,
        ValidationError,
      } = await import("@/lib/application/errors");
      const { buildInvocationContext } = await import("@/lib/application/actor");
      const { executeAgentAction } = await import("@/lib/agent-actions/registry");

      const admin = await prisma.user.create({
        data: { email: "t52-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const repAUser = await prisma.user.create({
        data: {
          email: "t52-repa@example.com",
          name: "RepA",
          password: "h",
          role: "REPRESENTATIVE",
        },
      });
      const repBUser = await prisma.user.create({
        data: {
          email: "t52-repb@example.com",
          name: "RepB",
          password: "h",
          role: "REPRESENTATIVE",
        },
      });
      const rmUser = await prisma.user.create({
        data: {
          email: "t52-rm@example.com",
          name: "RM",
          password: "h",
          role: "REGIONAL_MANAGER",
        },
      });

      const adminActor = { userId: admin.id, role: "ADMIN", name: admin.name, email: admin.email };
      const repAActor = {
        userId: repAUser.id,
        role: "REPRESENTATIVE",
        email: repAUser.email,
        name: repAUser.name,
      };
      const repBActor = {
        userId: repBUser.id,
        role: "REPRESENTATIVE",
        email: repBUser.email,
        name: repBUser.name,
      };
      const rmActor = {
        userId: rmUser.id,
        role: "REGIONAL_MANAGER",
        email: rmUser.email,
        name: rmUser.name,
      };

      const repA = await prisma.representative.create({
        data: { name: "代表A", email: repAUser.email },
      });
      await prisma.representative.create({
        data: { name: "代表B", email: repBUser.email },
      });

      await prisma.crmRegionManager.create({
        data: {
          userId: rmUser.id,
          reps: { create: { representativeId: repA.id } },
        },
      });

      const profileA = await prisma.crmCustomerProfile.create({
        data: {
          name: "跟进客户A",
          ownerUserId: repAUser.id,
          assignmentStatus: "ASSIGNED",
          stage: "LEAD",
        },
      });
      const profileB = await prisma.crmCustomerProfile.create({
        data: {
          name: "跟进客户B",
          ownerUserId: repBUser.id,
          assignmentStatus: "ASSIGNED",
          stage: "LEAD",
        },
      });

      const webInvocation = buildInvocationContext({ channel: "web" });
      const agentInvocation = buildInvocationContext({ channel: "agent" });
      const dueAt = "2026-08-20T09:00:00.000Z";

      // validation
      await expect(
        createFollowUpTaskForActor(repAActor, webInvocation, {
          profileId: profileA.id,
          title: "",
          dueAt,
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      // scope: rep B cannot write on rep A profile
      await expect(
        createFollowUpTaskForActor(repBActor, webInvocation, {
          profileId: profileA.id,
          title: "越权跟进",
          dueAt,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // missing profile
      await expect(
        createFollowUpTaskForActor(adminActor, webInvocation, {
          profileId: "missing-profile",
          title: "不存在",
          dueAt,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      // representative always owns self even when ownerUserId is supplied
      const repSelf = await createFollowUpTaskForActor(repAActor, webInvocation, {
        profileId: profileA.id,
        title: "Rep 自建",
        dueAt,
        ownerUserId: repBUser.id,
        taskType: "CONTACT",
      });
      expect(repSelf.finalOwnerUserId).toBe(repAUser.id);
      expect(repSelf.task.taskType).toBe("CONTACT");
      expect(repSelf.notifications).toEqual([]);

      const profileAfterRep = await prisma.crmCustomerProfile.findUnique({
        where: { id: profileA.id },
        select: { nextFollowUpAt: true, stage: true },
      });
      expect(profileAfterRep?.nextFollowUpAt?.toISOString()).toBe(dueAt);

      // Seed a communication-source OPEN task with a LATER due date: the
      // lifecycle aggregate counts it (manual tasks have sourceType null and
      // are excluded), so the next FOLLOW_UP_CREATED transitions the stage
      // LEAD → FOLLOWING and writes stage history — artifacts that used to be
      // silently lost when the post-commit transition failed.
      await prisma.crmFollowUpTask.create({
        data: {
          profileId: profileA.id,
          ownerUserId: repAUser.id,
          title: "沟通任务",
          dueAt: new Date("2026-09-10T09:00:00.000Z"),
          taskType: "CONTACT",
          sourceType: "CRM_COMMUNICATION",
          createdByUserId: repAUser.id,
        },
      });

      const visitTask = await createFollowUpTaskForActor(repAActor, webInvocation, {
        profileId: profileA.id,
        title: "拜访计划",
        dueAt: "2026-08-22T09:00:00.000Z",
        taskType: "VISIT",
      });
      expect(visitTask.task.taskType).toBe("VISIT");

      // lifecycle committed atomically with the task: stage advanced and
      // FOLLOW_UP_CREATED history exists (lost before on transition failure).
      const profileAfterVisit = await prisma.crmCustomerProfile.findUnique({
        where: { id: profileA.id },
        select: { nextFollowUpAt: true, stage: true },
      });
      expect(profileAfterVisit?.stage).toBe("FOLLOWING");
      // nextFollowUpAt is the earliest OPEN across ALL tasks (the repSelf
      // 2026-08-20 CONTACT task), NOT the communication-only aggregate
      // (2026-09-10) — the final in-tx recompute supersedes the stage engine.
      expect(profileAfterVisit?.nextFollowUpAt?.toISOString()).toBe(dueAt);

      const followUpHistories = await prisma.crmCustomerStageHistory.findMany({
        where: { profileId: profileA.id, sourceType: "FOLLOW_UP_CREATED" },
      });
      expect(followUpHistories.length).toBeGreaterThanOrEqual(1);

      // RM assigns to managed rep → notification to rep A
      const rmAssign = await createFollowUpTaskForActor(rmActor, webInvocation, {
        profileId: profileA.id,
        title: "RM 指派",
        dueAt: "2026-08-25T09:00:00.000Z",
        ownerUserId: repAUser.id,
      });
      expect(rmAssign.finalOwnerUserId).toBe(repAUser.id);
      expect(rmAssign.notificationSent).toBe(true);
      expect(rmAssign.notifications[0]).toContain(repAUser.id);

      const notify = await prisma.notification.findFirst({
        where: { userId: repAUser.id, type: "CRM_FOLLOW_UP" },
        orderBy: { createdAt: "desc" },
      });
      expect(notify?.content).toContain("RM 指派");

      // RM cannot assign to unmanaged rep B
      await expect(
        createFollowUpTaskForActor(rmActor, webInvocation, {
          profileId: profileA.id,
          title: "RM 越权指派",
          dueAt,
          ownerUserId: repBUser.id,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // Web path (admin assigns to rep B on profile B)
      const webResult = await createFollowUpTaskForActor(adminActor, webInvocation, {
        profileId: profileB.id,
        title: "Web 跟进",
        dueAt: "2026-09-01T10:00:00.000Z",
        ownerUserId: repBUser.id,
        taskType: "OTHER",
      });
      expect(webResult.task.title).toBe("Web 跟进");
      expect(webResult.task.ownerUserId).toBe(repBUser.id);
      expect(webResult.task.taskType).toBe("OTHER");
      expect(webResult.notificationSent).toBe(true);

      // Agent parity on same profile
      const agentCreated = await executeAgentAction<{
        task: {
          id: string;
          profileId: string;
          customerName: string;
          ownerUserId: string;
          title: string;
          status: string;
          dueAt: string;
        };
        notifications: string[];
      }>(
        agentExecCtx(adminActor),
        "crm.create_followup_task",
        {
          profileId: profileB.id,
          title: "Agent 跟进",
          dueAt: "2026-09-02T10:00:00.000Z",
          ownerUserId: repBUser.id,
          taskType: "CONTACT",
        },
        { allowConfirm: true },
      );

      expect(agentCreated.result.task.title).toBe("Agent 跟进");
      expect(agentCreated.result.task.ownerUserId).toBe(repBUser.id);
      expect(agentCreated.result.task.customerName).toBe("跟进客户B");
      expect(agentCreated.result.notifications.some((n) => n.includes(repBUser.id))).toBe(true);

      const agentDb = await prisma.crmFollowUpTask.findUnique({
        where: { id: agentCreated.result.task.id },
      });
      expect(agentDb?.createdByUserId).toBe(admin.id);

      // agent channel rejects RM self-service write
      await expect(
        createFollowUpTaskForActor(rmActor, agentInvocation, {
          profileId: profileA.id,
          title: "RM agent 写",
          dueAt,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
