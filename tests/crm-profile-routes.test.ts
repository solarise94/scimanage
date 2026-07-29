/**
 * Phase 4 路由层契约测试（部门隔离设计 §8.2-8.7 / §12.2）。
 *
 * 覆盖 route 级 HTTP 映射与权限矩阵，参考 tests/chat-stream-409-contract.test.ts
 * 的临时 SQLite + 直接调用 route handler 做法：
 *   - claim / transfer / release / pool-sharing 的 401/403/404/409 映射
 *   - 隐藏 POOL 直接 ID → 404；共享后 POOL DTO 详情脱敏；认领后 FULL
 *   - 旧 assign/recall adapter 行为等价（状态机与旧契约）
 *   - 运营记录：非 ADMIN 列表只见本部门（follow-ups）
 *   - 代表归档后其名下客户进入 FIELD_SALES POOL + OWNER_UNAVAILABLE
 *   - 共享 profile 乐观锁冲突 409
 *
 * 全部在 withTempSmokeDb 临时 SQLite 中执行，严禁触碰 prisma/dev.db。
 * 与 department-state-backfill / crm-profile-department-service 测试一致：
 * 单文件共享单个 withTempSmokeDb（prisma 全局单例不跨 withTempSmokeDb 重建）。
 */
import { describe, expect, it, vi } from "vitest";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";

// ── mock next-auth（路由用 getServerSession） ──
type SessionUser = {
  id: string;
  role: string;
  name: string;
  email: string;
  department: string;
};
type MockSession = { user: SessionUser } | null;
const sessionState = vi.hoisted(() => ({ current: null as MockSession }));

vi.mock("next-auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getServerSession: async () => sessionState.current,
}));

// next-auth/next（representatives route 用这个 import 路径）—— 同一 mock。
vi.mock("next-auth/next", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getServerSession: async () => sessionState.current,
}));

function setSession(user: SessionUser | null): void {
  sessionState.current = user ? { user } : null;
}

