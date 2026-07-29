import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

/**
 * 部门隔离复审残留项：finance/project scope fail-closed、create-project DB 部门、
 * 治理桶 create/resolve 部门校验、Portal guard ApplicationError。
 *
 * 共用一次 withTempSmokeDb（Prisma 单例在同进程内不能跨多次 temp db 重建）。
 */
describe("department isolation P1 residual fixes", () => {
  it("enforces fail-closed scope, live write department, governance dept, portal 403", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { getFinanceProjectScopeWhere, getFinanceProfileScopeWhere } = await import(
        "@/lib/finance/permissions"
      );
      const { getReadableProjectIds, canReadProject } = await import("@/lib/permissions");
      const { requireBusinessActorFromSession } = await import("@/lib/agent-actions/actor");
      const { AgentActionError } = await import("@/lib/agent-actions/errors");
      const { createProjectForActor } = await import(
        "@/lib/projects/application/create-project"
      );
      const {
        createGovernanceAssignmentForActor,
        resolveGovernanceAssignmentForActor,
        ensureGeneralOtherProject,
      } = await import("@/lib/projects/application/governance-bucket");
      const { NotFoundError, ValidationError, PortalAccessDeniedError } = await import(
        "@/lib/application/errors"
      );
      const { GOVERNANCE_REASON_CODE } = await import("@/lib/products/constants");
      const { assertPortalAccess, canActorAccessPortal } = await import("@/lib/portal/guard");
      const { getServerPortalConfig } = await import("@/lib/portal/config");

      // ── 1. scope fail-closed ──
      const onlineOps = await prisma.user.create({
        data: {
          email: "ops-scope@example.com",
          name: "Ops",
          password: "h",
          role: "USER",
          department: "ONLINE_OPS",
        },
      });
      const fieldProject = await prisma.project.create({
        data: {
          name: "Field project",
          departmentSnapshot: "FIELD_SALES",
          members: { create: { userId: onlineOps.id, role: "OWNER" } },
        },
      });
      const opsProject = await prisma.project.create({
        data: {
          name: "Ops project",
          departmentSnapshot: "ONLINE_OPS",
          members: { create: { userId: onlineOps.id, role: "OWNER" } },
        },
      });

      const financeScope = await getFinanceProjectScopeWhere(onlineOps.id, "USER");
      expect(financeScope).not.toBeNull();
      expect(financeScope!.id.in).toContain(opsProject.id);
      expect(financeScope!.id.in).not.toContain(fieldProject.id);

      // profile scope：跨部门项目 membership 不得泄露对方 profileId
      const fieldProfile = await prisma.crmCustomerProfile.create({
        data: {
          name: "Field CRM",
          assignmentStatus: "ASSIGNED",
          ownerUserId: onlineOps.id,
        },
      });
      await prisma.project.update({
        where: { id: fieldProject.id },
        data: { profileId: fieldProfile.id },
      });
      const opsProfile = await prisma.crmCustomerProfile.create({
        data: {
          name: "Ops CRM",
          assignmentStatus: "ASSIGNED",
          ownerUserId: onlineOps.id,
        },
      });
      await prisma.project.update({
        where: { id: opsProject.id },
        data: { profileId: opsProfile.id },
      });
      // 另建一个 ONLINE_OPS 用户：仅经 FIELD_SALES 成员关系可见 fieldProfile，不应进入 scope
      const opsViaMembershipOnly = await prisma.user.create({
        data: {
          email: "ops-memb-only@example.com",
          name: "OpsMemb",
          password: "h",
          role: "USER",
          department: "ONLINE_OPS",
        },
      });
      await prisma.projectMember.create({
        data: { projectId: fieldProject.id, userId: opsViaMembershipOnly.id, role: "MEMBER" },
      });
      await prisma.projectMember.create({
        data: { projectId: opsProject.id, userId: opsViaMembershipOnly.id, role: "MEMBER" },
      });
      const profileScope = await getFinanceProfileScopeWhere(opsViaMembershipOnly.id, "USER");
      expect(profileScope).not.toBeNull();
      expect(profileScope!.id.in).toContain(opsProfile.id);
      expect(profileScope!.id.in).not.toContain(fieldProfile.id);

      const readable = await getReadableProjectIds(onlineOps.id, "USER");
      expect(readable).toContain(opsProject.id);
      expect(readable).not.toContain(fieldProject.id);
      expect(await canReadProject(fieldProject.id, onlineOps.id, "USER")).toBe(false);
      expect(await canReadProject(opsProject.id, onlineOps.id, "USER")).toBe(true);

      // finance summary：共享 profile 不得聚合跨部门订单金额
      const { getFinanceSummary } = await import("@/lib/finance/calculations");
      const { canManageTicket } = await import("@/lib/permissions");
      await prisma.order.create({
        data: {
          orderNo: `FS-FIELD-${Date.now()}`,
          title: "Field order via shared profile",
          source: "MANUAL",
          category: "SERVICE",
          status: "CONFIRMED",
          createdById: onlineOps.id,
          profileId: fieldProfile.id,
          departmentSnapshot: "FIELD_SALES",
          totalAmount: 100_000,
        },
      });
      await prisma.order.create({
        data: {
          orderNo: `FS-OPS-${Date.now()}`,
          title: "Ops order via shared profile",
          source: "MANUAL",
          category: "SERVICE",
          status: "CONFIRMED",
          createdById: onlineOps.id,
          profileId: fieldProfile.id,
          departmentSnapshot: "ONLINE_OPS",
          totalAmount: 50_000,
        },
      });
      const sharedProfileScope = { id: { in: [fieldProfile.id] } };
      const summaryOps = await getFinanceSummary(
        sharedProfileScope,
        null,
        false,
        new Date(),
        "ONLINE_OPS",
      );
      expect(summaryOps.matchedOnlineOrderAmount).toBe(500);
      expect(summaryOps.unmatchedOrderAmount).toBe(0);

      // ticket：跨部门 ProjectMember 不可 manage
      expect(await canManageTicket(fieldProject.id, onlineOps.id, "USER")).toBe(false);
      expect(await canManageTicket(opsProject.id, onlineOps.id, "USER")).toBe(true);

      // ── 2. create-project 事务内读 DB 部门 ──
      const creator = await prisma.user.create({
        data: {
          email: "create-dept@example.com",
          name: "Creator",
          password: "h",
          role: "USER",
          department: "ONLINE_OPS",
        },
      });
      const { project: created } = await createProjectForActor(
        { userId: creator.id, role: "USER", department: "FIELD_SALES", name: "Creator" },
        { channel: "web" },
        { name: "应归属网络运营" },
      );
      expect(created.departmentSnapshot).toBe("ONLINE_OPS");

      // ── 3. 治理桶 create/resolve ──
      const admin = await prisma.user.create({
        data: {
          email: "gov-admin@example.com",
          name: "Admin",
          password: "h",
          role: "ADMIN",
          department: "FIELD_SALES",
        },
      });
      const opsUser = await prisma.user.create({
        data: {
          email: "gov-ops@example.com",
          name: "OpsUser",
          password: "h",
          role: "USER",
          department: "ONLINE_OPS",
        },
      });
      const fieldUser = await prisma.user.create({
        data: {
          email: "gov-field@example.com",
          name: "FieldUser",
          password: "h",
          role: "USER",
          department: "FIELD_SALES",
        },
      });

      const adminActor = { userId: admin.id, role: "ADMIN", department: "FIELD_SALES" };
      const opsActor = { userId: opsUser.id, role: "USER", department: "ONLINE_OPS" };

      await ensureGeneralOtherProject(adminActor);

      const fieldOrder = await prisma.order.create({
        data: {
          orderNo: `GOV-FIELD-${Date.now()}`,
          title: "Field order",
          source: "MANUAL",
          category: "SERVICE",
          status: "CONFIRMED",
          createdById: fieldUser.id,
          departmentSnapshot: "FIELD_SALES",
        },
      });
      const fieldResolveTarget = await prisma.project.create({
        data: {
          name: "Field resolve target",
          departmentSnapshot: "FIELD_SALES",
          members: { create: { userId: fieldUser.id, role: "OWNER" } },
        },
      });
      const opsResolveTarget = await prisma.project.create({
        data: {
          name: "Ops resolve target",
          departmentSnapshot: "ONLINE_OPS",
          members: { create: { userId: opsUser.id, role: "OWNER" } },
        },
      });

      await expect(
        createGovernanceAssignmentForActor(opsActor, {
          orderId: fieldOrder.id,
          reasonCode: GOVERNANCE_REASON_CODE.UNRESOLVED_PROJECT,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      const assignment = await createGovernanceAssignmentForActor(
        { userId: fieldUser.id, role: "USER", department: "FIELD_SALES" },
        {
          orderId: fieldOrder.id,
          reasonCode: GOVERNANCE_REASON_CODE.UNRESOLVED_PROJECT,
        },
      );
      expect(assignment.departmentId).toBe("FIELD_SALES");

      await expect(
        resolveGovernanceAssignmentForActor(opsActor, assignment.id, fieldResolveTarget.id),
      ).rejects.toBeInstanceOf(NotFoundError);

      const resolved = await resolveGovernanceAssignmentForActor(
        { userId: fieldUser.id, role: "USER", department: "FIELD_SALES" },
        assignment.id,
        fieldResolveTarget.id,
      );
      expect(resolved.status).toBe("RESOLVED");
      expect(resolved.resolvedProjectId).toBe(fieldResolveTarget.id);

      const assignment2 = await createGovernanceAssignmentForActor(
        { userId: fieldUser.id, role: "USER", department: "FIELD_SALES" },
        {
          orderId: fieldOrder.id,
          reasonCode: GOVERNANCE_REASON_CODE.MISSING_PROJECT_NO,
        },
      );
      await expect(
        resolveGovernanceAssignmentForActor(
          { userId: fieldUser.id, role: "USER", department: "FIELD_SALES" },
          assignment2.id,
          opsResolveTarget.id,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);

      const fieldOrder2 = await prisma.order.create({
        data: {
          orderNo: `GOV-FIELD2-${Date.now()}`,
          title: "Field order 2",
          source: "MANUAL",
          category: "SERVICE",
          status: "CONFIRMED",
          createdById: fieldUser.id,
          departmentSnapshot: "FIELD_SALES",
        },
      });
      const assignment3 = await createGovernanceAssignmentForActor(adminActor, {
        orderId: fieldOrder2.id,
        reasonCode: GOVERNANCE_REASON_CODE.LEGACY_MISC,
      });
      await expect(
        resolveGovernanceAssignmentForActor(adminActor, assignment3.id, opsResolveTarget.id),
      ).rejects.toBeInstanceOf(ValidationError);

      // resolve 在创建后权限被撤销 → 不可凭 ID 解决
      const fieldOrderRevoke = await prisma.order.create({
        data: {
          orderNo: `GOV-REVOKE-${Date.now()}`,
          title: "Field order revoke",
          source: "MANUAL",
          category: "SERVICE",
          status: "CONFIRMED",
          createdById: fieldUser.id,
          departmentSnapshot: "FIELD_SALES",
        },
      });
      const assignmentRevoke = await createGovernanceAssignmentForActor(
        { userId: fieldUser.id, role: "USER", department: "FIELD_SALES" },
        {
          orderId: fieldOrderRevoke.id,
          reasonCode: GOVERNANCE_REASON_CODE.LEGACY_MISC,
        },
      );
      // 撤销：改 createdBy 并确保无其他 scope 入口
      await prisma.order.update({
        where: { id: fieldOrderRevoke.id },
        data: { createdById: admin.id },
      });
      await expect(
        resolveGovernanceAssignmentForActor(
          { userId: fieldUser.id, role: "USER", department: "FIELD_SALES" },
          assignmentRevoke.id,
          fieldResolveTarget.id,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);

      // ── 4. Portal guard → PortalAccessDeniedError ──
      const config = getServerPortalConfig();
      const otherDept = config.code === "FIELD_SALES" ? "ONLINE_OPS" : "FIELD_SALES";
      expect(() =>
        assertPortalAccess({
          user: { id: "u1", role: "USER", department: otherDept },
        }),
      ).toThrow(PortalAccessDeniedError);
      try {
        assertPortalAccess({
          user: { id: "u1", role: "USER", department: otherDept },
        });
      } catch (err) {
        expect(err).toBeInstanceOf(PortalAccessDeniedError);
        expect((err as InstanceType<typeof PortalAccessDeniedError>).httpStatus).toBe(403);
        expect((err as InstanceType<typeof PortalAccessDeniedError>).code).toBe(
          "PORTAL_ACCESS_DENIED",
        );
      }
      expect(canActorAccessPortal({ role: "USER", department: config.code })).toBe(true);
      expect(canActorAccessPortal({ role: "ADMIN", department: otherDept })).toBe(true);

      // Agent 入口：门户拒绝 → 403 PORTAL_ACCESS_DENIED，而非普通 Error/500
      expect(() =>
        requireBusinessActorFromSession({
          expires: "2099-01-01",
          user: { id: "u1", role: "USER", department: otherDept },
        } as never),
      ).toThrow(AgentActionError);
      try {
        requireBusinessActorFromSession({
          expires: "2099-01-01",
          user: { id: "u1", role: "USER", department: otherDept },
        } as never);
      } catch (err) {
        expect(err).toBeInstanceOf(AgentActionError);
        expect((err as InstanceType<typeof AgentActionError>).status).toBe(403);
        expect((err as InstanceType<typeof AgentActionError>).code).toBe("PORTAL_ACCESS_DENIED");
      }
    });
  });
});
