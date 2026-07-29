// secret-scan:allow — 本测试需要字面量密码串（bcrypt hash 测试 fixture）；均为测试 fixture，非真实凭据。
/**
 * Phase E tests: technical-owner governance + channel/transaction gates.
 *
 * 覆盖（§2.1 / 修正 5）：owner 匹配/不匹配/null；RM 拒；非 owner ADMIN 拒；
 * cross-resource；TOCTOU；治理回填（Project auto/amb/empty/non-staff；Order 全 PENDING）；
 * 手工指派（Project MEMBER 非 OWNER）。
 *
 * 全部场景共享单个 withTempSmokeDb 临时库（与 parity 惯例一致）。
 * ⚠️ 顶层 type-only import。
 */
import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";

const agentInv = (): InvocationContext => ({ channel: "agent" });
const webInv = (): InvocationContext => ({ channel: "web" });

describe("Phase E — technical-owner gates + governance", () => {
  it("owner match/mismatch/null, RM block, non-owner ADMIN, cross-resource, TOCTOU, governance backfill, manual assign", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { hashSync } = await import("bcryptjs");
      const { assertAgentCanWriteOrder, assertAgentCanWriteOrders } = await import(
        "@/lib/orders/application/technical-owner-gate"
      );
      const {
        backfillProjectGovernanceTasks,
        backfillOrderGovernanceTasks,
        assignTechnicalOwnerManual,
      } = await import("@/lib/orders/application/technical-owner-governance");

      const mkUser = async (email: string, name: string, role: string) =>
        prisma.user.create({ data: { email, name, password: hashSync("x", 4), role } });

      // ── 1. owner match / mismatch / null ──
      const owner = await mkUser("owner@t.test", "Owner", "USER");
      const other = await mkUser("other@t.test", "Other", "USER");
      const ownedOrder = await prisma.order.create({
        data: { orderNo: "ORD-OWNED", title: "owned", totalAmount: 1000, status: "CONFIRMED", createdById: owner.id, technicalOwnerUserId: owner.id },
      });
      const nullOrder = await prisma.order.create({
        data: { orderNo: "ORD-NULL", title: "null", totalAmount: 1000, status: "CONFIRMED", createdById: owner.id, technicalOwnerUserId: null },
      });
      const ownerActor: BusinessActor = { userId: owner.id, role: "USER" };
      const otherActor: BusinessActor = { userId: other.id, role: "USER" };

      await expect(assertAgentCanWriteOrder(ownerActor, agentInv(), ownedOrder.id)).resolves.toBeUndefined();
      await expect(assertAgentCanWriteOrder(otherActor, agentInv(), ownedOrder.id)).rejects.toThrow(/不是.*技术负责人/);
      await expect(assertAgentCanWriteOrder(ownerActor, agentInv(), nullOrder.id)).rejects.toThrow(/无技术负责人.*UI 治理/);
      // web channel 不校验
      await expect(assertAgentCanWriteOrder(otherActor, webInv(), ownedOrder.id)).resolves.toBeUndefined();

      // ── 2. RM block even if userId === technicalOwnerUserId ──
      const rm = await mkUser("rm@t.test", "RM", "REGIONAL_MANAGER");
      const rmOrder = await prisma.order.create({
        data: { orderNo: "ORD-RM", title: "rm", totalAmount: 1, status: "CONFIRMED", createdById: rm.id, technicalOwnerUserId: rm.id },
      });
      await expect(
        assertAgentCanWriteOrder({ userId: rm.id, role: "REGIONAL_MANAGER" }, agentInv(), rmOrder.id),
      ).rejects.toThrow(/REGIONAL_MANAGER 不可经 Agent 写/);

      // ── 3. non-owner ADMIN blocked ──
      const ownerAdmin = await mkUser("admin-owner@t.test", "AOwner", "ADMIN");
      const nonOwnerAdmin = await mkUser("admin-other@t.test", "AOther", "ADMIN");
      const adminOrder = await prisma.order.create({
        data: { orderNo: "ORD-ADM", title: "adm", totalAmount: 1, status: "CONFIRMED", createdById: ownerAdmin.id, technicalOwnerUserId: ownerAdmin.id },
      });
      await expect(
        assertAgentCanWriteOrder({ userId: ownerAdmin.id, role: "ADMIN" }, agentInv(), adminOrder.id),
      ).resolves.toBeUndefined();
      await expect(
        assertAgentCanWriteOrder({ userId: nonOwnerAdmin.id, role: "ADMIN" }, agentInv(), adminOrder.id),
      ).rejects.toThrow(/不是.*技术负责人/);

      // ── 4. cross-resource ──
      const orderA = await prisma.order.create({
        data: { orderNo: "O-A", title: "a", totalAmount: 1, status: "CONFIRMED", createdById: owner.id, technicalOwnerUserId: owner.id },
      });
      const orderB = await prisma.order.create({
        data: { orderNo: "O-B", title: "b", totalAmount: 1, status: "CONFIRMED", createdById: other.id, technicalOwnerUserId: other.id },
      });
      await expect(
        assertAgentCanWriteOrders(ownerActor, agentInv(), [orderA.id, orderB.id]),
      ).rejects.toThrow(/不是.*技术负责人/);
      await expect(
        assertAgentCanWriteOrders(ownerActor, agentInv(), [orderA.id]),
      ).resolves.toBeUndefined();

      // ── 5. TOCTOU ──
      const toctouOrder = await prisma.order.create({
        data: { orderNo: "O-TOCTOU", title: "t", totalAmount: 1, status: "CONFIRMED", createdById: owner.id, technicalOwnerUserId: owner.id },
      });
      await expect(
        assertAgentCanWriteOrder(ownerActor, agentInv(), toctouOrder.id),
      ).resolves.toBeUndefined();
      await prisma.order.update({ where: { id: toctouOrder.id }, data: { technicalOwnerUserId: other.id } });
      await expect(
        assertAgentCanWriteOrder(ownerActor, agentInv(), toctouOrder.id),
      ).rejects.toThrow(/不是.*技术负责人/);

      // ── 6. governance backfill (Project) ──
      const staff = await mkUser("staff@t.test", "张三", "USER");
      await mkUser("dup1@t.test", "李四", "USER");
      await mkUser("dup2@t.test", "李四", "ADMIN");
      await mkUser("rep-match@t.test", "王五", "REPRESENTATIVE");
      const pAuto = await prisma.project.create({ data: { name: "P-AUTO", techSupport: "张三" } });
      await prisma.project.create({ data: { name: "P-AMB", techSupport: "李四" } });
      await prisma.project.create({ data: { name: "P-EMPTY", techSupport: null } });
      await prisma.project.create({ data: { name: "P-REP", techSupport: "王五" } });

      const projResult = await backfillProjectGovernanceTasks();
      expect(projResult.autoResolved).toBe(1);
      expect(projResult.ambiguous).toBe(1);
      expect(projResult.empty).toBe(1);
      expect(projResult.noInternalMatch).toBe(1);

      const autoProj = await prisma.project.findUnique({ where: { id: pAuto.id } });
      expect(autoProj?.technicalOwnerUserId).toBe(staff.id);
      const ambProj = await prisma.project.findFirst({ where: { name: "P-AMB" } });
      expect(ambProj?.technicalOwnerUserId).toBeNull();

      // ── 7. Order governance: all PENDING ──
      const ordResult = await backfillOrderGovernanceTasks();
      expect(ordResult.autoResolved).toBe(0);
      expect(ordResult.pending).toBeGreaterThan(0);
      const ordTasks = await prisma.technicalOwnerGovernanceTask.findMany({ where: { resourceType: "ORDER" } });
      expect(ordTasks.every((t) => t.status === "PENDING")).toBe(true);

      // ── 8. manual assign (Project MEMBER not OWNER) ──
      const assignAdmin = await mkUser("assign-admin@t.test", "AssignAdmin", "ADMIN");
      const target = await mkUser("assign-target@t.test", "Target", "USER");

      // Order assignment also fills the order-owned display field.
      await assignTechnicalOwnerManual({
        actorUserId: assignAdmin.id,
        resourceType: "ORDER",
        resourceId: nullOrder.id,
        targetUserId: target.id,
      });
      const assignedOrder = await prisma.order.findUnique({ where: { id: nullOrder.id } });
      expect(assignedOrder?.technicalOwnerUserId).toBe(target.id);
      expect(assignedOrder?.techSupport).toBe("Target");

      const assignProj = await prisma.project.create({ data: { name: "P-ASSIGN" } });
      await assignTechnicalOwnerManual({
        actorUserId: assignAdmin.id,
        resourceType: "PROJECT",
        resourceId: assignProj.id,
        targetUserId: target.id,
      });
      const updated = await prisma.project.findUnique({ where: { id: assignProj.id } });
      expect(updated?.technicalOwnerUserId).toBe(target.id);
      const member = await prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId: assignProj.id, userId: target.id } },
      });
      expect(member?.role).toBe("MEMBER");
      const task = await prisma.technicalOwnerGovernanceTask.findUnique({
        where: { resourceType_resourceId: { resourceType: "PROJECT", resourceId: assignProj.id } },
      });
      expect(task?.status).toBe("RESOLVED_MANUAL");
    });
  });
});
