/**
 * Phase 4 部门 state 回填 + §12.3 一致性扫描测试。
 *
 * 全部在 withTempSmokeDb 临时 SQLite 中执行（schema 模板 + COW 克隆），
 * 严禁触碰 prisma/dev.db 或任何真实库。与 phase-d / parity 测试一致，
 * 共享单个 withTempSmokeDb（prisma 单例在多次 withTempSmokeDb 间会锁定旧实例）。
 *
 * 覆盖：
 *  1. dry-run 不写库；
 *  2. FIELD_SALES 各 assignmentStatus 分支映射（ASSIGNED/RECALL_CANDIDATE/RECALLED/UNASSIGNED/无 owner）；
 *  3. ONLINE_OPS 隐藏 POOL 且不创建 PoolShare；
 *  4. 已有 state 不被覆盖；
 *  5. 幂等性（二次 apply 创建 0、行不变）；
 *  6. 扫描脚本对人为构造的异常数据正确计数。
 */
import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";

describe("department-state backfill + consistency scan", () => {
  it("端到端：映射 / 幂等 / 不覆盖 / 扫描计数", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { backfillDepartmentStates, scanDepartmentConsistency } = await import(
        "../scripts/lib/department-states"
      );

      // ── 种子用户 ──
      const uFs1 = await prisma.user.create({
        data: { email: "fs1@t.test", name: "FS1", password: "x", role: "USER", department: "FIELD_SALES" },
      });
      const uFs2 = await prisma.user.create({
        data: { email: "fs2@t.test", name: "FS2", password: "x", role: "USER", department: "FIELD_SALES" },
      });
      const uOps = await prisma.user.create({
        data: { email: "ops@t.test", name: "OPS", password: "x", role: "USER", department: "ONLINE_OPS" },
      });
      const uAdmin = await prisma.user.create({
        data: { email: "admin@t.test", name: "ADM", password: "x", role: "ADMIN", department: "FIELD_SALES" },
      });

      const assignedAt = new Date("2026-01-01T00:00:00Z");
      const recalledAt = new Date("2026-02-01T00:00:00Z");

      // ── 种子 profile：覆盖全部 assignmentStatus 分支 ──
      const pAssigned = await prisma.crmCustomerProfile.create({
        data: {
          name: "已认领", ownerUserId: uFs1.id, assignmentStatus: "ASSIGNED",
          stage: "FOLLOWING", importance: "HIGH", assignedAt, assignedByUserId: uFs2.id,
        },
      });
      const pCandidate = await prisma.crmCustomerProfile.create({
        data: {
          name: "待收回", ownerUserId: uFs1.id, assignmentStatus: "RECALL_CANDIDATE",
          stage: "ACTIVE", importance: "NORMAL", assignedAt, assignedByUserId: uFs2.id,
        },
      });
      const pRecalled = await prisma.crmCustomerProfile.create({
        data: {
          name: "已回收", ownerUserId: uFs1.id, assignmentStatus: "RECALLED", recalledAt,
        },
      });
      const pUnassigned = await prisma.crmCustomerProfile.create({
        data: { name: "未分配", ownerUserId: null, assignmentStatus: "UNASSIGNED" },
      });
      const pNoOwnerAssigned = await prisma.crmCustomerProfile.create({
        data: { name: "无owner的ASSIGNED", ownerUserId: null, assignmentStatus: "ASSIGNED" },
      });
      // 已有 state 的 profile：回填不得覆盖
      const pExisting = await prisma.crmCustomerProfile.create({
        data: {
          name: "已有state", ownerUserId: uFs1.id, assignmentStatus: "ASSIGNED",
          stage: "LEAD", importance: "LOW",
        },
      });
      await prisma.crmProfileDepartmentState.create({
        data: {
          profileId: pExisting.id, department: "FIELD_SALES", claimStatus: "CLAIMED",
          ownerUserId: uFs1.id, stage: "CUSTOM_KEEP", importance: "KEY",
        },
      });
      await prisma.crmProfileDepartmentState.create({
        data: {
          profileId: pExisting.id, department: "ONLINE_OPS", claimStatus: "POOL",
          poolEntryReason: null,
        },
      });

      // ── 1. dry-run 不写库 ──
      const dry = await backfillDepartmentStates(prisma, { apply: false });
      expect(dry.profilesScanned).toBe(6);
      expect(dry.statesCreatedFieldSales).toBe(5);
      expect(dry.statesCreatedOnlineOps).toBe(5);
      expect(dry.statesSkippedExisting).toBe(2);
      expect(dry.anomalies).toEqual([]);
      expect(await prisma.crmProfileDepartmentState.count()).toBe(2);

      // ── 2. apply：分支映射 ──
      const applied = await backfillDepartmentStates(prisma, { apply: true });
      expect(applied.missingStateProfilesAfterApply).toBe(0);
      expect(applied.anomalies).toEqual([]);
      expect(await prisma.crmProfileDepartmentState.count()).toBe(12);

      const stateOf = (profileId: string, department: string) =>
        prisma.crmProfileDepartmentState.findUniqueOrThrow({
          where: { profileId_department: { profileId, department } },
        });

      const sAssigned = await stateOf(pAssigned.id, "FIELD_SALES");
      expect(sAssigned.claimStatus).toBe("CLAIMED");
      expect(sAssigned.ownerUserId).toBe(uFs1.id);
      expect(sAssigned.stage).toBe("FOLLOWING");
      expect(sAssigned.importance).toBe("HIGH");
      expect(sAssigned.claimedAt?.toISOString()).toBe(assignedAt.toISOString());
      expect(sAssigned.claimedById).toBe(uFs2.id);
      expect(sAssigned.poolEntryReason).toBeNull();

      const sCandidate = await stateOf(pCandidate.id, "FIELD_SALES");
      expect(sCandidate.claimStatus).toBe("RECALL_CANDIDATE");
      expect(sCandidate.ownerUserId).toBe(uFs1.id);
      expect(sCandidate.stage).toBe("ACTIVE");

      const sRecalled = await stateOf(pRecalled.id, "FIELD_SALES");
      expect(sRecalled.claimStatus).toBe("POOL");
      expect(sRecalled.ownerUserId).toBeNull();
      expect(sRecalled.poolEntryReason).toBe("RELEASED");
      expect(sRecalled.releasedAt?.toISOString()).toBe(recalledAt.toISOString());

      for (const p of [pUnassigned, pNoOwnerAssigned]) {
        const s = await stateOf(p.id, "FIELD_SALES");
        expect(s.claimStatus).toBe("POOL");
        expect(s.ownerUserId).toBeNull();
        expect(s.poolEntryReason).toBeNull();
      }

      // ── 3. ONLINE_OPS 全部隐藏 POOL，且不创建 PoolShare ──
      for (const p of [pAssigned, pCandidate, pRecalled, pUnassigned, pNoOwnerAssigned]) {
        const s = await stateOf(p.id, "ONLINE_OPS");
        expect(s.claimStatus).toBe("POOL");
        expect(s.ownerUserId).toBeNull();
        expect(s.poolEntryReason).toBeNull();
        expect(s.releasedAt).toBeNull();
      }
      expect(await prisma.crmProfilePoolShare.count()).toBe(0);

      // ── 4. 已有 state 不被覆盖 ──
      const sExisting = await stateOf(pExisting.id, "FIELD_SALES");
      expect(sExisting.stage).toBe("CUSTOM_KEEP");
      expect(sExisting.importance).toBe("KEY");

      // ── 5. 幂等：二次 apply 创建 0、行不变 ──
      const before = await prisma.crmProfileDepartmentState.findMany({ orderBy: { id: "asc" } });
      const second = await backfillDepartmentStates(prisma, { apply: true });
      expect(second.statesCreatedFieldSales).toBe(0);
      expect(second.statesCreatedOnlineOps).toBe(0);
      expect(second.statesSkippedExisting).toBe(12);
      expect(second.missingStateProfilesAfterApply).toBe(0);
      const after = await prisma.crmProfileDepartmentState.findMany({ orderBy: { id: "asc" } });
      expect(after.map((r) => JSON.stringify(r))).toEqual(before.map((r) => JSON.stringify(r)));

      // ── 6. 干净数据扫描全绿 ──
      const cleanReport = await scanDepartmentConsistency(prisma);
      expect(cleanReport.ok).toBe(true);
      for (const item of cleanReport.items) {
        expect(item.count, `clean scan: ${item.key}`).toBe(0);
      }

      // ── 7. 注入人为异常，扫描必须正确计数 ──
      // 7a. 缺 state 的 active profile
      const pNoState = await prisma.crmCustomerProfile.create({ data: { name: "缺state" } });
      // 7b. CLAIMED 无 owner（另一部门 state 正常，避免混入缺行计数）
      const pClaimedNoOwner = await prisma.crmCustomerProfile.create({ data: { name: "CLAIMED无owner" } });
      await prisma.crmProfileDepartmentState.create({
        data: { profileId: pClaimedNoOwner.id, department: "FIELD_SALES", claimStatus: "CLAIMED", ownerUserId: null },
      });
      await prisma.crmProfileDepartmentState.create({
        data: { profileId: pClaimedNoOwner.id, department: "ONLINE_OPS", claimStatus: "POOL" },
      });
      // 7c. POOL 有 owner
      const pPoolWithOwner = await prisma.crmCustomerProfile.create({ data: { name: "POOL有owner" } });
      await prisma.crmProfileDepartmentState.create({
        data: { profileId: pPoolWithOwner.id, department: "FIELD_SALES", claimStatus: "CLAIMED", ownerUserId: uFs1.id },
      });
      await prisma.crmProfileDepartmentState.create({
        data: { profileId: pPoolWithOwner.id, department: "ONLINE_OPS", claimStatus: "POOL", ownerUserId: uOps.id },
      });
      // 7d. owner 部门与 state 部门不一致
      const pOwnerMismatch = await prisma.crmCustomerProfile.create({ data: { name: "owner部门不一致" } });
      await prisma.crmProfileDepartmentState.create({
        data: { profileId: pOwnerMismatch.id, department: "FIELD_SALES", claimStatus: "CLAIMED", ownerUserId: uOps.id },
      });
      await prisma.crmProfileDepartmentState.create({
        data: { profileId: pOwnerMismatch.id, department: "ONLINE_OPS", claimStatus: "POOL" },
      });
      // 7e. 隐藏 POOL 残留 releasedAt
      const pHiddenResidue = await prisma.crmCustomerProfile.create({ data: { name: "隐藏POOL残留" } });
      await prisma.crmProfileDepartmentState.create({
        data: { profileId: pHiddenResidue.id, department: "FIELD_SALES", claimStatus: "CLAIMED", ownerUserId: uFs1.id },
      });
      await prisma.crmProfileDepartmentState.create({
        data: {
          profileId: pHiddenResidue.id, department: "ONLINE_OPS", claimStatus: "POOL",
          poolEntryReason: null, releasedAt: new Date(),
        },
      });
      // 7f. 已释放 POOL 缺 releasedAt
      const pReleasedNoAt = await prisma.crmCustomerProfile.create({ data: { name: "释放缺releasedAt" } });
      await prisma.crmProfileDepartmentState.create({
        data: {
          profileId: pReleasedNoAt.id, department: "FIELD_SALES", claimStatus: "POOL",
          poolEntryReason: "RELEASED", releasedAt: null,
        },
      });
      await prisma.crmProfileDepartmentState.create({
        data: { profileId: pReleasedNoAt.id, department: "ONLINE_OPS", claimStatus: "POOL" },
      });
      // 7g. CLAIMED 残留 poolEntryReason
      const pClaimedResidue = await prisma.crmCustomerProfile.create({ data: { name: "CLAIMED残留reason" } });
      await prisma.crmProfileDepartmentState.create({
        data: {
          profileId: pClaimedResidue.id, department: "FIELD_SALES", claimStatus: "CLAIMED",
          ownerUserId: uFs1.id, poolEntryReason: "RELEASED",
        },
      });
      await prisma.crmProfileDepartmentState.create({
        data: { profileId: pClaimedResidue.id, department: "ONLINE_OPS", claimStatus: "POOL" },
      });
      // 7h. Follow-up owner 与记录部门不一致
      await prisma.crmFollowUpTask.create({
        data: {
          profileId: pAssigned.id, ownerUserId: uOps.id, title: "跨部门跟进",
          dueAt: new Date(), createdByUserId: uAdmin.id, departmentSnapshot: "FIELD_SALES",
        },
      });
      // 7i. Project ↔ Order 部门不一致
      const badOrder = await prisma.order.create({
        data: {
          orderNo: "T-DEPT-001", title: "跨部门订单", departmentSnapshot: "ONLINE_OPS",
          createdById: uAdmin.id,
        },
      });
      const badProject = await prisma.project.create({
        data: { name: "跨部门项目", departmentSnapshot: "FIELD_SALES" },
      });
      await prisma.orderProjectLink.create({
        data: { orderId: badOrder.id, projectId: badProject.id },
      });
      // 7j. 非法 User.department
      await prisma.user.create({
        data: { email: "broken@t.test", name: "BROKEN", password: "x", role: "USER", department: "BROKEN" },
      });
      // 7k. PoolShare 异常：sharedBy 非来源部门（非 ADMIN）
      await prisma.crmProfilePoolShare.create({
        data: {
          profileId: pAssigned.id, sourceDepartment: "FIELD_SALES", targetDepartment: "ONLINE_OPS",
          sharedByUserId: uOps.id,
        },
      });
      // 7l. PoolShare source=target
      await prisma.crmProfilePoolShare.create({
        data: {
          profileId: pCandidate.id, sourceDepartment: "FIELD_SALES", targetDepartment: "FIELD_SALES",
          sharedByUserId: uAdmin.id,
        },
      });
      // 7m. PoolShare 非法端点
      await prisma.crmProfilePoolShare.create({
        data: {
          profileId: pRecalled.id, sourceDepartment: "BROKEN", targetDepartment: "ONLINE_OPS",
          sharedByUserId: uAdmin.id,
        },
      });
      // 7n. PoolShare 缺少对应部门 state（pNoState 无任何 state）
      await prisma.crmProfilePoolShare.create({
        data: {
          profileId: pNoState.id, sourceDepartment: "FIELD_SALES", targetDepartment: "ONLINE_OPS",
          sharedByUserId: uAdmin.id,
        },
      });

      const dirtyReport = await scanDepartmentConsistency(prisma);
      expect(dirtyReport.ok).toBe(false);
      const countOf = (key: string) => {
        const item = dirtyReport.items.find((i) => i.key === key);
        expect(item, `scan item ${key} 存在`).toBeDefined();
        return item!.count;
      };
      expect(countOf("illegalUserDepartment")).toBe(1);
      expect(countOf("profileStateMissing")).toBe(1);
      expect(countOf("stateClaimedWithoutOwner")).toBe(1);
      expect(countOf("statePoolWithOwner")).toBe(1);
      expect(countOf("stateOwnerDepartmentMismatch")).toBe(1);
      expect(countOf("hiddenPoolWithReleaseResidue")).toBe(1);
      expect(countOf("releasedPoolMissingReleasedAt")).toBe(1);
      expect(countOf("claimedWithPoolEntryReason")).toBe(1);
      expect(countOf("followUpOwnerDepartmentMismatch")).toBe(1);
      expect(countOf("projectOrderDepartmentMismatch")).toBe(1);
      expect(countOf("poolShareSharedByNotSourceDept")).toBe(1);
      expect(countOf("poolShareSameSourceTarget")).toBe(1);
      expect(countOf("poolShareIllegalEndpoint")).toBe(1);
      // 2 = 7n（pNoState 无任何 state）+ 7m（source=BROKEN 无对应 state）
      expect(countOf("poolShareMissingState")).toBe(2);
      // 未注入的项保持 0
      expect(countOf("illegalDepartmentSnapshot")).toBe(0);
      expect(countOf("receiptAllocationDepartmentMismatch")).toBe(0);
      expect(countOf("paymentAllocationDepartmentMismatch")).toBe(0);
      expect(countOf("invoiceCrossDepartmentCoverage")).toBe(0);
    });
  });
});
