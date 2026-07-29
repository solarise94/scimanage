import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent" },
});

/**
 * T5.1: actor-aware CRM search/context/name/application queries shared by
 * Agent read actions and matching Web GET surfaces.
 */
describe("T5.1 CRM query services", () => {
  it("enforces scope, name-resolve disclosure, and Agent parity", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { searchCustomersForActor, shapeCustomerSearchItem } = await import(
        "@/lib/crm/application/query-customers"
      );
      const { getCustomerContextForActor } = await import(
        "@/lib/crm/application/get-customer-context"
      );
      const {
        resolveCustomerNameForActor,
        searchCustomersByPinyinForActor,
      } = await import("@/lib/crm/application/resolve-customer-name");
      const { listMyOrganizationsForActor } = await import(
        "@/lib/crm/application/list-my-organizations"
      );
      const { listMyCustomerApplicationsForActor } = await import(
        "@/lib/crm/application/list-my-customer-applications"
      );
      const { ForbiddenError, NotFoundError } = await import("@/lib/application/errors");
      const { executeAgentAction } = await import("@/lib/agent-actions/registry");

      const admin = await prisma.user.create({
        data: { email: "t51-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const repAUser = await prisma.user.create({
        data: {
          email: "t51-repa@example.com",
          name: "RepA",
          password: "h",
          role: "REPRESENTATIVE",
        },
      });
      const repBUser = await prisma.user.create({
        data: {
          email: "t51-repb@example.com",
          name: "RepB",
          password: "h",
          role: "REPRESENTATIVE",
        },
      });
      const rmUser = await prisma.user.create({
        data: {
          email: "t51-rm@example.com",
          name: "RM",
          password: "h",
          role: "REGIONAL_MANAGER",
        },
      });

      const adminActor = { userId: admin.id, role: "ADMIN" };
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
      const repB = await prisma.representative.create({
        data: { name: "代表B", email: repBUser.email },
      });

      const rm = await prisma.crmRegionManager.create({
        data: {
          userId: rmUser.id,
          reps: { create: { representativeId: repA.id } },
        },
      });
      expect(rm.id).toBeTruthy();

      const org = await prisma.organization.create({
        data: {
          orgCode: "T51-ORG",
          canonicalName: "测试医院",
          normalizedName: "测试医院",
        },
      });

      await prisma.representativeOrganization.create({
        data: {
          representativeId: repA.id,
          organizationId: org.id,
          status: "ACTIVE",
          isPrimary: true,
        },
      });

      const profileA = await prisma.crmCustomerProfile.create({
        data: {
          name: "王晓明",
          namePinyin: "wangxiaoming",
          ownerUserId: repAUser.id,
          assignmentStatus: "ASSIGNED",
          organization: "测试医院",
        },
      });
      const profileB = await prisma.crmCustomerProfile.create({
        data: {
          name: "李秘密",
          ownerUserId: repBUser.id,
          assignmentStatus: "ASSIGNED",
        },
      });
      await prisma.crmCustomerProfile.create({
        data: {
          name: "已删除客户",
          ownerUserId: repAUser.id,
          assignmentStatus: "ASSIGNED",
          deleted: true,
        },
      });
      // 部门隔离 Phase 4：可见性以部门 CLAIMED state 为准；raw fixture 需回填 state
      // （ASSIGNED+owner → FIELD_SALES CLAIMED，可见范围与旧语义等价）。
      const { backfillDepartmentStates } = await import("../../../../../scripts/lib/department-states");
      await backfillDepartmentStates(prisma, { apply: true });

      await prisma.crmInteraction.create({
        data: {
          profileId: profileA.id,
          createdByUserId: repAUser.id,
          type: "CALL",
          summary: "电话沟通",
          happenedAt: new Date(),
        },
      });

      const appA = await prisma.crmCustomerApplication.create({
        data: {
          name: "新客户申请",
          submittedByUserId: repAUser.id,
          organizationId: org.id,
          status: "PENDING",
          supervisorReviewStatus: "NONE",
        },
      });

      // ADMIN search with name filter
      const adminSearch = await searchCustomersForActor(adminActor, { query: "王", limit: 20 });
      expect(adminSearch.items.map((i) => i.profileId)).toEqual([profileA.id]);

      // ADMIN unfiltered sees active profiles (not deleted)
      const adminAll = await searchCustomersForActor(adminActor, { limit: 50 });
      expect(adminAll.items.map((i) => i.profileId).sort()).toEqual(
        [profileA.id, profileB.id].sort(),
      );

      // REP A scoped search
      const repASearch = await searchCustomersForActor(repAActor, { query: "王晓", limit: 10 });
      expect(repASearch.items.map((i) => i.profileId)).toEqual([profileA.id]);

      // REP B cannot see A in search
      const repBSearch = await searchCustomersForActor(repBActor, { query: "王晓", limit: 10 });
      expect(repBSearch.items).toEqual([]);

      // RM sees rep A's customer
      const rmSearch = await searchCustomersForActor(rmActor, { query: "王晓", limit: 10 });
      expect(rmSearch.items.map((i) => i.profileId)).toEqual([profileA.id]);

      // Context in-scope
      const ctx = await getCustomerContextForActor(repAActor, profileA.id);
      expect(ctx.customerName).toBe("王晓明");
      expect(ctx.recentInteractions).toHaveLength(1);

      // Out-of-scope context → NotFound (no leak)
      await expect(getCustomerContextForActor(repBActor, profileA.id)).rejects.toBeInstanceOf(
        NotFoundError,
      );

      // Name resolve: homophone within scope
      const resolved = await resolveCustomerNameForActor(repAActor, {
        spokenName: "王小明",
        limit: 5,
      });
      expect(resolved.candidates.some((c) => c.profileId === profileA.id)).toBe(true);

      // Out-of-scope name must not disclose B's customer to A
      const leakTest = await resolveCustomerNameForActor(repAActor, {
        spokenName: "李秘密",
        limit: 5,
      });
      expect(leakTest.candidates.some((c) => c.profileId === profileB.id)).toBe(false);

      const pinyin = await searchCustomersByPinyinForActor(repAActor, {
        spokenName: "wangxiaoming",
        limit: 5,
      });
      expect(pinyin.candidates.map((c) => c.profileId)).toContain(profileA.id);

      // Organizations self-service
      const orgs = await listMyOrganizationsForActor(repAActor);
      expect(orgs.items).toHaveLength(1);
      expect(orgs.items[0]?.organizationName).toBe("测试医院");

      // Applications self-service (REP only gate)
      const apps = await listMyCustomerApplicationsForActor(repAActor, { limit: 20 });
      expect(apps.items.map((a) => a.id)).toEqual([appA.id]);
      await expect(listMyCustomerApplicationsForActor(rmActor)).rejects.toBeInstanceOf(
        ForbiddenError,
      );

      // Agent parity: search
      const directItems = await searchCustomersForActor(repAActor, { query: "王晓", limit: 10 });
      const agentSearch = await executeAgentAction<{ items: Array<{ profileId: string }> }>(
        agentExecCtx(repAActor),
        "crm.search_customers",
        { query: "王晓", limit: 10 },
      );
      expect(agentSearch.result.items.map((i) => i.profileId)).toEqual(
        directItems.items.map((i) => i.profileId),
      );
      expect(agentSearch.result.items[0]).toMatchObject(
        shapeCustomerSearchItem({
          id: profileA.id,
          name: profileA.name,
          stage: profileA.stage,
          importance: profileA.importance,
          lastFollowUpAt: profileA.lastFollowUpAt,
          organization: profileA.organization,
          ownerUser: { name: repAUser.name },
          _count: { followUpTasks: 0, interactions: 1 },
        }),
      );

      // Agent parity: context out-of-scope
      await expect(
        executeAgentAction(agentExecCtx(repBActor), "crm.get_customer_context", { profileId: profileA.id }),
      ).rejects.toMatchObject({ status: 404 });

      const agentCtx = await executeAgentAction<{ profileId: string; customerName: string }>(
        agentExecCtx(repAActor),
        "crm.get_customer_context",
        { profileId: profileA.id },
      );
      expect(agentCtx.result.profileId).toBe(ctx.profileId);
      expect(agentCtx.result.customerName).toBe(ctx.customerName);
    });
  }, 120_000);
});
