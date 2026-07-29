import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent" },
});

describe("T3.2 createProjectForActor", () => {
  it("creates with CRM context, OWNER member, activity log, budget source; blocks REP", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { createProjectForActor } = await import(
        "@/lib/projects/application/create-project"
      );
      const { ForbiddenError, ValidationError, ConflictError } = await import(
        "@/lib/application/errors"
      );
      const { buildInvocationContext } = await import("@/lib/application/actor");
      const { executeAgentAction } = await import("@/lib/agent-actions/registry");
      const { yuanToCents } = await import("@/lib/finance/money");

      const admin = await prisma.user.create({
        data: { email: "t32-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const user = await prisma.user.create({
        data: { email: "t32-user@example.com", name: "内部员工", password: "h", role: "USER" },
      });
      const repUser = await prisma.user.create({
        data: { email: "t32-rep@example.com", name: "Rep", password: "h", role: "REPRESENTATIVE" },
      });
      const org = await prisma.organization.create({
        data: {
          orgCode: "T32-ORG",
          canonicalName: "测试单位",
          normalizedName: "测试单位",
        },
      });
      const profile = await prisma.crmCustomerProfile.create({
        data: {
          name: "客户甲",
          ownerUserId: user.id,
          organizationId: org.id,
        },
      });

      const adminActor = { userId: admin.id, role: "ADMIN", name: "Admin", email: admin.email };
      const userActor = {
        userId: user.id,
        role: "USER",
        name: "内部员工",
        email: user.email,
      };
      const repActor = {
        userId: repUser.id,
        role: "REPRESENTATIVE",
        name: "Rep",
        email: repUser.email,
      };
      const invocation = buildInvocationContext({ channel: "web" });

      await expect(
        createProjectForActor(repActor, invocation, { name: "禁止" }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      await expect(
        createProjectForActor(userActor, invocation, {
          name: "坏客户",
          profileId: "missing-profile",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      const { project } = await createProjectForActor(userActor, invocation, {
        name: "正式项目",
        profileId: profile.id,
        budgetAmount: 12.5,
        budgetCost: 3,
        description: "desc",
      });

      expect(project.profileId).toBe(profile.id);
      expect(project.client).toBe("客户甲");
      expect(project.organization).toBe("测试单位");
      expect(project.budgetAmount).toBe(yuanToCents(12.5));
      expect(project.budgetAmountSource).toBe("MANUAL");
      expect(project.budgetCost).toBe(yuanToCents(3));
      expect(project.techSupport).toBe("内部员工");
      expect(project.projectNo?.startsWith("PRJ-")).toBe(true);

      const member = await prisma.projectMember.findFirst({
        where: { projectId: project.id, userId: user.id },
      });
      expect(member?.role).toBe("OWNER");

      const log = await prisma.activityLog.findFirst({
        where: { projectId: project.id, type: "PROJECT_CREATED" },
      });
      expect(log).toBeTruthy();

      const cost = await prisma.financeCost.findFirst({
        where: { sourceKey: `project-budget-cost:${project.id}` },
      });
      expect(cost?.amount).toBe(yuanToCents(3));

      // Profile-bound project: payload organization/client must NEVER win over
      // the CRM authoritative snapshot (even when the profile has an org set).
      const { project: guarded } = await createProjectForActor(userActor, invocation, {
        name: "防覆盖项目",
        profileId: profile.id,
        organization: "恶意单位",
        client: "恶意客户",
      });
      expect(guarded.profileId).toBe(profile.id);
      expect(guarded.organization).toBe("测试单位");
      expect(guarded.client).toBe("客户甲");

      // A profile archived between request and commit must be rejected in-tx.
      await prisma.crmCustomerProfile.update({
        where: { id: profile.id },
        data: { archived: true },
      });
      await expect(
        createProjectForActor(userActor, invocation, {
          name: "归档客户项目",
          profileId: profile.id,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await prisma.crmCustomerProfile.update({
        where: { id: profile.id },
        data: { archived: false },
      });

      // No-profileId path: payload snapshots + representative lookup still apply.
      const rep = await prisma.representative.create({
        data: { name: "代表张三", email: "t32-rep-zhang@example.com" },
      });
      const { project: freeform } = await createProjectForActor(userActor, invocation, {
        name: "无客户项目",
        organization: "手工单位",
        client: "手工客户",
        representativeId: rep.id,
      });
      expect(freeform.profileId).toBeNull();
      expect(freeform.organization).toBe("手工单位");
      expect(freeform.client).toBe("手工客户");
      expect(freeform.representativeId).toBe(rep.id);
      expect(freeform.representative).toBe("代表张三");

      // Manual duplicate projectNo → Conflict
      await expect(
        createProjectForActor(adminActor, invocation, {
          name: "重复号",
          projectNo: project.projectNo,
        }),
      ).rejects.toBeInstanceOf(ConflictError);

      // Agent confirm path uses same command
      const agentCreated = await executeAgentAction<{
        project: { id: string; name: string };
      }>(agentExecCtx(adminActor), "projects.create", { name: "Agent 项目", profileId: profile.id }, {
        allowConfirm: true,
      });
      expect(agentCreated.result.project.name).toBe("Agent 项目");
      const agentRow = await prisma.project.findUnique({
        where: { id: agentCreated.result.project.id },
      });
      expect(agentRow?.profileId).toBe(profile.id);
      expect(agentRow?.budgetAmountSource).toBeNull();
      const agentMember = await prisma.projectMember.findFirst({
        where: { projectId: agentCreated.result.project.id, userId: admin.id },
      });
      expect(agentMember?.role).toBe("OWNER");
    });
  }, 120_000);
});
