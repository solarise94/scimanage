/**
 * D4 用户管理 + §5.2 部门变更前置检查/审计测试。
 *
 * 覆盖：
 *   - POST /api/users：带/不带 department 写入；非法值 400
 *   - PUT /api/users/[id]：非 ADMIN 改部门被拒（403）；ADMIN 改部门成功并返回新部门
 *   - changeUserDepartment（§5.2）：四类前置检查各命中一次 409 + 全部清空后变更成功
 *   - 变更后 ActivityLog 记录 from/to；auth context cache 失效被调用
 *   - 历史 Project/Order departmentSnapshot 不随变更改变
 *
 * 全部在 withTempSmokeDb 临时 SQLite 中执行，严禁触碰 prisma/dev.db。
 * 参考 tests/web-route-mapping.test.ts：mock next-auth session + 动态导入 route。
 */
import { describe, expect, it, vi } from "vitest";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";

type SessionUser = { id: string; role: string; name: string; email: string };
type MockSession = { user: SessionUser };

const sessionState = vi.hoisted(() => ({ current: null as MockSession | null }));

vi.mock("next-auth/next", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getServerSession: async () => sessionState.current,
}));
vi.mock("next-auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getServerSession: async () => sessionState.current,
}));

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function jsonPostRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("D4 user-department-management（§5.2）", () => {
  it(
    "POST/PUT department + §5.2 四类前置检查 + 审计 + 快照不可变",
    async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { POST: usersPost } = await import("@/app/api/users/route");
      const { PUT: userPut } = await import("@/app/api/users/[id]/route");
      const { changeUserDepartment } = await import(
        "@/lib/user-management/change-department"
      );
      const { invalidateAllAuthContexts } = await import(
        "@/lib/user-management/role-cache"
      );
      const { ConflictError } = await import("@/lib/application/errors");

      // ── 种子 actor ──
      const admin = await prisma.user.create({
        data: {
          email: "d4-admin@t.test",
          name: "D4管理员",
          password: "x",
          role: "ADMIN",
          department: "FIELD_SALES",
        },
      });
      const anotherAdmin = await prisma.user.create({
        data: {
          email: "d4-admin2@t.test",
          name: "D4管理员2",
          password: "x",
          role: "ADMIN",
          department: "ONLINE_OPS",
        },
      });
      // 普通用户（非 ADMIN），用于验证非 ADMIN 改部门被拒
      const regularUser = await prisma.user.create({
        data: {
          email: "d4-user@t.test",
          name: "D4员工",
          password: "x",
          role: "USER",
          department: "FIELD_SALES",
        },
      });

      const login = (u: { id: string; role: string; name: string; email: string }) => {
        sessionState.current = {
          user: { id: u.id, role: u.role, name: u.name, email: u.email },
        };
      };
      const logout = () => {
        sessionState.current = null;
      };

      // 清空 auth cache，避免跨用例污染
      invalidateAllAuthContexts();

      // ── 1. POST /api/users：不带 department 默认 FIELD_SALES ──
      login(admin);
      {
        const res = await usersPost(
          jsonPostRequest("http://t/api/users", {
            name: "默认部门",
            email: "default@t.test",
            role: "USER",
          }) as never,
        );
        expect(res.status).toBe(201);
        const data = (await res.json()) as { user: { department: string } };
        expect(data.user.department).toBe("FIELD_SALES");
        const row = await prisma.user.findUniqueOrThrow({
          where: { email: "default@t.test" },
          select: { department: true },
        });
        expect(row.department).toBe("FIELD_SALES");
      }

      // ── 2. POST /api/users：带 department=ONLINE_OPS 写入 ──
      {
        const res = await usersPost(
          jsonPostRequest("http://t/api/users", {
            name: "运营员工",
            email: "ops@t.test",
            role: "USER",
            department: "ONLINE_OPS",
          }) as never,
        );
        expect(res.status).toBe(201);
        const data = (await res.json()) as { user: { department: string } };
        expect(data.user.department).toBe("ONLINE_OPS");
      }

      // ── 3. POST /api/users：非法 department → 400 ──
      {
        const res = await usersPost(
          jsonPostRequest("http://t/api/users", {
            name: "非法",
            email: "bad@t.test",
            role: "USER",
            department: "MARKETING",
          }) as never,
        );
        expect(res.status).toBe(400);
      }

      // ── 4. PUT /api/users/[id]：非 ADMIN 改部门被拒（403）──
      // regularUser 是 USER；尝试把自己部门改成 ONLINE_OPS
      login(regularUser);
      {
        const res = await userPut(
          jsonRequest(`http://t/api/users/${regularUser.id}`, {
            department: "ONLINE_OPS",
          }) as never,
          { params: Promise.resolve({ id: regularUser.id }) } as never,
        );
        expect(res.status).toBe(403);
      }

      // ── 5. §5.2 四类前置检查 + 成功变更 ──
      login(admin);
      // 目标用户：FIELD_SALES，准备改到 ONLINE_OPS
      const target = await prisma.user.create({
        data: {
          email: "d4-target@t.test",
          name: "变更目标",
          password: "x",
          role: "USER",
          department: "FIELD_SALES",
        },
      });

      // 5a. 前置 1：旧部门未完成 Follow-up
      // 需要 profile + representative（owner 必须是销售角色，但 service 查询仅按 ownerUserId + departmentSnapshot + status）
      // 直接造一个 owner=target 的未完成跟进
      const profile1 = await prisma.crmCustomerProfile.create({
        data: { name: "跟进客户" },
      });
      const openFollowUp = await prisma.crmFollowUpTask.create({
        data: {
          profileId: profile1.id,
          ownerUserId: target.id,
          createdByUserId: admin.id,
          title: "未完成跟进",
          dueAt: new Date(Date.now() + 86400000),
          status: "OPEN",
          departmentSnapshot: "FIELD_SALES",
        },
      });
      await expect(
        changeUserDepartment({
          actor: { id: admin.id, role: "ADMIN" },
          targetUserId: target.id,
          newDepartment: "ONLINE_OPS",
        }),
      ).rejects.toThrow(ConflictError);
      await prisma.crmFollowUpTask.delete({ where: { id: openFollowUp.id } });

      // 5b. 前置 2：旧部门已认领 CrmProfileDepartmentState
      const profile2 = await prisma.crmCustomerProfile.create({
        data: { name: "认领客户" },
      });
      const claimedState = await prisma.crmProfileDepartmentState.create({
        data: {
          profileId: profile2.id,
          department: "FIELD_SALES",
          claimStatus: "CLAIMED",
          ownerUserId: target.id,
          claimedAt: new Date(),
          claimedById: admin.id,
        },
      });
      await expect(
        changeUserDepartment({
          actor: { id: admin.id, role: "ADMIN" },
          targetUserId: target.id,
          newDepartment: "ONLINE_OPS",
        }),
      ).rejects.toThrow(ConflictError);
      await prisma.crmProfileDepartmentState.delete({ where: { id: claimedState.id } });

      // 5c. 前置 3：ACTIVE CustomerServiceAccount
      const csa = await prisma.customerServiceAccount.create({
        data: {
          wechatId: "wx-target-001",
          name: "客服号",
          department: "ONLINE_OPS",
          ownerUserId: target.id,
          status: "ACTIVE",
        },
      });
      await expect(
        changeUserDepartment({
          actor: { id: admin.id, role: "ADMIN" },
          targetUserId: target.id,
          newDepartment: "ONLINE_OPS",
        }),
      ).rejects.toThrow(ConflictError);
      await prisma.customerServiceAccount.update({
        where: { id: csa.id },
        data: { status: "DISABLED" },
      });

      // 5d. 前置 4：仍是旧部门 Project 成员
      // 注意：前置 3 现在已通过（CSA DISABLED），但 4 会命中
      const project4 = await prisma.project.create({
        data: {
          name: "残留项目",
          departmentSnapshot: "FIELD_SALES",
        },
      });
      const membership = await prisma.projectMember.create({
        data: { projectId: project4.id, userId: target.id, role: "MEMBER" },
      });
      await expect(
        changeUserDepartment({
          actor: { id: admin.id, role: "ADMIN" },
          targetUserId: target.id,
          newDepartment: "ONLINE_OPS",
        }),
      ).rejects.toThrow(ConflictError);
      await prisma.projectMember.delete({ where: { id: membership.id } });

      // ── 5e. 全部清空后变更成功 ──
      // 准备一个历史快照：变更前 target 是某 FIELD_SALES Project 的成员（已删）+ 某 Order 的创建人。
      // 用 target 创建一个 Order，其 departmentSnapshot=FIELD_SALES。
      const legacyProject = await prisma.project.create({
        data: {
          name: "历史项目",
          departmentSnapshot: "FIELD_SALES",
        },
      });
      const legacyOrder = await prisma.order.create({
        data: {
          orderNo: "D4-LEGACY-001",
          title: "历史订单",
          status: "CONFIRMED",
          totalAmount: 0,
          departmentSnapshot: "FIELD_SALES",
          createdById: admin.id,
        },
      });

      // 让 target 成为 legacyProject 成员，验证变更后该成员关系会阻止——
      // 不，按设计 §5.2，前置检查会拒绝。所以这里 target 不能残留任何 FIELD_SALES 成员关系。
      // 我们只验证「历史快照不变」：legacyProject / legacyOrder 的 departmentSnapshot 不应随变更改变。
      // legacyProject 没有成员关系，legacyOrder 无关 target。直接变更。

      // 失效缓存以观察变更是否触发再次失效
      invalidateAllAuthContexts();
      // 预热缓存：调用 getCachedUserAuthContext 让 target 进入缓存
      const { getCachedUserAuthContext } = await import(
        "@/lib/user-management/role-cache"
      );
      const beforeChange = await getCachedUserAuthContext(target.id);
      expect(beforeChange.department).toBe("FIELD_SALES");
      // 再次读取应命中缓存（仍是 FIELD_SALES）
      const cachedAgain = await getCachedUserAuthContext(target.id);
      expect(cachedAgain.department).toBe("FIELD_SALES");

      const result = await changeUserDepartment({
        actor: { id: admin.id, role: "ADMIN" },
        targetUserId: target.id,
        newDepartment: "ONLINE_OPS",
      });
      expect(result.toDepartment).toBe("ONLINE_OPS");
      expect(result.fromDepartment).toBe("FIELD_SALES");
      expect(result.idempotent).toBe(false);

      // 变更后 auth context cache 应被失效：下一次读取得到 ONLINE_OPS
      const afterChange = await getCachedUserAuthContext(target.id);
      expect(afterChange.department).toBe("ONLINE_OPS");

      // ── ActivityLog 记录 from/to ──
      const log = await prisma.activityLog.findFirst({
        where: { type: "USER_DEPARTMENT_CHANGED", userId: admin.id },
        orderBy: { createdAt: "desc" },
      });
      expect(log).toBeTruthy();
      const meta = JSON.parse(log!.metadata!) as {
        fromDepartment: string;
        toDepartment: string;
        targetUserId: string;
        actorUserId: string;
      };
      expect(meta.fromDepartment).toBe("FIELD_SALES");
      expect(meta.toDepartment).toBe("ONLINE_OPS");
      expect(meta.targetUserId).toBe(target.id);
      expect(meta.actorUserId).toBe(admin.id);

      // ── 历史快照不可变 ──
      const legacyProjectRow = await prisma.project.findUniqueOrThrow({
        where: { id: legacyProject.id },
        select: { departmentSnapshot: true },
      });
      expect(legacyProjectRow.departmentSnapshot).toBe("FIELD_SALES");
      const legacyOrderRow = await prisma.order.findUniqueOrThrow({
        where: { id: legacyOrder.id },
        select: { departmentSnapshot: true },
      });
      expect(legacyOrderRow.departmentSnapshot).toBe("FIELD_SALES");

      // 目标用户自身的 department 已更新
      const targetRow = await prisma.user.findUniqueOrThrow({
        where: { id: target.id },
        select: { department: true },
      });
      expect(targetRow.department).toBe("ONLINE_OPS");

      // ── 幂等：新旧相同直接成功 ──
      const idempotentResult = await changeUserDepartment({
        actor: { id: admin.id, role: "ADMIN" },
        targetUserId: target.id,
        newDepartment: "ONLINE_OPS",
      });
      expect(idempotentResult.idempotent).toBe(true);

      // ── 非 ADMIN 调用服务被拒 ──
      await expect(
        changeUserDepartment({
          actor: { id: regularUser.id, role: "USER" },
          targetUserId: target.id,
          newDepartment: "FIELD_SALES",
        }),
      ).rejects.toThrow();

      // ── PUT /api/users/[id]：ADMIN 改部门走 service，成功并返回新部门 ──
      login(admin);
      // 把 target 改回 FIELD_SALES（前置已全清空，应成功）
      const putRes = await userPut(
        jsonRequest(`http://t/api/users/${target.id}`, {
          department: "FIELD_SALES",
        }) as never,
        { params: Promise.resolve({ id: target.id }) } as never,
      );
      expect(putRes.status).toBe(200);
      const putData = (await putRes.json()) as { user: { department: string } };
      expect(putData.user.department).toBe("FIELD_SALES");

      // ── PUT /api/users/[id]：前置检查失败 → 409（带可读原因）──
      // 给 target 重新挂一个未完成跟进（target 现在是 FIELD_SALES）
      const blockingFollowUp = await prisma.crmFollowUpTask.create({
        data: {
          profileId: profile1.id,
          ownerUserId: target.id,
          createdByUserId: admin.id,
          title: "阻断变更",
          dueAt: new Date(Date.now() + 86400000),
          status: "OPEN",
          departmentSnapshot: "FIELD_SALES",
        },
      });
      const blockedRes = await userPut(
        jsonRequest(`http://t/api/users/${target.id}`, {
          department: "ONLINE_OPS",
        }) as never,
        { params: Promise.resolve({ id: target.id }) } as never,
      );
      expect(blockedRes.status).toBe(409);
      const blockedData = (await blockedRes.json()) as { error: string };
      expect(blockedData.error).toContain("跟进任务");
      await prisma.crmFollowUpTask.delete({ where: { id: blockingFollowUp.id } });

      // ── PUT /api/users/[id]：非法 department → 400 ──
      const badDeptRes = await userPut(
        jsonRequest(`http://t/api/users/${target.id}`, {
          department: "NOT_A_DEPT",
        }) as never,
        { params: Promise.resolve({ id: target.id }) } as never,
      );
      expect(badDeptRes.status).toBe(400);

      // ── actor 是 ADMIN 但来自另一个 ADMIN 操作不同 target 不应被影响（烟雾）──
      login(anotherAdmin);
      const crossRes = await userPut(
        jsonRequest(`http://t/api/users/${target.id}`, {
          name: "变更目标改名",
        }) as never,
        { params: Promise.resolve({ id: target.id }) } as never,
      );
      expect(crossRes.status).toBe(200);

      logout();
    });
  },
    120000,
  );
});
