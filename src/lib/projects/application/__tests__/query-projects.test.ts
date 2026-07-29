import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent" },
});

/**
 * T3.1: actor-aware project list/search/summary shared by
 * GET /api/projects(+count) and Agent projects.search / get_summary.
 */
describe("T3.1 project query services", () => {
  it("enforces scope, search, pagination, summary disclosure and Agent parity", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const {
        queryProjects,
        searchProjectsForActor,
        countProjectsByStatusForActor,
        shapeProjectSearchItem,
      } = await import("@/lib/projects/application/query-projects");
      const { getProjectSummaryForActor } = await import(
        "@/lib/projects/application/get-project-summary"
      );
      const { NotFoundError } = await import("@/lib/application/errors");
      const { executeAgentAction } = await import("@/lib/agent-actions/registry");

      const admin = await prisma.user.create({
        data: { email: "t31-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const userA = await prisma.user.create({
        data: { email: "t31-usera@example.com", name: "UserA", password: "h", role: "USER" },
      });
      const userB = await prisma.user.create({
        data: { email: "t31-userb@example.com", name: "UserB", password: "h", role: "USER" },
      });
      const repUser = await prisma.user.create({
        data: { email: "t31-rep@example.com", name: "RepUser", password: "h", role: "REPRESENTATIVE" },
      });

      const adminActor = { userId: admin.id, role: "ADMIN" };
      const userAActor = { userId: userA.id, role: "USER" };
      const userBActor = { userId: userB.id, role: "USER" };
      const repActor = { userId: repUser.id, role: "REPRESENTATIVE" };

      const profile = await prisma.crmCustomerProfile.create({
        data: { ownerUserId: userA.id, name: "客户甲" },
      });
      const rep = await prisma.representative.create({
        data: { name: "代表一", email: repUser.email },
      });

      const pA = await prisma.project.create({
        data: {
          name: "Alpha 测序项目",
          status: "IN_PROGRESS",
          client: "客户甲",
          profileId: profile.id,
          representativeId: rep.id,
          representative: "代表一",
          members: { create: { userId: userA.id, role: "OWNER" } },
        },
      });
      const pB = await prisma.project.create({
        data: {
          name: "Beta 其他项目",
          status: "NOT_STARTED",
          members: { create: { userId: userB.id, role: "OWNER" } },
        },
      });
      await prisma.project.create({
        data: {
          name: "Deleted 项目",
          status: "COMPLETED",
          deleted: true,
          members: { create: { userId: userA.id, role: "OWNER" } },
        },
      });

      // USER A: only own project
      const listA = await queryProjects(userAActor, { page: 1, pageSize: 20 });
      expect(listA.projects.map((p) => p.id).sort()).toEqual([pA.id]);
      expect(listA.total).toBe(1);

      // USER B cannot see A
      const listB = await queryProjects(userBActor, { page: 1, pageSize: 20 });
      expect(listB.projects.map((p) => p.id)).toEqual([pB.id]);

      // ADMIN sees both non-deleted
      const listAdmin = await queryProjects(adminActor, {
        filters: { search: "测序" },
        page: 1,
        pageSize: 20,
      });
      expect(listAdmin.projects.map((p) => p.id)).toEqual([pA.id]);

      // Search by profile name (unified Web/Agent fields)
      const byClient = await searchProjectsForActor(adminActor, { query: "客户甲", limit: 10 });
      expect(byClient.map((p) => p.id)).toContain(pA.id);

      // Counts ignore status filter semantics when ignoreStatus path used
      const counts = await countProjectsByStatusForActor(userAActor, { status: "NOT_STARTED" });
      expect(counts.IN_PROGRESS).toBe(1);
      expect(counts._total).toBe(1);

      // Summary in-scope
      const summary = await getProjectSummaryForActor(userAActor, pA.id);
      expect(summary.project.id).toBe(pA.id);
      expect(summary.project.customerName).toBe("客户甲");

      // Out-of-scope → NotFound (no existence leak)
      await expect(getProjectSummaryForActor(userBActor, pA.id)).rejects.toBeInstanceOf(NotFoundError);

      // REPRESENTATIVE: linked via representativeId
      const repList = await searchProjectsForActor(repActor, { limit: 10 });
      expect(repList.map((p) => p.id)).toContain(pA.id);
      const repSummary = await getProjectSummaryForActor(repActor, pA.id);
      expect(repSummary.counts.tickets).toBe(0);
      expect(repSummary.recentTickets).toEqual([]);
      expect(repSummary.recentNotes).toEqual([]);

      // Agent parity
      const searchResult = await executeAgentAction<{ items: Array<{ id: string }> }>(
        agentExecCtx(adminActor),
        "projects.search",
        { query: "Alpha", limit: 10 },
      );
      expect(searchResult.result.items.map((i) => i.id)).toEqual(
        byClient.filter((p) => p.name.includes("Alpha")).map((p) => p.id),
      );
      expect(searchResult.result.items[0]).toMatchObject(shapeProjectSearchItem(byClient[0]));

      await expect(
        executeAgentAction(agentExecCtx(userBActor), "projects.get_summary", { projectId: pA.id }),
      ).rejects.toMatchObject({ status: 404 });

      const agentSummary = await executeAgentAction<{
        project: { id: string };
        counts: { members: number };
      }>(agentExecCtx(userAActor), "projects.get_summary", { projectId: pA.id });
      expect(agentSummary.result.project.id).toBe(summary.project.id);
      expect(agentSummary.result.counts.members).toBe(summary.counts.members);
    });
  }, 120_000);
});
