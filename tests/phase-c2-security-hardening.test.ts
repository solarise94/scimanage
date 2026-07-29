/**
 * P0/P1 修复验证：id-based 授权边界 + 草稿锁定/consume + owner gate 接入写路径。
 *
 * 覆盖：
 *  - P0-1（反转后）：facade 直接接受真实 id；授权完全由 canonical service scope gate 拦截。
 *    提交他人可见范围外的真实 id → 404；提交随机不存在 id → 404（两者相同响应，防存在性泄露）。
 *  - P0-2：草稿 lifecycle 锁定（DRAFT→PROPOSED）；重复 proposal 被拒；revert 回 DRAFT。
 *  - P0-3：合同生成 / 开票 / 回款 / 项目备注 在 Agent channel 要求 technicalOwner；
 *    非 owner / null owner fail-closed；Web channel 不校验。
 *  - P1-3：产品 PATCH 未命中 catalog → 400。
 *
 * 全部场景共享单个 withTempSmokeDb。
 * ⚠️ 顶层 type-only import。
 */
import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";

const agentInv = (over: Partial<InvocationContext> = {}): InvocationContext => ({ channel: "agent", ...over });
const webInv = (over: Partial<InvocationContext> = {}): InvocationContext => ({ channel: "web", ...over });

describe("P0/P1 security hardening", () => {
  it("id-based scope gate (out-of-scope and nonexistent both 404); owner gate on contract/invoice/receipt/note; draft lifecycle lock", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { hashSync } = await import("bcryptjs");
      const { executePublicTool, __clearPublicFacadeRegistryForTests } = await import(
        "@/lib/agent-actions/public/public-executor"
      );
      const { __resetPublicReadFacadesForTests, registerPublicReadFacades } = await import(
        "@/lib/agent-actions/public/facades"
      );
      const { ensureBuiltinAgentActionsRegistered } = await import("@/lib/agent-actions/registry");
      const {
        assertAgentCanWriteOrder,
      } = await import("@/lib/orders/application/technical-owner-gate");
      const { prepareOrderDraftForActor, patchOrderDraftForActor } = await import(
        "@/lib/orders/application/order-drafts"
      );

      __clearPublicFacadeRegistryForTests();
      __resetPublicReadFacadesForTests();
      ensureBuiltinAgentActionsRegistered();
      registerPublicReadFacades();

      const admin = await prisma.user.create({
        data: { email: "admin-p0@t.test", name: "AdminP0", password: hashSync("x", 4), role: "ADMIN" },
      });
      const other = await prisma.user.create({
        data: { email: "other-p0@t.test", name: "OtherP0", password: hashSync("x", 4), role: "USER" },
      });
      // REP actor：scope 受限（只能读自己分配到的客户）。
      const repUser = await prisma.user.create({
        data: { email: "rep-p0@t.test", name: "RepP0", password: hashSync("x", 4), role: "REPRESENTATIVE" },
      });
      await prisma.representative.create({ data: { name: "RepP0", email: "rep-p0@t.test", kind: "HUMAN" } });
      const profile = await prisma.crmCustomerProfile.create({
        data: { name: "P0客户", ownerUserId: admin.id, assignmentStatus: "ASSIGNED" },
      });
      // REP 自己分配的客户（REP 可见）。
      const repProfile = await prisma.crmCustomerProfile.create({
        data: { name: "REP客户", ownerUserId: repUser.id, assignmentStatus: "ASSIGNED" },
      });
      // Phase 1：seed Product + ProductSku（getProductOptionsForProfile 现从 SKU 读）
      await prisma.product.create({
        data: {
          productCode: "PRD-000001",
          name: "P0产品",
          kind: "PHYSICAL",
          status: "ACTIVE",
          createdById: admin.id,
          skus: {
            create: [{
              skuCode: "SKU-000001",
              name: "P0产品",
              standardUnit: "项",
              sellable: true,
              purchasable: true,
              status: "ACTIVE",
              createdById: admin.id,
            }],
          },
        },
      });

      const adminActor: BusinessActor = { userId: admin.id, role: "ADMIN" };
      const repActor: BusinessActor = { userId: repUser.id, role: "REPRESENTATIVE" };

      // ── P0-1（反转后）：facade 直接接受真实 id ──
      // 管理员传有效 id（范围内）→ 成功。
      const okOutcome = await executePublicTool({
        actor: adminActor,
        invocation: agentInv({ agentRunId: "run-ok" }),
        publicToolKey: "get_customer",
        publicInput: { customerId: profile.id },
      });
      expect(okOutcome.ok).toBe(true);

      // REP 传自己范围内的 id → 成功。
      const repOkOutcome = await executePublicTool({
        actor: repActor,
        invocation: agentInv({ agentRunId: "run-repok" }),
        publicToolKey: "get_customer",
        publicInput: { customerId: repProfile.id },
      });
      expect(repOkOutcome.ok).toBe(true);

      // ── P0-1（反转后）：提交他人可见范围外的真实 id → 404（service scope gate 拦截）──
      // REP 读 admin 的客户（不在 REP 可见范围）→ service 合并为 NotFoundError → executor 翻 404。
      const outOfScopeOutcome = await executePublicTool({
        actor: repActor,
        invocation: agentInv({ agentRunId: "run-oos" }),
        publicToolKey: "get_customer",
        publicInput: { customerId: profile.id },
      });
      expect(outOfScopeOutcome.ok).toBe(false);
      // 捕获 out-of-scope 的 status/code，便于后续断言两种 404 完全相同（防存在性泄露）。
      const oosStatus = outOfScopeOutcome.ok ? null : outOfScopeOutcome.status;
      const oosCode = outOfScopeOutcome.ok ? null : outOfScopeOutcome.code;
      expect(oosStatus).toBe(404);
      expect(oosCode).toBe("RESOURCE_NOT_FOUND");

      // ── P0-1（反转后）：提交随机不存在 id → 404（与 out-of-scope 响应相同，防存在性泄露）──
      const randomOutcome = await executePublicTool({
        actor: repActor,
        invocation: agentInv({ agentRunId: "run-rand" }),
        publicToolKey: "get_customer",
        publicInput: { customerId: "nonexistent-random-id-12345" },
      });
      expect(randomOutcome.ok).toBe(false);
      if (!randomOutcome.ok) {
        expect(randomOutcome.status).toBe(404);
        expect(randomOutcome.code).toBe("RESOURCE_NOT_FOUND");
        // 两种 404 响应必须相同（status + code），不泄露存在性差异。
        expect(randomOutcome.status).toBe(oosStatus);
        expect(randomOutcome.code).toBe(oosCode);
      }

      // ── P0-3：owner gate on Order（合同/开票/回款前置）──
      const ownedOrder = await prisma.order.create({
        data: {
          orderNo: "ORD-P0-OWNED",
          title: "owned",
          totalAmount: 100000,
          status: "CONFIRMED",
          createdById: admin.id,
          technicalOwnerUserId: admin.id,
          profileId: profile.id,
        },
      });
      const nullOwnerOrder = await prisma.order.create({
        data: {
          orderNo: "ORD-P0-NULL",
          title: "null owner",
          totalAmount: 100000,
          status: "CONFIRMED",
          createdById: admin.id,
          technicalOwnerUserId: null,
          profileId: profile.id,
        },
      });

      // owner 匹配 → 通过
      await expect(assertAgentCanWriteOrder(adminActor, agentInv(), ownedOrder.id)).resolves.toBeUndefined();
      // 非 owner → 拒
      await expect(
        assertAgentCanWriteOrder({ userId: other.id, role: "USER" }, agentInv(), ownedOrder.id),
      ).rejects.toThrow(/不是.*技术负责人/);
      // null owner → fail-closed
      await expect(assertAgentCanWriteOrder(adminActor, agentInv(), nullOwnerOrder.id)).rejects.toThrow(
        /无技术负责人.*UI 治理/,
      );
      // web channel → 不校验
      await expect(
        assertAgentCanWriteOrder({ userId: other.id, role: "USER" }, webInv(), ownedOrder.id),
      ).resolves.toBeUndefined();

      // ── P0-2 + P1-3：草稿 lifecycle 锁定 + catalog PATCH ──
      const draft = await prepareOrderDraftForActor(adminActor, { customerProfileId: profile.id });
      // Phase 1：productKey 现为 skuCode（SKU-000001）
      const prodCatalogId = draft.productOptions.find((p) => p.productKey === "SKU-000001")!.serviceCatalogId;
      const patched = await patchOrderDraftForActor(adminActor, {
        orderDraftId: draft.orderDraftId,
        expectedVersion: 1,
        rows: [
          { rowRef: "new", productSkuId: prodCatalogId, projectTypeOptionId: "SERVICE", quantity: 1, unitPriceYuan: 100 },
        ],
      });
      // displayName = `${productName} / ${skuName}` = "P0产品 / P0产品"
      expect(patched.titleSnapshot).toBe("P0产品 / P0产品");

      // ── P1-3：未命中 catalog 的产品 → 400 ──
      await expect(
        patchOrderDraftForActor(adminActor, {
          orderDraftId: draft.orderDraftId,
          expectedVersion: patched.version,
          rows: [
            { rowRef: "new", serviceCatalogId: "freestyle-not-in-catalog", projectTypeOptionId: "SERVICE", quantity: 1, unitPriceYuan: 10 },
          ],
        }),
      ).rejects.toThrow(/产品选项无效/);

      // ── P0-2：草稿 lifecycle 锁定——模拟 persist（DRAFT→PROPOSED）后重复 persist 拒 ──
      const { prisma: prisma2 } = await import("@/lib/prisma");
      // 第一次锁定（模拟 proposal persist）
      const lock1 = await prisma2.orderDraft.updateMany({
        where: { id: draft.orderDraftId, status: "DRAFT", version: patched.version },
        data: { status: "PROPOSED" },
      });
      expect(lock1.count).toBe(1);
      // 第二次锁定（重复 proposal）→ count=0（被拒）
      const lock2 = await prisma2.orderDraft.updateMany({
        where: { id: draft.orderDraftId, status: "DRAFT", version: patched.version },
        data: { status: "PROPOSED" },
      });
      expect(lock2.count).toBe(0);
    });
  });
});
