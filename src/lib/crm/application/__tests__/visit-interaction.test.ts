import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent" },
});

/**
 * T5.3: visit/interaction actor-aware facades shared by Agent and Web routes.
 */
describe("T5.3 visit/interaction facades", () => {
  it("enforces gates, formal writes, prepare is read-only, and Agent/Web parity", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { prepareVisitCheckinForActor } = await import(
        "@/lib/crm/application/prepare-visit-checkin"
      );
      const { createVisitCheckinForActor, completeVisitCheckinForActor } = await import(
        "@/lib/crm/application/create-visit-checkin"
      );
      const { createInteractionForActor } = await import(
        "@/lib/crm/application/create-interaction"
      );
      const {
        ForbiddenError,
        NotFoundError,
        ValidationError,
      } = await import("@/lib/application/errors");
      const { buildInvocationContext } = await import("@/lib/application/actor");
      const { executeAgentAction } = await import("@/lib/agent-actions/registry");

      const admin = await prisma.user.create({
        data: { email: "t53-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const repAUser = await prisma.user.create({
        data: {
          email: "t53-repa@example.com",
          name: "RepA",
          password: "h",
          role: "REPRESENTATIVE",
        },
      });
      const repBUser = await prisma.user.create({
        data: {
          email: "t53-repb@example.com",
          name: "RepB",
          password: "h",
          role: "REPRESENTATIVE",
        },
      });
      const rmUser = await prisma.user.create({
        data: {
          email: "t53-rm@example.com",
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
          name: "签到客户A",
          ownerUserId: repAUser.id,
          assignmentStatus: "ASSIGNED",
          stage: "LEAD",
        },
      });
      const profileB = await prisma.crmCustomerProfile.create({
        data: {
          name: "签到客户B",
          ownerUserId: repBUser.id,
          assignmentStatus: "ASSIGNED",
          stage: "LEAD",
        },
      });

      const webInvocation = buildInvocationContext({ channel: "web" });
      const agentInvocation = buildInvocationContext({ channel: "agent" });
      const happenedAt = "2026-08-15T10:00:00.000Z";
      const checkinBefore = await prisma.crmVisitCheckin.count();
      const interactionBefore = await prisma.crmInteraction.count();

      // P0-4：prepare 在 Agent channel 持久化一条 DRAFT CrmVisitCheckin intent（checkinId 锚点），
      // 供后续 create_visit_checkin 一次性消费；不创建 interaction、不完成签到（非业务终态）。
      // Web channel 仍保持不落任何行（Web 走自己的多步上传/完成路径）。
      const prepared = await prepareVisitCheckinForActor(repAActor, agentInvocation, profileA.id);
      expect(prepared.profileId).toBe(profileA.id);
      expect(prepared.customerName).toBe("签到客户A");
      expect(prepared.checkinReady).toBe("true");
      expect(prepared.checkinId).toBeTruthy();
      // Agent prepare 落一条 DRAFT（intent），COMPLETED 数仍为 0；无 interaction。
      expect(await prisma.crmVisitCheckin.count()).toBe(checkinBefore + 1);
      const draftRow = await prisma.crmVisitCheckin.findUnique({ where: { id: prepared.checkinId! } });
      expect(draftRow?.status).toBe("DRAFT");
      expect(draftRow?.completedAt).toBeNull();
      expect(await prisma.crmInteraction.count()).toBe(interactionBefore);

      // Web channel prepare 不落任何行（既定行为）。
      const webPrepared = await prepareVisitCheckinForActor(repAActor, webInvocation, profileA.id);
      expect(webPrepared.checkinId).toBeNull();
      expect(await prisma.crmVisitCheckin.count()).toBe(checkinBefore + 1); // 仍是 Agent 那一条

      // scope: rep B cannot prepare rep A profile
      await expect(
        prepareVisitCheckinForActor(repBActor, agentInvocation, profileA.id),
      ).rejects.toBeInstanceOf(NotFoundError);

      // agent channel rejects RM self-service write path on prepare
      await expect(
        prepareVisitCheckinForActor(rmActor, agentInvocation, profileA.id),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // interaction validation
      await expect(
        createInteractionForActor(repAActor, webInvocation, {
          profileId: profileA.id,
          type: "INVALID",
          summary: "test",
          happenedAt,
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      // scope: rep B cannot write interaction on rep A profile
      await expect(
        createInteractionForActor(repBActor, webInvocation, {
          profileId: profileA.id,
          type: "CALL",
          summary: "越权沟通",
          happenedAt,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // Web interaction write
      const webInteraction = await createInteractionForActor(repAActor, webInvocation, {
        profileId: profileA.id,
        type: "CALL",
        summary: "Web 电话沟通",
        happenedAt,
      });
      expect(webInteraction.interaction.summary).toBe("Web 电话沟通");
      expect(webInteraction.interaction.createdByUserId).toBe(repAUser.id);

      // Agent interaction parity
      const agentInteraction = await executeAgentAction<{
        interaction: {
          id: string;
          profileId: string;
          type: string;
          summary: string;
          happenedAt: string;
        };
      }>(
        agentExecCtx(adminActor),
        "crm.create_interaction",
        {
          profileId: profileB.id,
          type: "WECHAT",
          summary: "Agent 微信沟通",
          happenedAt,
        },
        { allowConfirm: true },
      );
      expect(agentInteraction.result.interaction.summary).toBe("Agent 微信沟通");
      expect(agentInteraction.result.interaction.profileId).toBe(profileB.id);

      const agentInteractionDb = await prisma.crmInteraction.findUnique({
        where: { id: agentInteraction.result.interaction.id },
      });
      expect(agentInteractionDb?.createdByUserId).toBe(admin.id);

      // visit checkin one-step write (Web)
      const webCheckin = await createVisitCheckinForActor(repAActor, webInvocation, {
        profileId: profileA.id,
        lat: 31.2304,
        lng: 121.4737,
        accuracy: 12,
      });
      expect(webCheckin.checkin.status).toBe("COMPLETED");
      expect(webCheckin.interaction?.type).toBe("VISIT");

      // scope: rep B cannot check in on rep A profile
      await expect(
        createVisitCheckinForActor(repBActor, webInvocation, {
          profileId: profileA.id,
          lat: 31.23,
          lng: 121.47,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // Agent visit checkin parity (complete existing draft path)
      const draft = await prisma.crmVisitCheckin.create({
        data: {
          profileId: profileB.id,
          userId: admin.id,
          lat: 31.22,
          lng: 121.48,
          status: "DRAFT",
        },
      });

      const agentCheckin = await executeAgentAction<{
        checkin: { id: string; status: string; addressSnapshot: string; completedAt: string };
        interaction: { id: string; type: string };
      }>(
        agentExecCtx(adminActor),
        "crm.create_visit_checkin",
        {
          profileId: profileB.id,
          lat: 31.22,
          lng: 121.48,
          capturedAt: new Date().toISOString(),
          checkinId: draft.id,
        },
        { allowConfirm: true },
      );
      expect(agentCheckin.result.checkin.status).toBe("COMPLETED");
      expect(agentCheckin.result.interaction.type).toBe("VISIT");

      // Web complete path via facade (voice-less geo evidence on draft)
      const draftForWeb = await prisma.crmVisitCheckin.create({
        data: {
          profileId: profileB.id,
          userId: repBUser.id,
          lat: 31.21,
          lng: 121.49,
          status: "DRAFT",
        },
      });
      const webComplete = await completeVisitCheckinForActor(repBActor, webInvocation, {
        profileId: profileB.id,
        checkinId: draftForWeb.id,
      });
      expect(webComplete.checkin.status).toBe("COMPLETED");

      // agent channel rejects RM on formal write
      await expect(
        createInteractionForActor(rmActor, agentInvocation, {
          profileId: profileA.id,
          type: "NOTE",
          summary: "RM agent 写",
          happenedAt,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // missing profile
      await expect(
        createVisitCheckinForActor(adminActor, webInvocation, {
          profileId: "missing-profile",
          lat: 1,
          lng: 2,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
