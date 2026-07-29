/**
 * Phase C tests: order draft + GenUI PATCH + propose facades + follow-up default date。
 *
 * 覆盖（修正 6/7）：
 *  - prepare_order 创建 OrderDraft + 返回 GenUI 选项；不接收 title/lines；
 *  - PATCH 多行 → title=`首行 等 N 项`；单行=产品名；无行=needs_selection；
 *  - PATCH 乐观锁：expectedVersion 不匹配 → 409；
 *  - PATCH 字段白名单：拒绝非允许字段；
 *  - propose_follow_up 未传 dueAt → 服务端默认下周五 18:00 Asia/Shanghai。
 *
 * 全部场景共享单个 withTempSmokeDb。
 * ⚠️ 顶层 type-only import（facades 经 registry→actions→prisma，必须动态 import）。
 */
import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";
import type { PrismaClient } from "@prisma/client";
import type { BusinessActor } from "@/lib/application/actor";

/**
 * P1-3 适配：channel="agent" 的 proposal 创建现在必须消费 AgentUserConfirmationEvent
 * （P1-3 allowProposal 门；门行为由 tests/allow-proposal-events.test.ts 独立覆盖）。
 * 本测试保留 agent channel（与生产路径一致），在创建 proposal 前为对应 confirm actionKey 颁发事件。
 */
let p13EventSeed = 0;
function seedConfirmationEvent(
  prisma: PrismaClient,
  opts: { actorUserId: string; agentRunId: string; targetIntent: string },
): Promise<unknown> {
  p13EventSeed += 1;
  return prisma.agentUserConfirmationEvent.create({
    data: {
      actorUserId: opts.actorUserId,
      agentRunId: opts.agentRunId,
      targetIntent: opts.targetIntent,
      action: "create_proposal",
      idempotencyKey: `p13-seed-${process.pid}-${p13EventSeed}-${Date.now()}`,
    },
  });
}

