/**
 * 业务确认额（business recognition）针对关闭订单的回归测试。
 *
 * 背景：getBusinessRecognitionEvents 此前把 CLOSED 也纳入订单查询，且后续不做
 * 状态复核，导致普通关闭的服务单仍会生成 30%（/70%）确认事件，虚增代表业绩。
 * 订单页顶部 KPI（/api/orders/stats）走 getEffectiveOrderWhere 已正确排除普通
 * CLOSED，但 CRM「确认业务额」走另一套逻辑，存在口径漂移。
 *
 * 修复目标（与 getEffectiveOrderWhere 对齐）：
 *   CONFIRMED + DELIVERED（活跃确认态）∪ CLOSED 且 accrualReversalOfId 非空
 *   （计提冲回影子订单，负向金额需进聚合）。普通 CLOSED 不再产生事件。
 *   并排除 ACCRUAL_REVERSAL 来源影子单（财务冲正，非业务订单）。
 *
 * 全部场景共享单个 withTempSmokeDb 临时库（与 order-receivables-query-parity
 * 惯例一致）。⚠️ 顶层只允许 type-only import；业务模块必须 dynamic-import 进回调。
 */
import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";

describe("业务确认额（business recognition）—— CLOSED 订单口径", () => {
  it("普通 CLOSED 服务单/产品单不计入；CONFIRMED/DELIVERED 仍计入；计提冲回 CLOSED 仍进入聚合", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { hashSync } = await import("bcryptjs");
      const {
        getBusinessRecognitionEvents,
        aggregateRecognitionEventsByProfile,
      } = await import("@/lib/finance/business-recognition");

      const admin = await prisma.user.create({
        data: { email: "admin-br@t.test", name: "Admin", password: hashSync("x", 4), role: "ADMIN" },
      });

      const profile = await prisma.crmCustomerProfile.create({
        data: { name: "客户A", ownerUserId: admin.id, assignmentStatus: "ASSIGNED" },
      });

      // 区间：足够宽以容纳所有订单（用 fixed 时间避免 setSystemTime 干扰其它测试）。
      const periodStart = new Date("2026-01-01T00:00:00Z");
      const periodEnd = new Date("2026-12-31T23:59:59Z");

      async function makeOrder(opts: {
        orderNo: string;
        amount: number;
        category: string;
        status: string;
        source?: string;
        accrualReversalOfId?: string | null;
        orderedAt?: Date;
      }) {
        return prisma.order.create({
          data: {
            orderNo: opts.orderNo,
            title: `订单 ${opts.orderNo}`,
            totalAmount: opts.amount,
            category: opts.category,
            status: opts.status,
            source: opts.source ?? "MANUAL",
            profileId: profile.id,
            createdById: admin.id,
            accrualReversalOfId: opts.accrualReversalOfId ?? null,
            // 用 orderedAt 固定下单日期，确保落在 [periodStart, periodEnd] 内。
            orderedAt: opts.orderedAt ?? new Date("2026-06-01T00:00:00Z"),
            // 服务/产品 standalone（无项目链接 → AUTO 解析为 STANDALONE）
            financeTreatment: "STANDALONE",
          },
        });
      }

      // —— 场景数据 ——
      // 1. 普通关闭服务单：BUG 触发对象，修复后不应生成任何事件。
      //    金额 ¥3,800,000 = 380,000,000 分（30% = 114,000,000 分，曾错误计入）。
      const closedService = await makeOrder({
        orderNo: "ORD-CLOSED-SERVICE",
        amount: 380_000_000,
        category: "SERVICE",
        status: "CLOSED",
      });

      // 2. 普通关闭产品单：同样不应计入（产品 100%）。
      const closedProduct = await makeOrder({
        orderNo: "ORD-CLOSED-PRODUCT",
        amount: 1_000_000,
        category: "PRODUCT",
        status: "CLOSED",
      });

      // 3. 已确认服务单：保留 30% 事件 = ¥1,000,000 * 30% = 300,000 分。
      const confirmedService = await makeOrder({
        orderNo: "ORD-CONFIRMED-SERVICE",
        amount: 1_000_000,
        category: "SERVICE",
        status: "CONFIRMED",
      });

      // 4. 已交付服务单：30% + 70% = 100% = ¥2,000,000。
      const delivered = await makeOrder({
        orderNo: "ORD-DELIVERED-SERVICE",
        amount: 2_000_000,
        category: "SERVICE",
        status: "DELIVERED",
      });
      // 为交付单补一条 DELIVERED 状态历史，触发 70% 事件。
      await prisma.orderStatusHistory.create({
        data: {
          orderId: delivered.id,
          oldStatus: "CONFIRMED",
          newStatus: "DELIVERED",
          createdById: admin.id,
          createdAt: new Date("2026-06-15T00:00:00Z"),
        },
      });

      // 5. 计提冲回影子订单（CLOSED + accrualReversalOfId 非空）：应进入聚合
      //    （与 getEffectiveOrderWhere 口径一致，负向金额需参与对冲）。
      //    先建一个被冲回的源单（CONFIRMED），再建指向它的冲回影子单。
      const source = await makeOrder({
        orderNo: "ORD-SOURCE",
        amount: 5_000_000,
        category: "SERVICE",
        status: "CONFIRMED",
      });
      const reversal = await prisma.order.create({
        data: {
          orderNo: "ORD-ACCRUAL-REVERSAL",
          title: "计提冲回影子单",
          totalAmount: -1_500_000, // 负值冲回（30% 部分）
          category: "SERVICE",
          status: "CLOSED",
          source: "ACCRUAL_REVERSAL",
          profileId: profile.id,
          createdById: admin.id,
          accrualReversalOfId: source.id,
          orderedAt: new Date("2026-06-20T00:00:00Z"),
          financeTreatment: "STANDALONE",
        },
      });

      // —— 执行 ——
      const events = await getBusinessRecognitionEvents({
        profileIds: [profile.id],
        periodStart,
        periodEnd,
      });

      // 断言：普通 CLOSED（#1, #2）零事件。
      const closedServiceEvents = events.filter((e) => e.orderId === closedService.id);
      expect(closedServiceEvents, "普通 CLOSED 服务单不应生成确认事件").toHaveLength(0);

      const closedProductEvents = events.filter((e) => e.orderId === closedProduct.id);
      expect(closedProductEvents, "普通 CLOSED 产品单不应生成确认事件").toHaveLength(0);

      // 断言：ACCRUAL_REVERSAL 来源影子单被排除（即便 accrualReversalOfId 非空，
      // 因为它是财务冲正而非业务订单；source 过滤先于 status 生效）。
      const reversalEvents = events.filter((e) => e.orderId === reversal.id);
      expect(reversalEvents, "ACCRUAL_REVERSAL 影子单不应计入代表业绩").toHaveLength(0);

      // 断言：CONFIRMED 服务单（#3）只生成 30% 事件。
      const confirmedEvents = events.filter((e) => e.orderId === confirmedService.id);
      expect(confirmedEvents).toHaveLength(1);
      expect(confirmedEvents[0].phase).toBe("SERVICE_START_30");
      expect(confirmedEvents[0].amountCents).toBe(300_000); // 1,000,000 * 30%

      // 断言：DELIVERED 服务单（#4）生成 30% + 70% 两条事件。
      const deliveredEvents = events.filter((e) => e.orderId === delivered.id);
      expect(deliveredEvents).toHaveLength(2);
      const phases = deliveredEvents.map((e) => e.phase).sort();
      expect(phases).toEqual(["SERVICE_DELIVERY_70", "SERVICE_START_30"]);
      const totalDelivered = deliveredEvents.reduce((s, e) => s + e.amountCents, 0);
      expect(totalDelivered).toBe(2_000_000); // 30% + 70% = 100%

      // —— 聚合校验 ——
      // 预期总额：#3 300,000 + #4 2,000,000 + #5 source 1,500,000（CONFIRMED 服务单 30%）
      //          = 3,800,000 分。CLOSED 不计、ACCRUAL_REVERSAL 不计。
      const agg = aggregateRecognitionEventsByProfile(events);
      const stat = agg.get(profile.id);
      expect(stat).toBeDefined();
      // newBusiness = #3(300k) + #4 start(600k) + #5 source(1,500k) = 2,400,000
      expect(stat!.newBusinessCents).toBe(2_400_000);
      // deliveryBusiness = #4 delivery(1,400k) = 1,400,000
      expect(stat!.deliveryBusinessCents).toBe(1_400_000);
      // confirmed = newBusiness + deliveryBusiness = 3,800,000
      expect(stat!.confirmedBusinessCents).toBe(3_800_000);
    });
  });
});
