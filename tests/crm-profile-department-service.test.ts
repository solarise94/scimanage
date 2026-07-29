/**
 * Phase 4 核心：CRM 公海 / 认领 / 共享授权领域服务测试。
 *
 * 覆盖设计 docs/department-isolation-design-2026-07-24.md §12.2 中 service 层可测场景：
 *   #4  创建客户：本部门 CLAIMED、对方隐藏 POOL、默认不进对方公海
 *   #5  显式共享后目标部门 POOL 可见且 DTO 脱敏
 *   #6  撤回后（目标 poolEntryReason=null）目标 resolveCrmProfileAccess → NONE
 *   #7  跨部门共享公海并发认领只有一个成功，另一个 409
 *   #8  目标认领后来源撤回不影响目标 CLAIMED
 *   #9  目标释放后 POOL+RELEASED，来源已撤回仍可见（本部门公海）
 *   #10 本部门公海认领不需要共享授权；并发只有一个成功
 *   #11 未共享时独立录入确定性唯一匹配复用同一 profile；模糊匹配进冲突路径
 *   #12 两个部门分别认领同一 profile，owner/stage/source 互不覆盖
 *   #17 共享 profile updatedAt 乐观锁冲突检测
 *   +   canManageProfilePoolShare 权限矩阵
 *   +   FIELD_SALES 兼容双写（§8.7）；ONLINE_OPS 绝不写旧字段
 *   +   跨部门 owner 的 claim/transfer 被拒
 *
 * 全部在 withTempSmokeDb 临时 SQLite 中执行，严禁触碰 prisma/dev.db。
 * 与 department-state-backfill 测试一致：单文件共享单个 withTempSmokeDb
 * （prisma 全局单例不跨 withTempSmokeDb 重建）。
 */
import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";