describe("Phase C — order draft + PATCH + propose facades", () => {
  it("prepare_order, multi-line title, optimistic lock, field whitelist, follow-up default date", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { hashSync } = await import("bcryptjs");
      const { ensureBuiltinAgentActionsRegistered } = await import("@/lib/agent-actions/registry");
      const { patchOrderDraftForActor, getOrderDraftForActor } = await import(
        "@/lib/orders/application/order-drafts"
      );
      const { executePublicTool, __clearPublicFacadeRegistryForTests } = await import(
        "@/lib/agent-actions/public/public-executor"
      );
      const { __resetPublicReadFacadesForTests, registerPublicReadFacades } = await import(
        "@/lib/agent-actions/public/facades"
      );

      const admin = await prisma.user.create({
        data: { email: "admin-c@t.test", name: "AdminC", password: hashSync("x", 4), role: "ADMIN" },
      });
      const profile = await prisma.crmCustomerProfile.create({
        data: { name: "C客户", ownerUserId: admin.id, assignmentStatus: "ASSIGNED" },
      });
      // Phase 1：seed 产品目录（Product + ProductSku），使 PATCH 可选产品。
      // getProductOptionsForProfile 现从 active+sellable SKU 读取，不再读 ServiceCatalog。
      const prodA = await prisma.product.create({
        data: {
          productCode: "PRD-000001",
          name: "产品A",
          kind: "PHYSICAL",
          status: "ACTIVE",
          createdById: admin.id,
          skus: {
            create: [{
              skuCode: "SKU-000001",
              name: "产品A",
              standardUnit: "项",
              sellable: true,
              purchasable: true,
              status: "ACTIVE",
              createdById: admin.id,
            }],
          },
        },
        include: { skus: true },
      });
      const prodB = await prisma.product.create({
        data: {
          productCode: "PRD-000002",
          name: "产品B",
          kind: "PHYSICAL",
          status: "ACTIVE",
          createdById: admin.id,
          skus: {
            create: [{
              skuCode: "SKU-000002",
              name: "产品B",
              standardUnit: "项",
              sellable: true,
              purchasable: true,
              status: "ACTIVE",
              createdById: admin.id,
            }],
          },
        },
        include: { skus: true },
      });
      const skuA = prodA.skus[0];
      const skuB = prodB.skus[0];
      ensureBuiltinAgentActionsRegistered();
      __clearPublicFacadeRegistryForTests();
      __resetPublicReadFacadesForTests();
      registerPublicReadFacades();

      const actor: BusinessActor = { userId: admin.id, role: "ADMIN" };

      // ── prepare_order（直传真实 customerId；ref 体系已删）──
      // P1-3 适配：保留 agent channel（与生产路径一致），创建 proposal 前为对应
      // confirm actionKey 颁发 AgentUserConfirmationEvent（门由 allow-proposal-events.test.ts 覆盖）。
      const prepareOutcome = await executePublicTool({
        actor,
        invocation: { channel: "agent", agentRunId: "run-c" },
        publicToolKey: "prepare_order",
        publicInput: { customerId: profile.id },
      });
      expect(prepareOutcome.ok).toBe(true);
      if (!prepareOutcome.ok) return;
      const draftResult = prepareOutcome.result.modelFacing as {
        orderDraftId: string;
        version: number;
        needsSelection: boolean;
        productOptions: Array<{ serviceCatalogId: string; productKey: string; displayName: string }>;
        projectTypeOptions: Array<{ projectTypeOptionId: string }>;
      };
      expect(draftResult.version).toBe(1);
      expect(draftResult.needsSelection).toBe(true);
      expect(draftResult.projectTypeOptions.length).toBeGreaterThan(0);
      expect(draftResult.productOptions.length).toBe(2);
      // serviceCatalogId（兼容字段名）现在等于真实 productSkuId。
      expect(draftResult.productOptions.map((p) => p.serviceCatalogId).sort()).toEqual(
        [skuA.id, skuB.id].sort(),
      );

      // ── PATCH：多行 → title=`首行 等 N 项` ──
      // 用 prepare_order 返回的真实 serviceCatalogId（直接查 DB 校验）。
      const draftRow = await prisma.orderDraft.findFirst({
        where: { ownerUserId: admin.id },
        orderBy: { createdAt: "desc" },
      });
      expect(draftRow).toBeTruthy();
      const draftId = draftRow!.id;

      // 多行（用真实 productSkuId；兼容 legacy serviceCatalogId 字段名）
      const multiPatch = await patchOrderDraftForActor(actor, {
        orderDraftId: draftId,
        expectedVersion: 1,
        rows: [
          { rowRef: "new", productSkuId: skuA.id, projectTypeOptionId: "SERVICE", quantity: 2, unitPriceYuan: 100 },
          { rowRef: "new", productSkuId: skuB.id, projectTypeOptionId: "REAGENT", quantity: 1, unitPriceYuan: 50 },
        ],
      });
      // displayName 现为 `${productName} / ${skuName}` = "产品A / 产品A"
      expect(multiPatch.titleSnapshot).toBe("产品A / 产品A 等 2 项");
      expect(multiPatch.version).toBe(2);
      expect(multiPatch.needsSelection).toBe(false);

      // 单行
      const singlePatch = await patchOrderDraftForActor(actor, {
        orderDraftId: draftId,
        expectedVersion: 2,
        rows: [
          { rowRef: "new", productSkuId: skuA.id, projectTypeOptionId: "SEQUENCING", quantity: 3, unitPriceYuan: 200 },
        ],
      });
      expect(singlePatch.titleSnapshot).toBe("产品A / 产品A");
      expect(singlePatch.version).toBe(3);

      // ── 乐观锁：expectedVersion 不匹配 → 抛错 ──
      await expect(
        patchOrderDraftForActor(actor, {
          orderDraftId: draftId,
          expectedVersion: 1, // 旧版本
          rows: [],
        }),
      ).rejects.toThrow(/版本不匹配/);

      // ── 无行 → needsSelection ──
      const emptyPatch = await patchOrderDraftForActor(actor, {
        orderDraftId: draftId,
        expectedVersion: 3,
        rows: [],
      });
      expect(emptyPatch.titleSnapshot).toBeNull();
      expect(emptyPatch.needsSelection).toBe(true);

      // ── P2：拒绝自由文本 / 不在 active catalog 的 id（必须 prepare_order 颁发的 serviceCatalogId）──
      await expect(
        patchOrderDraftForActor(actor, {
          orderDraftId: draftId,
          expectedVersion: 4,
          rows: [
            { rowRef: "new", serviceCatalogId: "PROD-A", projectTypeOptionId: "SERVICE", quantity: 1, unitPriceYuan: 10 },
          ],
        }),
      ).rejects.toThrow(/产品选项无效/);

      // ── P1-3：未命中 catalog 的产品 → 400（禁止自由文本产品）──
      await expect(
        patchOrderDraftForActor(actor, {
          orderDraftId: draftId,
          expectedVersion: 4,
          rows: [
            { rowRef: "new", serviceCatalogId: "freestyle-product-not-in-catalog", projectTypeOptionId: "SERVICE", quantity: 1, unitPriceYuan: 10 },
          ],
        }),
      ).rejects.toThrow(/产品选项无效/);

      // ── 字段白名单：无效项目类型 ──
      await expect(
        patchOrderDraftForActor(actor, {
          orderDraftId: draftId,
          expectedVersion: 4,
          rows: [
            { rowRef: "new", productSkuId: skuA.id, projectTypeOptionId: "INVALID_TYPE", quantity: 1, unitPriceYuan: 10 },
          ],
        }),
      ).rejects.toThrow(/无效项目类型/);

      await expect(
        patchOrderDraftForActor(actor, {
          orderDraftId: draftId,
          expectedVersion: 4,
          rows: [
            { rowRef: "new", productSkuId: skuA.id, projectTypeOptionId: "SERVICE", quantity: 0, unitPriceYuan: 10 },
          ],
        }),
      ).rejects.toThrow(/数量/);

      // ── getOrderDraftForActor：他人草稿拒 ──
      const other = await prisma.user.create({
        data: { email: "other-c@t.test", name: "Other", password: hashSync("x", 4), role: "USER" },
      });
      await expect(getOrderDraftForActor({ userId: other.id, role: "USER" }, draftId)).rejects.toThrow(/无权/);

      // ── P2：过期草稿不可 PATCH / 读取（标 EXPIRED）──
      await prisma.orderDraft.update({
        where: { id: draftId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await expect(
        patchOrderDraftForActor(actor, {
          orderDraftId: draftId,
          expectedVersion: 4,
          rows: [],
        }),
      ).rejects.toThrow(/已过期/);
      const expired = await prisma.orderDraft.findUnique({ where: { id: draftId } });
      expect(expired?.status).toBe("EXPIRED");
      await expect(getOrderDraftForActor(actor, draftId)).rejects.toThrow(/已过期/);

      // ── propose_follow_up 未传 dueAt → 服务端默认（ISO，周五 18:00 附近）──
      // 直传真实 customerId（ref 体系已删）。
      // P1-3 门：先为 crm.create_followup_task 颁发事件（agent channel 创建 proposal 必须消费）。
      await seedConfirmationEvent(prisma, {
        actorUserId: admin.id,
        agentRunId: "run-fu",
        targetIntent: "crm.create_followup_task",
      });
      const fuOutcome = await executePublicTool({
        actor,
        invocation: { channel: "agent", agentRunId: "run-fu" },
        publicToolKey: "propose_follow_up",
        publicInput: { customerId: profile.id, title: "跟进任务" },
      });
      // propose_follow_up 调 crm.create_followup_task（confirm action）→ proposal 模式
      expect(fuOutcome.ok).toBe(true);
      if (!fuOutcome.ok) return;
      const facing = fuOutcome.result.modelFacing as {
        dueAt?: string;
        dueAtIsDefault?: boolean;
        proposal?: { id?: string };
      };
      expect(facing.dueAtIsDefault).toBe(true);
      // 默认 dueAt 应是周五（getUTCDay===5 在 Asia/Shanghai 18:00 = UTC 10:00 周五）
      const due = new Date(facing.dueAt!);
      // Asia/Shanghai +8 → UTC 周五 18:00 = UTC 10:00；UTC 10:00 仍是周五
      expect(due.getUTCDay()).toBe(5);
      expect(due.getUTCHours()).toBe(10); // 18 - 8

      // ── P1：publicToolKey 持久化到 AgentProposal，confirm/reject 审计可复原 ──
      const proposalId = facing.proposal?.id;
      expect(typeof proposalId).toBe("string");
      const stored = await prisma.agentProposal.findUnique({ where: { id: proposalId! } });
      expect(stored?.publicToolKey).toBe("propose_follow_up");
      const proposedLog = await prisma.agentActionLog.findFirst({
        where: { proposalId: proposalId!, status: "PROPOSED" },
      });
      expect(proposedLog?.publicToolKey).toBe("propose_follow_up");

      const { confirmAgentProposal, rejectAgentProposal } = await import(
        "@/lib/agent-actions/proposals"
      );
      await confirmAgentProposal(
        { actor, invocation: { channel: "agent", agentRunId: "run-fu" } },
        proposalId!,
      );
      const confirmedLog = await prisma.agentActionLog.findFirst({
        where: { proposalId: proposalId!, status: "CONFIRMED_EXECUTED" },
      });
      expect(confirmedLog?.publicToolKey).toBe("propose_follow_up");

      // reject 路径：再建一张 proposal 并拒绝（同 run，复用 customerId）
      // P1-3 门：上一张已 confirm（事件已消费），再建需重新颁发事件。
      await seedConfirmationEvent(prisma, {
        actorUserId: admin.id,
        agentRunId: "run-fu",
        targetIntent: "crm.create_followup_task",
      });
      const fu2 = await executePublicTool({
        actor,
        invocation: { channel: "agent", agentRunId: "run-fu" },
        publicToolKey: "propose_follow_up",
        publicInput: { customerId: profile.id, title: "跟进任务2" },
      });
      expect(fu2.ok).toBe(true);
      if (!fu2.ok) {
        throw new Error(`second propose_follow_up failed: ${JSON.stringify(fu2)}`);
      }
      const fu2Facing = fu2.result.modelFacing as { proposal?: { id?: string } };
      const rejectId = fu2Facing.proposal?.id;
      if (!rejectId) throw new Error("second propose_follow_up produced no proposal id");
      await rejectAgentProposal(
        { actor, invocation: { channel: "web" } },
        rejectId,
      );
      const rejectedLog = await prisma.agentActionLog.findFirst({
        where: { proposalId: rejectId, status: "REJECTED" },
      });
      expect(rejectedLog?.publicToolKey).toBe("propose_follow_up");
    });
  });
});