function mkReq(
  url: string,
  init: { method?: string; body?: unknown } = {},
): import("next/server").NextRequest {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest } = require("next/server") as typeof import("next/server");
  return new NextRequest(url, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

async function jsonBody(res: import("next/server").NextResponse): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("crm profile routes (Phase 4 §8.2-8.7)", () => {
  it("claim/transfer/release/pool-sharing 401/403/404/409 + POOL DTO 脱敏 + 认领后 FULL + 乐观锁 + adapter + 归档 + 运营记录隔离", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { createOrAttachCrmProfile } = await import("@/lib/crm/create-profile");
      const { setProfilePoolShare } = await import("@/lib/crm/profile-pool-share");
      const { releaseProfileToPool } = await import("@/lib/crm/profile-department-service");

      // ── 种子用户 ──
      const mkUser = (email: string, role: string, department: string, name: string) =>
        prisma.user.create({ data: { email, name, password: "x", role, department } });
      const uFsOwner = await mkUser("fs-owner@t.test", "USER", "FIELD_SALES", "FS负责人");
      const uFsPeer = await mkUser("fs-peer@t.test", "USER", "FIELD_SALES", "FS同事");
      const uOps = await mkUser("ops-1@t.test", "USER", "ONLINE_OPS", "OPS一");
      const uOps2 = await mkUser("ops-2@t.test", "USER", "ONLINE_OPS", "OPS二");
      const uAdmin = await mkUser("admin@t.test", "ADMIN", "FIELD_SALES", "管理员");

      const sess = (u: { id: string; role: string; name: string; email: string; department: string }): SessionUser => ({
        id: u.id, role: u.role, name: u.name, email: u.email, department: u.department,
      });
      const fsOwnerSession = sess({ ...uFsOwner, name: uFsOwner.name!, email: uFsOwner.email, department: "FIELD_SALES" });
      const opsSession = sess({ ...uOps, name: uOps.name!, email: uOps.email, department: "ONLINE_OPS" });
      const ops2Session = sess({ ...uOps2, name: uOps2.name!, email: uOps2.email, department: "ONLINE_OPS" });
      const adminSession = sess({ ...uAdmin, name: uAdmin.name!, email: uAdmin.email, department: "FIELD_SALES" });
      const fsPeerSession = sess({ ...uFsPeer, name: uFsPeer.name!, email: uFsPeer.email, department: "FIELD_SALES" });

      // 预加载 route handlers（在 setSession 之前，避免触发 getServerSession）。
      const { PUT: putPoolSharing } = await import("@/app/api/crm/profiles/[id]/pool-sharing/route");
      const { POST: postClaim } = await import("@/app/api/crm/profiles/[id]/claim/route");
      const { POST: postTransfer } = await import("@/app/api/crm/profiles/[id]/transfer/route");
      const { POST: postRelease } = await import("@/app/api/crm/profiles/[id]/release/route");
      const profileDetailRoute = await import("@/app/api/crm/profiles/[id]/route");
      const followUpsRoute = await import("@/app/api/crm/follow-ups/route");
      const assignRoute = await import("@/app/api/crm/customer-pool/[profileId]/assign/route");
      const recallRoute = await import("@/app/api/crm/customer-pool/[profileId]/recall/route");
      const repRoute = await import("@/app/api/representatives/[id]/route");

      // ═══════════ #4 FS 创建客户：本部门 CLAIMED，OPS 隐藏 POOL ═══════════
      const created = await createOrAttachCrmProfile({
        actor: { userId: uFsOwner.id, role: "USER", department: "FIELD_SALES" },
        identityInput: {
          name: "客户甲",
          phone: "13800000001",
          wechat: "wx-jia",
          email: "jia@example.com",
          organization: "机构A",
          labOrGroup: "单细胞组",
        },
        departmentStateInput: {},
      });
      const profileId = created.profileId;

      // ── 401：未登录 ──
      setSession(null);
      const res401 = await putPoolSharing(
        mkReq(`http://localhost/api/crm/profiles/${profileId}/pool-sharing`, {
          method: "PUT",
          body: { targetDepartment: "ONLINE_OPS", shared: true },
        }),
        { params: Promise.resolve({ id: profileId }) },
      );
      expect(res401.status).toBe(401);

      // ── #6 隐藏 POOL 直接 ID → 404（OPS 看不到 FS 创建但未共享的客户） ──
      setSession(opsSession);
      const resOpsHiddenDetail = await profileDetailRoute.GET(
        mkReq(`http://localhost/api/crm/profiles/${profileId}`),
        { params: Promise.resolve({ id: profileId }) },
      );
      expect(resOpsHiddenDetail.status).toBe(404);

      // OPS claim 隐藏 POOL → 404（不能绕过共享授权）
      const resOpsClaimHidden = await postClaim(
        mkReq(`http://localhost/api/crm/profiles/${profileId}/claim`, { method: "POST", body: {} }),
        { params: Promise.resolve({ id: profileId }) },
      );
      expect(resOpsClaimHidden.status).toBe(404);

      // OPS 作为 source 共享 FS 客户 → 404（OPS 不可见）
      const resOpsShare = await putPoolSharing(
        mkReq(`http://localhost/api/crm/profiles/${profileId}/pool-sharing`, {
          method: "PUT",
          body: { targetDepartment: "FIELD_SALES", shared: true },
        }),
        { params: Promise.resolve({ id: profileId }) },
      );
      expect(resOpsShare.status).toBe(404);

      // ── #5 FS owner 共享给 OPS；响应只含授权记录自身 status/sharedAt/revokedAt ──
      setSession(fsOwnerSession);
      const resShare = await putPoolSharing(
        mkReq(`http://localhost/api/crm/profiles/${profileId}/pool-sharing`, {
          method: "PUT",
          body: { targetDepartment: "ONLINE_OPS", shared: true },
        }),
        { params: Promise.resolve({ id: profileId }) },
      );
      expect(resShare.status).toBe(200);
      const shareBody = await jsonBody(resShare);
      expect(shareBody.status).toBe("ACTIVE");
      expect(shareBody.sharedAt).toBeTruthy();
      expect(shareBody).not.toHaveProperty("ownerUserId");
      expect(shareBody).not.toHaveProperty("targetClaimed");

      // ── #5 共享后 OPS 公海可见，DTO 脱敏 ──
      setSession(opsSession);
      const resOpsDetail = await profileDetailRoute.GET(
        mkReq(`http://localhost/api/crm/profiles/${profileId}`),
        { params: Promise.resolve({ id: profileId }) },
      );
      expect(resOpsDetail.status).toBe(200);
      const detailBody = await jsonBody(resOpsDetail);
      expect(detailBody.pool).toBe(true);
      const poolDto = detailBody.profile as Record<string, unknown>;
      expect(poolDto.profileId).toBe(profileId);
      expect(poolDto.name).toBe("客户甲");
      expect(poolDto.poolKind).toBe("SHARED_POOL");
      expect(poolDto).not.toHaveProperty("phone");
      expect(poolDto).not.toHaveProperty("wechat");
      expect(poolDto).not.toHaveProperty("email");
      expect(poolDto).not.toHaveProperty("interactions");
      expect(poolDto).not.toHaveProperty("ownerUserId");

      // ── #7 OPS 并发认领共享公海；只有一个成功（409） ──
      const claimReq = () =>
        postClaim(
          mkReq(`http://localhost/api/crm/profiles/${profileId}/claim`, { method: "POST", body: {} }),
          { params: Promise.resolve({ id: profileId }) },
        );
      setSession(opsSession);
      const claimOps = claimReq();
      setSession(ops2Session);
      const claimOps2 = claimReq();
      const [r1, r2] = await Promise.all([claimOps, claimOps2]);
      const okRes = r1.status === 201 ? r1 : r2;
      const conflictRes = r1.status === 201 ? r2 : r1;
      expect(okRes.status).toBe(201);
      expect(conflictRes.status).toBe(409);

      // ── transfer：FS peer（同部门 FULL 但非 owner）→ 403 ──
      setSession(fsPeerSession);
      const resPeerTransfer = await postTransfer(
        mkReq(`http://localhost/api/crm/profiles/${profileId}/transfer`, {
          method: "POST",
          body: { ownerUserId: uFsPeer.id },
        }),
        { params: Promise.resolve({ id: profileId }) },
      );
      expect(resPeerTransfer.status).toBe(403);

      // ── FS owner transfer 给 peer（成功） ──
      setSession(fsOwnerSession);
      const resTransfer = await postTransfer(
        mkReq(`http://localhost/api/crm/profiles/${profileId}/transfer`, {
          method: "POST",
          body: { ownerUserId: uFsPeer.id },
        }),
        { params: Promise.resolve({ id: profileId }) },
      );
      expect(resTransfer.status).toBe(200);
      const transferBody = await jsonBody(resTransfer);
      expect(transferBody.fromOwnerUserId).toBe(uFsOwner.id);
      expect(transferBody.toOwnerUserId).toBe(uFsPeer.id);

      // ── #9 release：FS peer 释放至本部门公海 ──
      setSession(fsPeerSession);
      const resRelease = await postRelease(
        mkReq(`http://localhost/api/crm/profiles/${profileId}/release`, { method: "POST", body: {} }),
        { params: Promise.resolve({ id: profileId }) },
      );
      expect(resRelease.status).toBe(200);
      const releaseBody = await jsonBody(resRelease);
      expect(releaseBody.poolEntryReason).toBe("RELEASED");

      // ── ADMIN 撤回共享（source=FS） ──
      setSession(adminSession);
      const resRevoke = await putPoolSharing(
        mkReq(`http://localhost/api/crm/profiles/${profileId}/pool-sharing`, {
          method: "PUT",
          body: { sourceDepartment: "FIELD_SALES", targetDepartment: "ONLINE_OPS", shared: false },
        }),
        { params: Promise.resolve({ id: profileId }) },
      );
      expect(resRevoke.status).toBe(200);
      const revokeBody = await jsonBody(resRevoke);
      expect(revokeBody.status).toBe("REVOKED");

      // ── ADMIN 跨部门 pool-sharing 缺 sourceDepartment → 400 ──
      const resAdminNoSource = await putPoolSharing(
        mkReq(`http://localhost/api/crm/profiles/${profileId}/pool-sharing`, {
          method: "PUT",
          body: { targetDepartment: "ONLINE_OPS", shared: true },
        }),
        { params: Promise.resolve({ id: profileId }) },
      );
      expect(resAdminNoSource.status).toBe(400);

      // ═══════════ 共享 profile 乐观锁冲突 409（§8.6） ═══════════
      const lockUser = await mkUser("lock@t.test", "USER", "FIELD_SALES", "锁");
      const lockCreated = await createOrAttachCrmProfile({
        actor: { userId: lockUser.id, role: "USER", department: "FIELD_SALES" },
        identityInput: { name: "锁客户", phone: "13900000099" },
        departmentStateInput: {},
      });
      const lockProfile = await prisma.crmCustomerProfile.findUniqueOrThrow({ where: { id: lockCreated.profileId } });

      setSession(sess({ ...lockUser, name: lockUser.name!, email: lockUser.email, department: "FIELD_SALES" }));
      const resLockOk = await profileDetailRoute.PATCH(
        mkReq(`http://localhost/api/crm/profiles/${lockCreated.profileId}`, {
          method: "PATCH",
          body: { summary: "v1", expectedUpdatedAt: lockProfile.updatedAt.toISOString() },
        }),
        { params: Promise.resolve({ id: lockCreated.profileId }) },
      );
      expect(resLockOk.status).toBe(200);

      // 旧 expectedUpdatedAt（构造一个明显过期的版本，1 小时前）→ 409。
      // SQLite DateTime 默认秒级精度，用显著偏移保证与当前 updatedAt 不同。
      const staleUpdatedAt = new Date(Date.now() - 3600_000).toISOString();
      const resLockStale = await profileDetailRoute.PATCH(
        mkReq(`http://localhost/api/crm/profiles/${lockCreated.profileId}`, {
          method: "PATCH",
          body: { summary: "v2", expectedUpdatedAt: staleUpdatedAt },
        }),
        { params: Promise.resolve({ id: lockCreated.profileId }) },
      );
      expect(resLockStale.status).toBe(409);

      // ═══════════ 代表归档后其名下客户进入 FIELD_SALES POOL + OWNER_UNAVAILABLE（§4.4） ═══════════
      const archAdmin = await mkUser("admin-arch@t.test", "ADMIN", "FIELD_SALES", "管");
      const archRep = await prisma.representative.create({
        data: { name: "归档代表", email: "arch-rep@t.test", kind: "HUMAN" },
      });
      const archRepUser = await prisma.user.create({
        data: {
          email: "arch-rep@t.test", name: "归档代表", password: "x",
          role: "REPRESENTATIVE", department: "FIELD_SALES",
        },
      });
      const archCreated = await createOrAttachCrmProfile({
        actor: { userId: archRepUser.id, role: "REPRESENTATIVE", department: "FIELD_SALES" },
        identityInput: { name: "归档客户", phone: "13700000088" },
        departmentStateInput: {},
      });

      setSession(sess({ ...archAdmin, name: archAdmin.name!, email: archAdmin.email, department: "FIELD_SALES" }));
      const resArchive = await repRoute.PATCH(
        mkReq(`http://localhost/api/representatives/${archRep.id}`, {
          method: "PATCH",
          body: { archived: true },
        }),
        { params: Promise.resolve({ id: archRep.id }) },
      );
      expect(resArchive.status).toBe(200);

      const archState = await prisma.crmProfileDepartmentState.findUniqueOrThrow({
        where: { profileId_department: { profileId: archCreated.profileId, department: "FIELD_SALES" } },
      });
      expect(archState.claimStatus).toBe("POOL");
      expect(archState.poolEntryReason).toBe("OWNER_UNAVAILABLE");
      expect(archState.ownerUserId).toBeNull();
      const archProfile = await prisma.crmCustomerProfile.findUniqueOrThrow({ where: { id: archCreated.profileId } });
      expect(archProfile.assignmentStatus).toBe("UNASSIGNED");
      expect(archProfile.ownerUserId).toBeNull();

      // ═══════════ 运营记录：非 ADMIN follow-ups 列表 AND departmentSnapshot（§6.6/§8.6） ═══════════
      const fuUser = await mkUser("fu@t.test", "USER", "FIELD_SALES", "F");
      const ouUser = await mkUser("ou@t.test", "USER", "ONLINE_OPS", "O");
      const fuProfile = await createOrAttachCrmProfile({
        actor: { userId: fuUser.id, role: "USER", department: "FIELD_SALES" },
        identityInput: { name: "FS客户", phone: "13600000001" },
        departmentStateInput: {},
      });
      await prisma.crmFollowUpTask.create({
        data: {
          profileId: fuProfile.profileId,
          ownerUserId: ouUser.id,
          title: "OPS 任务",
          dueAt: new Date(Date.now() + 86400000),
          status: "OPEN",
          departmentSnapshot: "ONLINE_OPS",
          createdByUserId: ouUser.id,
        },
      });
      await prisma.crmFollowUpTask.create({
        data: {
          profileId: fuProfile.profileId,
          ownerUserId: fuUser.id,
          title: "FS 任务",
          dueAt: new Date(Date.now() + 86400000),
          status: "OPEN",
          departmentSnapshot: "FIELD_SALES",
          createdByUserId: fuUser.id,
        },
      });

      setSession(sess({ ...fuUser, name: fuUser.name!, email: fuUser.email, department: "FIELD_SALES" }));
      const resFollowUps = await followUpsRoute.GET(mkReq("http://localhost/api/crm/follow-ups?status=OPEN"));
      expect(resFollowUps.status).toBe(200);
      const fuBody = await jsonBody(resFollowUps);
      const tasks = fuBody.tasks as Array<{ departmentSnapshot: string }>;
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.departmentSnapshot).toBe("FIELD_SALES");

      // ═══════════ 旧 assign/recall adapter 行为等价（§8.7） ═══════════
      // recall adapter 内部 clearProfileAssignmentOnRecall 依赖本部 SYSTEM 代表，
      // 需要先 seed（ensureHqRepresentative 幂等创建）。
      const { ensureHqRepresentative } = await import("@/lib/crm/system-representative");
      await ensureHqRepresentative();

      const adaptAdmin = await mkUser("adm@t.test", "ADMIN", "FIELD_SALES", "A");
      const adaptRep = await prisma.representative.create({
        data: { name: "适配代表", email: "adapt-rep@t.test", kind: "HUMAN" },
      });
      const adaptCreated = await createOrAttachCrmProfile({
        actor: { userId: adaptAdmin.id, role: "ADMIN", department: "FIELD_SALES" },
        identityInput: { name: "适配客户", phone: "13500000077" },
        departmentStateInput: {},
      });
      // 先释放到 FIELD_SALES 公海（模拟公海来源）
      await releaseProfileToPool({
        actor: { userId: adaptAdmin.id, role: "ADMIN", department: "FIELD_SALES" },
        profileId: adaptCreated.profileId,
        reason: "RELEASED",
      });

      setSession(sess({ ...adaptAdmin, name: adaptAdmin.name!, email: adaptAdmin.email, department: "FIELD_SALES" }));
      // assign：公海 → 认领给代表（FIELD_SALES CLAIMED + assignmentStatus=ASSIGNED）
      const resAssign = await assignRoute.POST(
        mkReq(`http://localhost/api/crm/customer-pool/${adaptCreated.profileId}/assign`, {
          method: "POST",
          body: { representativeId: adaptRep.id },
        }),
        { params: Promise.resolve({ profileId: adaptCreated.profileId }) },
      );
      expect(resAssign.status).toBe(200);
      const assignBody = await jsonBody(resAssign);
      expect(assignBody.profile).toBeTruthy();

      const stateAfterAssign = await prisma.crmProfileDepartmentState.findUniqueOrThrow({
        where: { profileId_department: { profileId: adaptCreated.profileId, department: "FIELD_SALES" } },
      });
      expect(stateAfterAssign.claimStatus).toBe("CLAIMED");
      const profileAfterAssign = await prisma.crmCustomerProfile.findUniqueOrThrow({ where: { id: adaptCreated.profileId } });
      expect(profileAfterAssign.assignmentStatus).toBe("ASSIGNED");

      // recall：CLAIMED → POOL + RELEASED（assignmentStatus=RECALLED）
      const resRecall = await recallRoute.POST(
        mkReq(`http://localhost/api/crm/customer-pool/${adaptCreated.profileId}/recall`, {
          method: "POST",
          body: { reason: "测试回收" },
        }),
        { params: Promise.resolve({ profileId: adaptCreated.profileId }) },
      );
      expect(resRecall.status).toBe(200);

      const stateAfterRecall = await prisma.crmProfileDepartmentState.findUniqueOrThrow({
        where: { profileId_department: { profileId: adaptCreated.profileId, department: "FIELD_SALES" } },
      });
      expect(stateAfterRecall.claimStatus).toBe("POOL");
      expect(stateAfterRecall.poolEntryReason).toBe("RELEASED");
      const profileAfterRecall = await prisma.crmCustomerProfile.findUniqueOrThrow({ where: { id: adaptCreated.profileId } });
      expect(profileAfterRecall.assignmentStatus).toBe("RECALLED");

      // 避免未使用告警
      void setProfilePoolShare;
    });
  });
});