describe("crm profile department service (Phase 4)", () => {
  it("公海/认领/共享/创建去重 全场景", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const {
        createOrAttachCrmProfile,
        CrmProfileDuplicateConflictError,
      } = await import("@/lib/crm/create-profile");
      const {
        setProfilePoolShare,
        canManageProfilePoolShare,
      } = await import("@/lib/crm/profile-pool-share");
      const {
        claimProfileForDepartment,
        transferProfileOwnership,
        releaseProfileToPool,
      } = await import("@/lib/crm/profile-department-service");
      const {
        resolveCrmProfileAccess,
        buildCrmProfileDto,
        loadPoolDtoContext,
        getClaimedCrmVisibleProfileIds,
        getPoolCrmVisibleProfileIds,
        assertSharedProfileFreshness,
      } = await import("@/lib/crm/profile-access");
      const { getEffectiveCrmVisibleProfileIds } = await import("@/lib/crm/permissions");
      const {
        ConflictError,
        ForbiddenError,
        ValidationError,
        StaleStateError,
      } = await import("@/lib/application/errors");
      type BusinessActor = import("@/lib/application/actor").BusinessActor;

      // ── 种子用户 ──
      const mkUser = (email: string, role: string, department: string, name: string) =>
        prisma.user.create({ data: { email, name, password: "x", role, department } });
      const uFsOwner = await mkUser("fs-owner@t.test", "USER", "FIELD_SALES", "FS负责人");
      const uFsPeer = await mkUser("fs-peer@t.test", "USER", "FIELD_SALES", "FS同事");
      const uFs3 = await mkUser("fs-3@t.test", "USER", "FIELD_SALES", "FS三人");
      const uFsRm = await mkUser("fs-rm@t.test", "REGIONAL_MANAGER", "FIELD_SALES", "FS经理");
      const uFsRep = await mkUser("fs-rep@t.test", "REPRESENTATIVE", "FIELD_SALES", "FS代表");
      await prisma.representative.create({
        data: { name: "FS代表", email: "fs-rep@t.test", kind: "HUMAN" },
      });
      const uOps = await mkUser("ops-1@t.test", "USER", "ONLINE_OPS", "OPS一");
      const uOps2 = await mkUser("ops-2@t.test", "USER", "ONLINE_OPS", "OPS二");
      const uAdmin = await mkUser("admin@t.test", "ADMIN", "FIELD_SALES", "管理员");

      const actorOf = (u: {
        id: string; role: string; department: string; name: string; email: string;
      }): BusinessActor => ({
        userId: u.id, role: u.role, department: u.department, name: u.name, email: u.email,
      });
      const fsOwnerActor = actorOf(uFsOwner);
      const fsPeerActor = actorOf(uFsPeer);
      const fs3Actor = actorOf(uFs3);
      const fsRmActor = actorOf(uFsRm);
      const fsRepActor = actorOf(uFsRep);
      const opsActor = actorOf(uOps);
      const ops2Actor = actorOf(uOps2);
      const adminActor = actorOf(uAdmin);

      const stateOf = (profileId: string, department: string) =>
        prisma.crmProfileDepartmentState.findUniqueOrThrow({
          where: { profileId_department: { profileId, department } },
        });
      const logsOf = (profileId: string, action?: string) =>
        prisma.crmCustomerAssignmentLog.findMany({
          where: { profileId, ...(action ? { action } : {}) },
          orderBy: { createdAt: "asc" },
        });

      async function expectThrows(promise: Promise<unknown>, klass: new (...args: never[]) => Error) {
        try {
          await promise;
        } catch (err) {
          expect(err).toBeInstanceOf(klass);
          return err as InstanceType<typeof klass>;
        }
        throw new Error(`expected ${klass.name} to be thrown`);
      }

      // ════════════════════════════════════════════════════════════════════
      // #4 FIELD_SALES 创建：本部门 CLAIMED、对方隐藏 POOL、默认不共享
      // ════════════════════════════════════════════════════════════════════
      const created = await createOrAttachCrmProfile({
        actor: fsOwnerActor,
        identityInput: {
          name: "客户甲",
          phone: "13800000001",
          wechat: "wx-jia",
          email: "jia@example.com",
          organization: "机构A",
          labOrGroup: "单细胞组",
          address: "秘密地址1号",
          sourceHint: "MANUAL",
        },
        departmentStateInput: { stage: "FOLLOWING", importance: "HIGH", source: "展会" },
      });
      expect(created.outcome).toBe("CREATED");
      expect(created.department).toBe("FIELD_SALES");
      const p1 = created.profileId;

      const p1Row = await prisma.crmCustomerProfile.findUniqueOrThrow({ where: { id: p1 } });
      expect(p1Row.ownerUserId).toBe(uFsOwner.id);
      expect(p1Row.assignmentStatus).toBe("ASSIGNED");
      const p1Fs = await stateOf(p1, "FIELD_SALES");
      expect(p1Fs.claimStatus).toBe("CLAIMED");
      expect(p1Fs.ownerUserId).toBe(uFsOwner.id);
      expect(p1Fs.stage).toBe("FOLLOWING");
      expect(p1Fs.source).toBe("展会");
      const p1Ops = await stateOf(p1, "ONLINE_OPS");
      expect(p1Ops.claimStatus).toBe("POOL");
      expect(p1Ops.ownerUserId).toBeNull();
      expect(p1Ops.poolEntryReason).toBeNull();
      expect(await prisma.crmProfilePoolShare.count()).toBe(0);
      expect((await logsOf(p1, "CLAIM")).length).toBe(1);

      // 默认不进对方公海：访问解析与集合查询
      expect(await resolveCrmProfileAccess({ profileId: p1, actor: opsActor })).toBe("NONE");
      expect(await resolveCrmProfileAccess({ profileId: p1, actor: fsPeerActor })).toBe("FULL");
      expect(await resolveCrmProfileAccess({ profileId: p1, actor: adminActor })).toBe("FULL");
      expect(await getPoolCrmVisibleProfileIds(opsActor)).toEqual([]);
      expect(await getClaimedCrmVisibleProfileIds(fsPeerActor)).toContain(p1);
      expect(await getClaimedCrmVisibleProfileIds(opsActor)).toEqual([]);
      expect(await getClaimedCrmVisibleProfileIds(adminActor)).toBeNull();

      // ── canManageProfilePoolShare 权限矩阵（§4.5 最收紧映射）──
      expect(await canManageProfilePoolShare(fsOwnerActor, "FIELD_SALES", p1)).toBe(true);
      expect(await canManageProfilePoolShare(adminActor, "FIELD_SALES", p1)).toBe(true);
      expect(await canManageProfilePoolShare(fsRmActor, "FIELD_SALES", p1)).toBe(false);
      expect(await canManageProfilePoolShare(fsPeerActor, "FIELD_SALES", p1)).toBe(false);
      expect(await canManageProfilePoolShare(opsActor, "ONLINE_OPS", p1)).toBe(false);
      expect(await canManageProfilePoolShare(opsActor, "FIELD_SALES", p1)).toBe(false);

      // ════════════════════════════════════════════════════════════════════
      // #4b ONLINE_OPS 创建：禁止伪造 FIELD_SALES owner
      // ════════════════════════════════════════════════════════════════════
      const createdOps = await createOrAttachCrmProfile({
        actor: opsActor,
        identityInput: { name: "客户乙", wechat: "wx-yi", organization: "机构B" },
        departmentStateInput: { stage: "LEAD", source: "广告" },
      });
      expect(createdOps.outcome).toBe("CREATED");
      const pOps = createdOps.profileId;
      const pOpsRow = await prisma.crmCustomerProfile.findUniqueOrThrow({ where: { id: pOps } });
      expect(pOpsRow.ownerUserId).toBeNull();
      expect(pOpsRow.assignmentStatus).toBe("UNASSIGNED");
      expect(pOpsRow.assignedAt).toBeNull();
      const pOpsOpsState = await stateOf(pOps, "ONLINE_OPS");
      expect(pOpsOpsState.claimStatus).toBe("CLAIMED");
      expect(pOpsOpsState.ownerUserId).toBe(uOps.id);
      const pOpsFsState = await stateOf(pOps, "FIELD_SALES");
      expect(pOpsFsState.claimStatus).toBe("POOL");
      expect(pOpsFsState.poolEntryReason).toBeNull();
      // FIELD_SALES 用户看不到 ONLINE_OPS 已认领客户（部门隔离 fail-closed）
      expect(await resolveCrmProfileAccess({ profileId: pOps, actor: fsPeerActor })).toBe("NONE");
      expect(await resolveCrmProfileAccess({ profileId: pOps, actor: ops2Actor })).toBe("FULL");
      expect(await getClaimedCrmVisibleProfileIds(fsPeerActor)).not.toContain(pOps);
      expect(await getClaimedCrmVisibleProfileIds(opsActor)).toContain(pOps);

      // ════════════════════════════════════════════════════════════════════
      // #5 显式共享 → 目标部门 POOL 可见且 DTO 脱敏
      // ════════════════════════════════════════════════════════════════════
      const shareResult = await setProfilePoolShare({
        actor: fsOwnerActor,
        profileId: p1,
        targetDepartment: "ONLINE_OPS",
        shared: true,
      });
      expect(shareResult.status).toBe("ACTIVE");
      expect(shareResult.sharedAt).not.toBeNull();
      expect(shareResult.revokedAt).toBeNull();

      expect(await resolveCrmProfileAccess({ profileId: p1, actor: opsActor })).toBe("POOL");
      expect(await getPoolCrmVisibleProfileIds(opsActor)).toContain(p1);

      const poolCtx = await loadPoolDtoContext(p1, "ONLINE_OPS");
      expect(poolCtx?.poolKind).toBe("SHARED_POOL");
      expect(poolCtx?.poolEnteredAt?.getTime()).toBe(shareResult.sharedAt!.getTime());

      const fullRow = await prisma.crmCustomerProfile.findUniqueOrThrow({
        where: { id: p1 },
        include: { org: true, orgSite: true },
      });
      const poolDto = buildCrmProfileDto(fullRow, "POOL", poolCtx!);
      expect(poolDto).not.toBeNull();
      // 封闭接口：只允许最小披露字段
      expect(Object.keys(poolDto as object).sort()).toEqual(
        [
          "profileId", "name", "organization", "labOrGroup", "personCategory",
          "poolEnteredAt", "poolKind", "dedupHint",
        ].sort(),
      );
      const dto = poolDto as Record<string, unknown>;
      expect(dto.profileId).toBe(p1);
      expect(dto.name).toBe("客户甲");
      expect(dto.organization).toBe("机构A");
      expect(dto.labOrGroup).toBe("单细胞组");
      // 脱敏与不披露：无联系方式/详细地址/来源部门/对方 owner 或 state/互动订单统计
      for (const banned of [
        "phone", "wechat", "email", "address", "addressNote", "receiverPhone",
        "receiverAddress", "sourceDepartment", "targetDepartment", "ownerUserId",
        "ownerUser", "assignmentStatus", "claimStatus", "stage", "interactions",
        "_count", "lastOrderAt", "departmentStates", "poolShares",
      ]) {
        expect(dto).not.toHaveProperty(banned);
      }

      // FULL DTO 沿用现有序列化（直通完整字段）
      const fullDto = buildCrmProfileDto(fullRow, "FULL") as Record<string, unknown>;
      expect(fullDto).toHaveProperty("phone", "13800000001");
      // NONE → null，由调用方转 404
      expect(buildCrmProfileDto(fullRow, "NONE")).toBeNull();

      // 共享授权不修改旧 assignmentStatus/owner 字段（§8.7）
      const p1AfterShare = await prisma.crmCustomerProfile.findUniqueOrThrow({ where: { id: p1 } });
      expect(p1AfterShare.assignmentStatus).toBe("ASSIGNED");
      expect(p1AfterShare.ownerUserId).toBe(uFsOwner.id);
      expect((await logsOf(p1, "SHARE_TO_POOL")).length).toBe(1);

      // ════════════════════════════════════════════════════════════════════
      // #6 撤回（目标 poolEntryReason=null）→ 目标立即 NONE
      // ════════════════════════════════════════════════════════════════════
      const revokeResult = await setProfilePoolShare({
        actor: fsOwnerActor,
        profileId: p1,
        targetDepartment: "ONLINE_OPS",
        shared: false,
      });
      expect(revokeResult.status).toBe("REVOKED");
      expect(revokeResult.revokedAt).not.toBeNull();
      expect(await resolveCrmProfileAccess({ profileId: p1, actor: opsActor })).toBe("NONE");
      expect(await getPoolCrmVisibleProfileIds(opsActor)).not.toContain(p1);
      expect(await loadPoolDtoContext(p1, "ONLINE_OPS")).toBeNull();
      expect((await logsOf(p1, "REVOKE_POOL_SHARE")).length).toBe(1);

      // 重复撤回幂等；撤回不存在授权幂等（NONE）
      const revokeAgain = await setProfilePoolShare({
        actor: fsOwnerActor, profileId: p1, targetDepartment: "ONLINE_OPS", shared: false,
      });
      expect(revokeAgain.status).toBe("REVOKED");
      const revokeNone = await setProfilePoolShare({
        actor: opsActor, profileId: pOps, targetDepartment: "FIELD_SALES", shared: false,
      });
      expect(revokeNone.status).toBe("NONE");

      // ── 权限与参数校验 ──
      await expectThrows(
        setProfilePoolShare({ actor: fsRmActor, profileId: p1, targetDepartment: "ONLINE_OPS", shared: true }),
        ForbiddenError,
      );
      await expectThrows(
        setProfilePoolShare({ actor: fsPeerActor, profileId: p1, targetDepartment: "ONLINE_OPS", shared: true }),
        ForbiddenError,
      );
      await expectThrows(
        setProfilePoolShare({ actor: adminActor, profileId: p1, targetDepartment: "ONLINE_OPS", shared: true }),
        ValidationError, // ADMIN 必须显式 sourceDepartment
      );
      await expectThrows(
        setProfilePoolShare({
          actor: fsOwnerActor, profileId: p1, sourceDepartment: "ONLINE_OPS",
          targetDepartment: "FIELD_SALES", shared: true,
        }),
        ForbiddenError, // 非 ADMIN source 必须等于当前部门
      );
      await expectThrows(
        setProfilePoolShare({
          actor: adminActor, profileId: p1, sourceDepartment: "FIELD_SALES",
          targetDepartment: "FIELD_SALES", shared: true,
        }),
        ValidationError, // source 与 target 必须不同
      );

      // ADMIN 跨部门代操作（S4b profile：ONLINE_OPS CLAIMED）并写跨部门审计
      const adminShare = await setProfilePoolShare({
        actor: adminActor, profileId: pOps, sourceDepartment: "ONLINE_OPS",
        targetDepartment: "FIELD_SALES", shared: true,
      });
      expect(adminShare.status).toBe("ACTIVE");
      const adminShareLog = (await logsOf(pOps, "SHARE_TO_POOL")).at(-1);
      expect(adminShareLog?.department).toBe("ONLINE_OPS");
      expect(adminShareLog?.targetDepartment).toBe("FIELD_SALES");
      expect(adminShareLog?.reason).toContain("ADMIN 跨部门代操作");
      // 清理：撤回，避免影响后续断言
      await setProfilePoolShare({
        actor: adminActor, profileId: pOps, sourceDepartment: "ONLINE_OPS",
        targetDepartment: "FIELD_SALES", shared: false,
      });

      // ════════════════════════════════════════════════════════════════════
      // #7 跨部门共享公海并发认领：只有一个成功，另一个 409
      // ════════════════════════════════════════════════════════════════════
      await setProfilePoolShare({
        actor: fsOwnerActor, profileId: p1, targetDepartment: "ONLINE_OPS", shared: true,
      });
      // 未授权状态下直接 claim（隐藏 POOL 无授权）→ 409；先验证授权是必要条件
      const pHidden = (await createOrAttachCrmProfile({
        actor: fsOwnerActor,
        identityInput: { name: "隐藏客户", phone: "13800000009" },
      })).profileId;
      await expectThrows(
        claimProfileForDepartment({ actor: opsActor, profileId: pHidden, ownerUserId: uOps.id }),
        ConflictError,
      );

      const claimResults = await Promise.allSettled([
        claimProfileForDepartment({ actor: opsActor, profileId: p1, ownerUserId: uOps.id }),
        claimProfileForDepartment({ actor: ops2Actor, profileId: p1, ownerUserId: uOps2.id }),
      ]);
      const fulfilled = claimResults.filter((r) => r.status === "fulfilled");
      const rejected = claimResults.filter((r) => r.status === "rejected");
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
      expect(((rejected[0] as PromiseRejectedResult).reason as { httpStatus: number }).httpStatus).toBe(409);

      const p1OpsAfterClaim = await stateOf(p1, "ONLINE_OPS");
      expect(p1OpsAfterClaim.claimStatus).toBe("CLAIMED");
      const opsWinnerId = p1OpsAfterClaim.ownerUserId!;
      expect([uOps.id, uOps2.id]).toContain(opsWinnerId);
      const opsWinnerActor = opsWinnerId === uOps.id ? opsActor : ops2Actor;
      expect(p1OpsAfterClaim.poolEntryReason).toBeNull();
      // ONLINE_OPS 认领绝不写旧 profile owner/assignmentStatus（§8.7）
      const p1AfterOpsClaim = await prisma.crmCustomerProfile.findUniqueOrThrow({ where: { id: p1 } });
      expect(p1AfterOpsClaim.ownerUserId).toBe(uFsOwner.id);
      expect(p1AfterOpsClaim.assignmentStatus).toBe("ASSIGNED");
      expect((await logsOf(p1, "CLAIM")).some((l) => l.department === "ONLINE_OPS")).toBe(true);

      // 认领后权限来自自身 state：撤回共享不影响目标（#8 前置）
      expect(await resolveCrmProfileAccess({ profileId: p1, actor: opsWinnerActor })).toBe("FULL");

      // ════════════════════════════════════════════════════════════════════
      // #8 目标认领后来源撤回不影响目标 CLAIMED
      // ════════════════════════════════════════════════════════════════════
      const revokeAfterClaim = await setProfilePoolShare({
        actor: fsOwnerActor, profileId: p1, targetDepartment: "ONLINE_OPS", shared: false,
      });
      expect(revokeAfterClaim.status).toBe("REVOKED");
      const p1OpsAfterRevoke = await stateOf(p1, "ONLINE_OPS");
      expect(p1OpsAfterRevoke.claimStatus).toBe("CLAIMED");
      expect(p1OpsAfterRevoke.ownerUserId).toBe(opsWinnerId);
      expect(await resolveCrmProfileAccess({ profileId: p1, actor: opsWinnerActor })).toBe("FULL");
      // 目标部门已 CLAIMED，共享/撤回不影响另一部门 state
      const p1FsUnchanged = await stateOf(p1, "FIELD_SALES");
      expect(p1FsUnchanged.claimStatus).toBe("CLAIMED");
      expect(p1FsUnchanged.ownerUserId).toBe(uFsOwner.id);

      // ════════════════════════════════════════════════════════════════════
      // #9 目标释放 → POOL+RELEASED 本部门公海；来源已撤回仍可见；旧字段不动
      // ════════════════════════════════════════════════════════════════════
      const opsRelease = await releaseProfileToPool({ actor: opsWinnerActor, profileId: p1 });
      expect(opsRelease.department).toBe("ONLINE_OPS");
      expect(opsRelease.poolEntryReason).toBe("RELEASED");
      const p1OpsReleased = await stateOf(p1, "ONLINE_OPS");
      expect(p1OpsReleased.claimStatus).toBe("POOL");
      expect(p1OpsReleased.poolEntryReason).toBe("RELEASED");
      expect(p1OpsReleased.ownerUserId).toBeNull();
      expect(p1OpsReleased.releasedAt).not.toBeNull();
      // 本部门公海不再依赖共享授权（授权已在 #8 撤回）
      expect(await resolveCrmProfileAccess({ profileId: p1, actor: opsActor })).toBe("POOL");
      expect(await getPoolCrmVisibleProfileIds(opsActor)).toContain(p1);
      const ownPoolCtx = await loadPoolDtoContext(p1, "ONLINE_OPS");
      expect(ownPoolCtx?.poolKind).toBe("OWN_POOL");
      expect(ownPoolCtx?.poolEnteredAt?.getTime()).toBe(p1OpsReleased.releasedAt!.getTime());
      // ONLINE_OPS 释放不写旧字段
      const p1AfterOpsRelease = await prisma.crmCustomerProfile.findUniqueOrThrow({ where: { id: p1 } });
      expect(p1AfterOpsRelease.assignmentStatus).toBe("ASSIGNED");
      expect(p1AfterOpsRelease.ownerUserId).toBe(uFsOwner.id);
      expect((await logsOf(p1, "RELEASE")).some((l) => l.department === "ONLINE_OPS")).toBe(true);

      // 非 owner / 非 ADMIN 不能释放（此时 ONLINE_OPS 已 POOL，用 FS 侧验证）
      await expectThrows(
        releaseProfileToPool({ actor: fsRmActor, profileId: p1 }),
        ForbiddenError,
      );
      await expectThrows(
        releaseProfileToPool({ actor: fsPeerActor, profileId: p1 }),
        ForbiddenError,
      );

      // ════════════════════════════════════════════════════════════════════
      // #10 本部门公海（poolEntryReason!=null）认领不需要共享授权；并发只有一个成功
      // ════════════════════════════════════════════════════════════════════
      const fsRelease = await releaseProfileToPool({ actor: fsOwnerActor, profileId: p1 });
      expect(fsRelease.department).toBe("FIELD_SALES");
      // FIELD_SALES 释放 → 旧字段投影 RECALLED（§8.7）
      const p1AfterFsRelease = await prisma.crmCustomerProfile.findUniqueOrThrow({ where: { id: p1 } });
      expect(p1AfterFsRelease.assignmentStatus).toBe("RECALLED");
      expect(p1AfterFsRelease.recalledAt).not.toBeNull();
      expect(p1AfterFsRelease.recalledByUserId).toBe(uFsOwner.id);
      const p1FsPool = await stateOf(p1, "FIELD_SALES");
      expect(p1FsPool.claimStatus).toBe("POOL");
      expect(p1FsPool.poolEntryReason).toBe("RELEASED");
      // 无任何 ACTIVE 入站授权
      expect(await prisma.crmProfilePoolShare.count({
        where: { profileId: p1, targetDepartment: "FIELD_SALES", status: "ACTIVE" },
      })).toBe(0);
      expect(await resolveCrmProfileAccess({ profileId: p1, actor: fsPeerActor })).toBe("POOL");

      const ownPoolClaims = await Promise.allSettled([
        claimProfileForDepartment({ actor: fsPeerActor, profileId: p1, ownerUserId: uFsPeer.id }),
        claimProfileForDepartment({ actor: fs3Actor, profileId: p1, ownerUserId: uFs3.id }),
      ]);
      expect(ownPoolClaims.filter((r) => r.status === "fulfilled").length).toBe(1);
      expect(ownPoolClaims.filter((r) => r.status === "rejected").length).toBe(1);
      const p1FsClaimed = await stateOf(p1, "FIELD_SALES");
      const fsWinnerId = p1FsClaimed.ownerUserId!;
      expect([uFsPeer.id, uFs3.id]).toContain(fsWinnerId);
      // FIELD_SALES 认领 → 旧字段投影 ASSIGNED（§8.7）
      const p1AfterFsClaim = await prisma.crmCustomerProfile.findUniqueOrThrow({ where: { id: p1 } });
      expect(p1AfterFsClaim.assignmentStatus).toBe("ASSIGNED");
      expect(p1AfterFsClaim.ownerUserId).toBe(fsWinnerId);
      expect(p1AfterFsClaim.assignedAt).not.toBeNull();

      // ════════════════════════════════════════════════════════════════════
      // Transfer（§8.4）+ 跨部门 owner 拒绝 + OWNER_UNAVAILABLE 释放
      // ════════════════════════════════════════════════════════════════════
      const fsWinnerActor = fsWinnerId === uFsPeer.id ? fsPeerActor : fs3Actor;
      const fsLoserId = fsWinnerId === uFsPeer.id ? uFs3.id : uFsPeer.id;

      // 非 owner 非 ADMIN（含 RM）不能转派
      await expectThrows(
        transferProfileOwnership({ actor: fsRmActor, profileId: p1, ownerUserId: fsLoserId }),
        ForbiddenError,
      );
      // 新 owner 必须同部门
      await expectThrows(
        transferProfileOwnership({ actor: fsWinnerActor, profileId: p1, ownerUserId: uOps.id }),
        ValidationError,
      );
      const transfer = await transferProfileOwnership({
        actor: fsWinnerActor, profileId: p1, ownerUserId: fsLoserId,
      });
      expect(transfer.fromOwnerUserId).toBe(fsWinnerId);
      expect(transfer.toOwnerUserId).toBe(fsLoserId);
      const p1FsTransferred = await stateOf(p1, "FIELD_SALES");
      expect(p1FsTransferred.claimStatus).toBe("CLAIMED");
      expect(p1FsTransferred.ownerUserId).toBe(fsLoserId);
      const p1AfterTransfer = await prisma.crmCustomerProfile.findUniqueOrThrow({ where: { id: p1 } });
      expect(p1AfterTransfer.ownerUserId).toBe(fsLoserId);
      expect(p1AfterTransfer.assignmentStatus).toBe("ASSIGNED");
      const transferLog = (await logsOf(p1, "TRANSFER")).at(-1);
      expect(transferLog?.fromOwnerUserId).toBe(fsWinnerId);
      expect(transferLog?.toOwnerUserId).toBe(fsLoserId);

      // claim 的 owner 也必须同部门
      await expectThrows(
        claimProfileForDepartment({ actor: opsActor, profileId: p1, ownerUserId: uFsPeer.id }),
        ValidationError,
      );
      // 非 ADMIN 不能为其他部门操作
      await expectThrows(
        claimProfileForDepartment({
          actor: fsPeerActor, profileId: p1, ownerUserId: uOps.id, targetDepartment: "ONLINE_OPS",
        }),
        ForbiddenError,
      );

      // OWNER_UNAVAILABLE 释放（§8.7：UNASSIGNED + owner 置 null）
      const fsLoserActor = fsLoserId === uFsPeer.id ? fsPeerActor : fs3Actor;
      await releaseProfileToPool({ actor: fsLoserActor, profileId: p1, reason: "OWNER_UNAVAILABLE" });
      const p1FsUnavail = await stateOf(p1, "FIELD_SALES");
      expect(p1FsUnavail.claimStatus).toBe("POOL");
      expect(p1FsUnavail.poolEntryReason).toBe("OWNER_UNAVAILABLE");
      const p1AfterUnavail = await prisma.crmCustomerProfile.findUniqueOrThrow({ where: { id: p1 } });
      expect(p1AfterUnavail.assignmentStatus).toBe("UNASSIGNED");
      expect(p1AfterUnavail.ownerUserId).toBeNull();

      // ════════════════════════════════════════════════════════════════════
      // #17 共享 profile updatedAt 乐观锁冲突检测
      // ════════════════════════════════════════════════════════════════════
      const versionSnap = await prisma.crmCustomerProfile.findUniqueOrThrow({
        where: { id: p1 }, select: { updatedAt: true },
      });
      await assertSharedProfileFreshness({ profileId: p1, expectedUpdatedAt: versionSnap.updatedAt });
      await prisma.crmCustomerProfile.update({ where: { id: p1 }, data: { summary: "并发写入" } });
      await expectThrows(
        assertSharedProfileFreshness({ profileId: p1, expectedUpdatedAt: versionSnap.updatedAt }),
        StaleStateError,
      );

      // ════════════════════════════════════════════════════════════════════
      // #11 / #12 未共享时独立录入：确定性唯一匹配复用同一 profile；模糊进冲突
      // ════════════════════════════════════════════════════════════════════
      const independent = await createOrAttachCrmProfile({
        actor: fsOwnerActor,
        identityInput: { name: "独立客户", phone: "13911112222", organization: "机构X" },
        departmentStateInput: { stage: "FOLLOWING", source: "展会" },
      });
      expect(independent.outcome).toBe("CREATED");
      const pIndep = independent.profileId;
      // 未共享：ONLINE_OPS 不可见
      expect(await resolveCrmProfileAccess({ profileId: pIndep, actor: opsActor })).toBe("NONE");

      // 确定性唯一匹配（同姓名 + 同手机号）→ 复用同一 profile，录入部门直接 CLAIMED
      const attach = await createOrAttachCrmProfile({
        actor: ops2Actor,
        identityInput: { name: "独立客户", phone: "13911112222", organization: "机构X" },
        departmentStateInput: { stage: "ACTIVE", source: "广告" },
      });
      expect(attach.outcome).toBe("ATTACHED");
      expect(attach.profileId).toBe(pIndep);
      // #12：两个部门 owner/stage/source 互不覆盖
      const indepFs = await stateOf(pIndep, "FIELD_SALES");
      expect(indepFs.claimStatus).toBe("CLAIMED");
      expect(indepFs.ownerUserId).toBe(uFsOwner.id);
      expect(indepFs.stage).toBe("FOLLOWING");
      expect(indepFs.source).toBe("展会");
      const indepOps = await stateOf(pIndep, "ONLINE_OPS");
      expect(indepOps.claimStatus).toBe("CLAIMED");
      expect(indepOps.ownerUserId).toBe(uOps2.id);
      expect(indepOps.stage).toBe("ACTIVE");
      expect(indepOps.source).toBe("广告");
      // FIELD_SALES 旧字段不被 ONLINE_OPS 录入改写
      const indepRow = await prisma.crmCustomerProfile.findUniqueOrThrow({ where: { id: pIndep } });
      expect(indepRow.ownerUserId).toBe(uFsOwner.id);
      expect(indepRow.assignmentStatus).toBe("ASSIGNED");
      // 复用不产生共享授权、不产生第二个 profile
      expect(await prisma.crmProfilePoolShare.count({ where: { profileId: pIndep } })).toBe(0);
      expect(await prisma.crmCustomerProfile.count({ where: { name: "独立客户" } })).toBe(1);
      // 复用审计：独立录入去重 CLAIM
      const attachLog = (await logsOf(pIndep, "CLAIM")).at(-1);
      expect(attachLog?.department).toBe("ONLINE_OPS");
      expect(attachLog?.reason).toContain("独立录入全局去重复用");

      // 重复录入（本部门已 CLAIMED）→ ALREADY_CLAIMED，不覆盖
      const reEntry = await createOrAttachCrmProfile({
        actor: ops2Actor,
        identityInput: { name: "独立客户", phone: "13911112222", organization: "机构X" },
        departmentStateInput: { stage: "LOST" },
      });
      expect(reEntry.outcome).toBe("ALREADY_CLAIMED");
      expect((await stateOf(pIndep, "ONLINE_OPS")).stage).toBe("ACTIVE");

      // 模糊匹配（同名不同机构、无联系方式）→ 冲突路径，不泄露候选详情
      const fuzzy = await expectThrows(
        createOrAttachCrmProfile({
          actor: opsActor,
          identityInput: { name: "独立客户", organization: "另一个机构" },
        }),
        CrmProfileDuplicateConflictError,
      );
      expect((fuzzy as unknown as { code: string }).code).toBe("DUPLICATE_CANDIDATES");
      expect((fuzzy as unknown as { httpStatus: number }).httpStatus).toBe(409);
      // 关键字段冲突（同手机号不同姓名）→ 冲突路径
      await expectThrows(
        createOrAttachCrmProfile({
          actor: opsActor,
          identityInput: { name: "完全不同姓名", phone: "13911112222" },
        }),
        CrmProfileDuplicateConflictError,
      );

      // ════════════════════════════════════════════════════════════════════
      // Representative / RM 角色范围（CLAIMED 下仍受 effective representative 限制）
      // ════════════════════════════════════════════════════════════════════
      const repCreated = await createOrAttachCrmProfile({
        actor: fsRepActor,
        identityInput: { name: "代表客户", phone: "13700001111" },
      });
      const pRep = repCreated.profileId;
      // owner 是 rep 本人（email 桥接 Representative）→ FULL
      expect(await resolveCrmProfileAccess({ profileId: pRep, actor: fsRepActor })).toBe("FULL");
      // RM 无下辖代表 → 不在 effective 范围 → NONE
      expect(await resolveCrmProfileAccess({ profileId: pRep, actor: fsRmActor })).toBe("NONE");
      // 本部门 USER 不受 rep 范围限制
      expect(await resolveCrmProfileAccess({ profileId: pRep, actor: fsPeerActor })).toBe("FULL");
      const repVisible = await getEffectiveCrmVisibleProfileIds(uFsRep.id, "REPRESENTATIVE");
      expect(repVisible).not.toBeNull();
      expect(repVisible!.has(pRep)).toBe(true);
      expect(repVisible!.has(p1)).toBe(false); // p1 与 rep 无关
      const rmVisible = await getEffectiveCrmVisibleProfileIds(uFsRm.id, "REGIONAL_MANAGER");
      expect(rmVisible!.has(pRep)).toBe(false);

      // ── getEffectiveCrmVisibleProfileIds 新语义：ADMIN null；USER=本部门 CLAIMED ──
      expect(await getEffectiveCrmVisibleProfileIds(uAdmin.id, "ADMIN")).toBeNull();
      const fsUserVisible = await getEffectiveCrmVisibleProfileIds(uFsPeer.id, "USER");
      expect(fsUserVisible).not.toBeNull();
      expect(fsUserVisible!.has(pRep)).toBe(true);
      expect(fsUserVisible!.has(pOps)).toBe(false); // ONLINE_OPS CLAIMED 不可见
      expect(fsUserVisible!.has(p1)).toBe(false); // p1 在 FIELD_SALES 是 POOL，不并入
      const opsUserVisible = await getEffectiveCrmVisibleProfileIds(uOps.id, "USER");
      expect(opsUserVisible!.has(pOps)).toBe(true);
      expect(opsUserVisible!.has(pRep)).toBe(false);

      // ── 最终一致性：两个部门 state 与授权数据无残留异常 ──
      const allStates = await prisma.crmProfileDepartmentState.findMany();
      for (const s of allStates) {
        if (s.claimStatus === "CLAIMED") {
          expect(s.ownerUserId, `CLAIMED 必须有 owner: ${s.profileId}/${s.department}`).not.toBeNull();
          expect(s.poolEntryReason).toBeNull();
        }
        if (s.claimStatus === "POOL") {
          expect(s.ownerUserId, `POOL 必须清 owner: ${s.profileId}/${s.department}`).toBeNull();
        }
      }
    });
  });
});
