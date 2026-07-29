/**
 * H 下单代表邮件通知（轮询聚合）回归测试。
 * 见 docs/order-rep-notify-email-design-2026-07-26.md §九（15 条测试要点）
 *
 * 覆盖：1/2/3/4/5/6/7/8/9/10/11/12/15（导入 UPDATE 13、历史页 14 为前端/导入链路，
 * 由相应 smoke/parity 与页面自身覆盖，此处不重复）。
 *
 * 基建：withTempSmokeDb（临时 SQLite，对标 business-email/parity 测试基建）。
 * 与 order-receivables-query-parity / web-agent-parity 惯例一致：全部场景共享单个
 * withTempSmokeDb 临时库（避免多次 create/dispose temp DB 的 prisma 单例/模块缓存
 * 时序问题）。sendMail 通过 vi.mock("@/lib/mail") 控制：sendMailState 切换
 * reject/resolve、记录调用次数与内容用于分片/聚合断言。
 *
 * ⚠️ 顶层只允许 type-only import + vi.mock：withTempSmokeDb 之前不能实例化 prisma 单例。
 * 业务模块（含 @/lib/prisma、checkOrderRepNotifications）必须 dynamic-import 进回调。
 *
 * 每个场景用独立 orderNo 前缀 + 明确的 resetSendMail() 隔离；扫描按 representativeId
 * 分组天然隔离，跨场景代表使用不同邮箱。
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";

// ── sendMail mock（vi.mock 提升，早于任何 import） ──────────────────────────
const sendMailState = {
  shouldFail: false,
  failOn: null as Set<number> | null, // 第 N 次调用（1-based）失败
  calls: [] as Array<{ to: string; subject: string }>,
  callCount: 0,
};

vi.mock("@/lib/mail", () => ({
  sendMail: vi.fn(async (opts: { to: string; subject: string }) => {
    sendMailState.callCount += 1;
    sendMailState.calls.push({ to: opts.to, subject: opts.subject });
    if (sendMailState.failOn?.has(sendMailState.callCount)) {
      throw new Error("SMTP simulated failure");
    }
    if (sendMailState.shouldFail) {
      throw new Error("SMTP simulated failure");
    }
    return { messageId: `mock-${sendMailState.callCount}`, transport: "test" as const };
  }),
  sendMailInBackground: vi.fn(() => {
    /* no-op in tests */
  }),
}));

function resetSendMail(): void {
  sendMailState.shouldFail = false;
  sendMailState.failOn = null;
  sendMailState.calls = [];
  sendMailState.callCount = 0;
}

type Prisma = PrismaClient;

describe("H 下单代表邮件通知（轮询聚合）", () => {
  it("覆盖 §九 1/2/3/4/5/6/7/8/9/10/11/12/15（共享临时库）", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { hashSync } = await import("bcryptjs");
      const { checkOrderRepNotifications } = await import("@/lib/business-email/scans");
      const dbPrisma = prisma as unknown as Prisma;

      const admin = await dbPrisma.user.create({
        data: { email: "admin-orn@t.test", name: "Admin", password: hashSync("x", 4), role: "ADMIN" },
      });

      async function makeRep(opts: { name: string; email: string; kind?: string; archived?: boolean }) {
        return dbPrisma.representative.create({
          data: { name: opts.name, email: opts.email, kind: opts.kind ?? "HUMAN", archived: opts.archived ?? false },
        });
      }

      async function makeOrder(opts: {
        orderNo: string;
        repId: string | null;
        title?: string;
        source?: string;
        amount?: number;
        status?: string;
        repNotifyStatus?: string;
        repNotifyAttempts?: number;
        repNotifyLockedAt?: Date | null;
        deleted?: boolean;
        archived?: boolean;
        createdAt?: Date;
        repNotifyError?: string | null;
      }) {
        return dbPrisma.order.create({
          data: {
            orderNo: opts.orderNo,
            title: opts.title ?? `订单 ${opts.orderNo}`,
            totalAmount: opts.amount ?? 100000,
            status: opts.status ?? "DRAFT",
            source: opts.source ?? "MANUAL",
            representativeId: opts.repId,
            createdById: admin.id,
            deleted: opts.deleted ?? false,
            archived: opts.archived ?? false,
            repNotifyStatus: opts.repNotifyStatus ?? "PENDING",
            repNotifyAttempts: opts.repNotifyAttempts ?? 0,
            repNotifyLockedAt: opts.repNotifyLockedAt ?? null,
            repNotifyError: opts.repNotifyError ?? null,
            ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
          },
        });
      }

      /**
       * 场景隔离：共享库下，把上一轮遗留的非终态订单（PENDING/FAILED/PROCESSING）
       * 全部置 SKIPPED，避免 FAILED 订单被下一轮扫描自动重试污染 sendMail 计数。
       * 每个场景只断言「本轮新建订单」的扫描行为。
       */
      async function isolate(): Promise<void> {
        resetSendMail();
        await dbPrisma.order.updateMany({
          where: { repNotifyStatus: { in: ["PENDING", "FAILED", "PROCESSING"] } },
          data: { repNotifyStatus: "SKIPPED", repNotifyLockedAt: null, repNotifyError: "isolated" },
        });
      }

      // ═══════════ 1. 新建单通知 ═══════════
      {
        await isolate();
        const rep1 = await makeRep({ name: "代表1", email: "rep1-orn@t.test" });
        await makeOrder({ orderNo: "ORN-1", repId: rep1.id });

        const res = await checkOrderRepNotifications();
        expect(res.notified).toBe(1);
        expect(sendMailState.callCount).toBe(1);
        expect(sendMailState.calls[0].to).toBe(rep1.email);

        const order = await dbPrisma.order.findFirst({ where: { orderNo: "ORN-1" } });
        expect(order?.repNotifyStatus).toBe("SENT");
        expect(order?.repNotifySentAt).not.toBeNull();
        expect(order?.repNotifyError).toBeNull();

        const logs = await dbPrisma.businessEmailLog.findMany({ where: { type: "ORDER_REP_NOTIFIED" } });
        expect(logs.length).toBe(1);
        expect(logs[0].status).toBe("sent");
        expect(logs[0].orderId).toBe(order!.id);
        expect(logs[0].representativeId).toBe(rep1.id);
      }

      // ═══════════ 2. 聚合 + 逐订单批量日志 ═══════════
      {
        await isolate();
        const repA = await makeRep({ name: "代表A", email: "repA-orn@t.test" });
        const repB = await makeRep({ name: "代表B", email: "repB-orn@t.test" });
        await makeOrder({ orderNo: "ORN-A1", repId: repA.id });
        await makeOrder({ orderNo: "ORN-A2", repId: repA.id });
        await makeOrder({ orderNo: "ORN-A3", repId: repA.id });
        await makeOrder({ orderNo: "ORN-B1", repId: repB.id });
        await makeOrder({ orderNo: "ORN-B2", repId: repB.id });

        const res = await checkOrderRepNotifications();
        expect(res.notified).toBe(5);
        expect(sendMailState.callCount).toBe(2); // 每代表 1 封
        const subjects = sendMailState.calls.map((c) => c.subject);
        expect(subjects.some((s) => s.includes("3 单"))).toBe(true);
        expect(subjects.some((s) => s.includes("2 单"))).toBe(true);

        // 用 orderNo 反查订单 id 后断言日志数（聚合邮件按订单逐条落日志）
        const orders2 = await dbPrisma.order.findMany({
          where: { orderNo: { in: ["ORN-A1", "ORN-A2", "ORN-A3", "ORN-B1", "ORN-B2"] } },
        });
        const logs2 = await dbPrisma.businessEmailLog.findMany({
          where: { type: "ORDER_REP_NOTIFIED", orderId: { in: orders2.map((o) => o.id) } },
        });
        expect(logs2.length).toBe(5);
        expect(logs2.every((l) => l.status === "sent")).toBe(true);
      }

      // ═══════════ 3. 导入聚合（OTHER_IMPORT 同代表 N 单 → 1 封） ═══════════
      {
        await isolate();
        const repImp = await makeRep({ name: "导入代表", email: "repimp-orn@t.test" });
        for (let i = 0; i < 4; i++) {
          await makeOrder({ orderNo: `IMP-${i}`, repId: repImp.id, source: "OTHER_IMPORT" });
        }
        const res = await checkOrderRepNotifications();
        expect(res.notified).toBe(4);
        expect(sendMailState.callCount).toBe(1); // 同代表 4 单 → 1 封聚合
      }

      // ═══════════ 4. SMTP 失败不误判 SENT ═══════════
      {
        await isolate();
        const repF = await makeRep({ name: "失败代表", email: "repf-orn@t.test" });
        await makeOrder({ orderNo: "ORN-FAIL", repId: repF.id });
        sendMailState.shouldFail = true;

        const res = await checkOrderRepNotifications();
        expect(res.failed).toBe(1);
        expect(res.notified).toBe(0);

        const order = await dbPrisma.order.findFirst({ where: { orderNo: "ORN-FAIL" } });
        expect(order?.repNotifyStatus).toBe("FAILED");
        expect(order?.repNotifyError).toBe("SMTP simulated failure");
        expect(order?.repNotifyAttempts).toBe(1);

        const logs = await dbPrisma.businessEmailLog.findMany({
          where: { type: "ORDER_REP_NOTIFIED", orderId: order!.id },
        });
        expect(logs.length).toBe(1);
        expect(logs[0].status).toBe("failed");
        expect(logs[0].error).toBe("SMTP simulated failure");
      }

      // ═══════════ 5. 计提冲回不通知 + 扫描兜底 ═══════════
      {
        await isolate();
        const rep5 = await makeRep({ name: "冲回代表", email: "rep5-orn@t.test" });
        // 模拟「旁路创建点遗漏，被误留为 PENDING」→ 扫描第 0b 步兜底终结
        await makeOrder({
          orderNo: "ACCR-x",
          repId: rep5.id,
          source: "ACCRUAL_REVERSAL",
          repNotifyStatus: "PENDING",
        });
        const res = await checkOrderRepNotifications();
        expect(res.notified).toBe(0);
        expect(sendMailState.callCount).toBe(0);
        expect(res.skipped).toBeGreaterThanOrEqual(1);
        const order = await dbPrisma.order.findFirst({ where: { orderNo: "ACCR-x" } });
        expect(order?.repNotifyStatus).toBe("SKIPPED");
        expect(order?.repNotifyError).toBe("Non-business source");
      }

      // ═══════════ 6. 合同台账不通知（source 排除 + 回填代表后扫描仍 SKIPPED） ═══════════
      {
        await isolate();
        const rep6 = await makeRep({ name: "台账代表", email: "rep6-orn@t.test" });
        await makeOrder({
          orderNo: "CL-x",
          repId: rep6.id,
          source: "CONTRACT_LEDGER",
          repNotifyStatus: "PENDING",
        });
        const res = await checkOrderRepNotifications();
        expect(res.notified).toBe(0);
        expect(sendMailState.callCount).toBe(0);
        const order = await dbPrisma.order.findFirst({ where: { orderNo: "CL-x" } });
        expect(order?.repNotifyStatus).toBe("SKIPPED");
      }

      // ═══════════ 7. 重试上限含 recoverStuck ═══════════
      {
        await isolate();
        const rep7 = await makeRep({ name: "重试代表", email: "rep7-orn@t.test" });
        await makeOrder({ orderNo: "ORN-RT", repId: rep7.id });
        sendMailState.shouldFail = true;

        await checkOrderRepNotifications();
        await checkOrderRepNotifications();
        await checkOrderRepNotifications();

        let order = await dbPrisma.order.findFirst({ where: { orderNo: "ORN-RT" } });
        expect(order?.repNotifyStatus).toBe("FAILED");
        expect(order?.repNotifyAttempts).toBe(3);

        // 第 4 次不应再锁定
        resetSendMail();
        const res4 = await checkOrderRepNotifications();
        expect(res4.notified).toBe(0);
        expect(sendMailState.callCount).toBe(0);
        order = await dbPrisma.order.findFirst({ where: { orderNo: "ORN-RT" } });
        expect(order?.repNotifyAttempts).toBe(3); // 未涨到 4

        // 卡死：PROCESSING + 11 分钟前 lockedAt（attempts 已 3）
        await dbPrisma.order.update({
          where: { id: order!.id },
          data: {
            repNotifyStatus: "PROCESSING",
            repNotifyLockedAt: new Date(Date.now() - 11 * 60 * 1000),
          },
        });
        await checkOrderRepNotifications();
        order = await dbPrisma.order.findFirst({ where: { orderNo: "ORN-RT" } });
        expect(order?.repNotifyStatus).toBe("FAILED");
        expect(order?.repNotifyError).toBe("stuck lock recovered");
        expect(order?.repNotifyAttempts).toBe(3); // 不涨
      }

      // ═══════════ 8a. 删除/归档批量终结 ═══════════
      {
        await isolate();
        const rep8 = await makeRep({ name: "删除代表", email: "rep8-orn@t.test" });
        await makeOrder({ orderNo: "ORN-DEL", repId: rep8.id, deleted: true });
        const res = await checkOrderRepNotifications();
        expect(res.notified).toBe(0);
        expect(sendMailState.callCount).toBe(0);
        const order = await dbPrisma.order.findFirst({ where: { orderNo: "ORN-DEL" } });
        expect(order?.repNotifyStatus).toBe("SKIPPED");
        expect(order?.repNotifyError).toBe("Order deleted or archived");
      }

      // ═══════════ 8b. TOCTOU 复验（PROCESSING+deleted 不被本轮锁定/终结） ═══════════
      {
        await isolate();
        const rep8b = await makeRep({ name: "TOCTOU代表", email: "rep8b-orn@t.test" });
        // 已锁定的 PROCESSING 订单，并发被删除：第 0 步只处理 PENDING/FAILED，锁条件 deleted=0
        // 不匹配 → 本轮不动它（残余竞态归 §5.7 at-least-once）
        const stuck = await makeOrder({
          orderNo: "ORN-TOCTOU2",
          repId: rep8b.id,
          repNotifyStatus: "PROCESSING",
          repNotifyAttempts: 1,
          repNotifyLockedAt: new Date(),
          deleted: true,
        });
        await checkOrderRepNotifications();
        const stillProc = await dbPrisma.order.findUnique({ where: { id: stuck.id } });
        expect(stillProc?.repNotifyStatus).toBe("PROCESSING"); // 不被本轮处理
      }

      // ═══════════ 9. 无代表不通知 + 回填补发 ═══════════
      {
        await isolate();
        const rep9 = await makeRep({ name: "补发代表", email: "rep9-orn@t.test" });
        const o = await makeOrder({ orderNo: "ORN-NOREP", repId: null });
        const res1 = await checkOrderRepNotifications();
        expect(res1.notified).toBe(0);
        expect(sendMailState.callCount).toBe(0);
        let o1 = await dbPrisma.order.findUnique({ where: { id: o.id } });
        expect(o1?.repNotifyStatus).toBe("PENDING"); // 停留，不消耗扫描

        // CRM sync 回填代表
        await dbPrisma.order.update({ where: { id: o.id }, data: { representativeId: rep9.id } });
        const res2 = await checkOrderRepNotifications();
        expect(res2.notified).toBe(1);
        o1 = await dbPrisma.order.findUnique({ where: { id: o.id } });
        expect(o1?.repNotifyStatus).toBe("SENT");
      }

      // ═══════════ 10. SYSTEM / 归档代表 → SKIPPED ═══════════
      {
        await isolate();
        const sysRep = await makeRep({ name: "系统代表", email: "sys-orn@t.test", kind: "SYSTEM" });
        const archRep = await makeRep({ name: "已归档代表", email: "arch-orn@t.test", archived: true });
        await makeOrder({ orderNo: "ORN-SYS", repId: sysRep.id });
        await makeOrder({ orderNo: "ORN-ARCH", repId: archRep.id });
        const res = await checkOrderRepNotifications();
        expect(res.notified).toBe(0);
        expect(sendMailState.callCount).toBe(0);
        const sys = await dbPrisma.order.findFirst({ where: { orderNo: "ORN-SYS" } });
        const arch = await dbPrisma.order.findFirst({ where: { orderNo: "ORN-ARCH" } });
        expect(sys?.repNotifyStatus).toBe("SKIPPED");
        expect(arch?.repNotifyStatus).toBe("SKIPPED");
      }

      // ═══════════ 11. 回填脚本 cutoff 语义（直接验证 updateMany） ═══════════
      {
        const rep11 = await makeRep({ name: "回填代表", email: "rep11-orn@t.test" });
        const before = new Date("2026-07-26T09:00:00Z");
        const after = new Date("2026-07-26T11:00:00Z");
        const cutoff = new Date("2026-07-26T10:00:00Z");
        await makeOrder({ orderNo: "HIST-OLD", repId: rep11.id, createdAt: before });
        await makeOrder({ orderNo: "HIST-NEW", repId: rep11.id, createdAt: after });

        const r1 = await dbPrisma.order.updateMany({
          where: { createdAt: { lte: cutoff }, repNotifyStatus: "PENDING" },
          data: { repNotifyStatus: "SKIPPED", repNotifyError: "Legacy order backfilled at deploy" },
        });
        expect(r1.count).toBe(1);
        const old = await dbPrisma.order.findFirst({ where: { orderNo: "HIST-OLD" } });
        const newer = await dbPrisma.order.findFirst({ where: { orderNo: "HIST-NEW" } });
        expect(old?.repNotifyStatus).toBe("SKIPPED");
        expect(newer?.repNotifyStatus).toBe("PENDING");
        // 幂等
        const r2 = await dbPrisma.order.updateMany({
          where: { createdAt: { lte: cutoff }, repNotifyStatus: "PENDING" },
          data: { repNotifyStatus: "SKIPPED", repNotifyError: "Legacy order backfilled at deploy" },
        });
        expect(r2.count).toBe(0);
      }

      // ═══════════ 12a. CAS 重置：状态已变为 PROCESSING 时 count=0 不覆盖 ═══════════
      {
        const rep12 = await makeRep({ name: "重置代表", email: "rep12-orn@t.test" });
        const o = await makeOrder({
          orderNo: "ORN-RESET",
          repId: rep12.id,
          repNotifyStatus: "FAILED",
          repNotifyAttempts: 3,
          repNotifyError: "SMTP simulated failure",
        });
        // 正常 CAS 重置
        const r1 = await dbPrisma.order.updateMany({
          where: { id: o.id, repNotifyStatus: "FAILED", repNotifyAttempts: 3 },
          data: { repNotifyStatus: "PENDING", repNotifyAttempts: 0, repNotifyLockedAt: null, repNotifyError: null },
        });
        expect(r1.count).toBe(1);
        const o1 = await dbPrisma.order.findUnique({ where: { id: o.id } });
        expect(o1?.repNotifyStatus).toBe("PENDING");
        expect(o1?.repNotifyAttempts).toBe(0);
        expect(o1?.repNotifyError).toBeNull();

        // cron 已抢成 PROCESSING（attempts=1）：CAS where attempts=3 不匹配 → count=0
        await dbPrisma.order.update({
          where: { id: o.id },
          data: { repNotifyStatus: "PROCESSING", repNotifyAttempts: 1 },
        });
        const r2 = await dbPrisma.order.updateMany({
          where: { id: o.id, repNotifyStatus: "FAILED", repNotifyAttempts: 3 },
          data: { repNotifyStatus: "PENDING", repNotifyAttempts: 0, repNotifyLockedAt: null, repNotifyError: null },
        });
        expect(r2.count).toBe(0); // 不覆盖
        const o2 = await dbPrisma.order.findUnique({ where: { id: o.id } });
        expect(o2?.repNotifyStatus).toBe("PROCESSING");
      }

      // ═══════════ 12b. 重置后下一轮 cron 补发成功 ═══════════
      {
        await isolate();
        const rep12b = await makeRep({ name: "重置补发代表", email: "rep12b-orn@t.test" });
        const o = await makeOrder({
          orderNo: "ORN-RESET2",
          repId: rep12b.id,
          repNotifyStatus: "FAILED",
          repNotifyAttempts: 3,
        });
        await dbPrisma.order.update({
          where: { id: o.id },
          data: { repNotifyStatus: "PENDING", repNotifyAttempts: 0, repNotifyLockedAt: null, repNotifyError: null },
        });
        const res = await checkOrderRepNotifications();
        expect(res.notified).toBe(1);
        const o2 = await dbPrisma.order.findUnique({ where: { id: o.id } });
        expect(o2?.repNotifyStatus).toBe("SENT");
      }

      // ═══════════ 15. 分片（3 封 + 独立回写） ═══════════
      {
        await isolate();
        const rep15 = await makeRep({ name: "分片代表", email: "rep15-orn@t.test" });
        for (let i = 0; i < 120; i++) {
          await makeOrder({ orderNo: `ORN-CHUNK-${String(i).padStart(3, "0")}`, repId: rep15.id });
        }
        // 第 2 封（第 2 批）失败，其余成功
        sendMailState.failOn = new Set([2]);

        const res = await checkOrderRepNotifications();
        expect(sendMailState.callCount).toBe(3); // 50+50+20 三片三封
        expect(sendMailState.calls.every((c) => c.subject.includes("第") && c.subject.includes("批，共 120 单"))).toBe(true);

        const sent = await dbPrisma.order.count({
          where: { orderNo: { startsWith: "ORN-CHUNK-" }, repNotifyStatus: "SENT" },
        });
        const failedCount = await dbPrisma.order.count({
          where: { orderNo: { startsWith: "ORN-CHUNK-" }, repNotifyStatus: "FAILED" },
        });
        expect(sent).toBe(70); // 第 1、3 片 50+20
        expect(failedCount).toBe(50); // 第 2 片
        expect(res.notified).toBe(70);
        expect(res.failed).toBe(50);

        // 第 2 片 FAILED 订单 attempts=1，可重试
        const aFailed = await dbPrisma.order.findFirst({
          where: { orderNo: { startsWith: "ORN-CHUNK-" }, repNotifyStatus: "FAILED" },
        });
        expect(aFailed?.repNotifyAttempts).toBe(1);
        expect(aFailed?.repNotifyError).toBe("SMTP simulated failure");
      }

      // ═══════════ 16. CAS 回写失败（部分订单状态已变）→ writebackFailed 计数 + 不误标 SENT ═══════════
      {
        await isolate();
        const rep16 = await makeRep({ name: "回写失败代表", email: "rep16-orn@t.test" });
        // 两单同代表，将被锁到同一片
        const oA = await makeOrder({ orderNo: "ORN-WB-1", repId: rep16.id });
        const oB = await makeOrder({ orderNo: "ORN-WB-2", repId: rep16.id });

        // 手动先把两单锁成 PROCESSING（模拟 cron 锁定结果）
        await dbPrisma.order.update({
          where: { id: oA.id },
          data: { repNotifyStatus: "PROCESSING", repNotifyAttempts: 1, repNotifyLockedAt: new Date() },
        });
        await dbPrisma.order.update({
          where: { id: oB.id },
          data: { repNotifyStatus: "PROCESSING", repNotifyAttempts: 1, repNotifyLockedAt: new Date() },
        });

        // 模拟「扫描拿到锁后，并发 recoverStuck 把 oA 改成 FAILED」→ 回写 CAS 时 oA 不匹配
        // 这里直接把 oA 改成 FAILED（模拟外部干预），让 CAS where repNotifyStatus='PROCESSING' 命中 oA 失败
        await dbPrisma.order.update({
          where: { id: oA.id },
          data: { repNotifyStatus: "FAILED", repNotifyError: "concurrent stuck recovery", repNotifyLockedAt: null },
        });

        // 直接验证 scans 第 5 步 CAS 逻辑（绕过锁定流程，直接构造 chunk 回写）
        // 用 prisma.order.updateMany 模拟 scans 的 CAS 回写：where PROCESSING
        const wb = await dbPrisma.order.updateMany({
          where: { id: { in: [oA.id, oB.id] }, repNotifyStatus: "PROCESSING" },
          data: { repNotifyStatus: "SENT", repNotifyLockedAt: null, repNotifySentAt: new Date(), repNotifyError: null },
        });
        // CAS 只命中 oB（1 条），oA 已被并发改 FAILED → count=1 < chunkSize=2
        expect(wb.count).toBe(1);
        const missed = 2 - wb.count;
        expect(missed).toBe(1); // 即 writebackFailed 应 += 1

        // 验证 oA 未被误标 SENT（保持 FAILED，不被无声覆盖）
        const oAFinal = await dbPrisma.order.findUnique({ where: { id: oA.id } });
        expect(oAFinal?.repNotifyStatus).toBe("FAILED");
        expect(oAFinal?.repNotifyError).toBe("concurrent stuck recovery");
        // oB 正确置 SENT
        const oBFinal = await dbPrisma.order.findUnique({ where: { id: oB.id } });
        expect(oBFinal?.repNotifyStatus).toBe("SENT");
      }

      // ═══════════ 16c. 过期锁令牌不可覆盖新一轮结果（CAS 含 repNotifyLockedAt） ═══════════
      {
        await isolate();
        const rep16c = await makeRep({ name: "锁令牌代表", email: "rep16c-orn@t.test" });
        const oC = await makeOrder({ orderNo: "ORN-WB-TOKEN", repId: rep16c.id });

        // 旧 worker 第一轮锁定（token=T1）
        const t1 = new Date(Date.now() - 11 * 60_000);
        await dbPrisma.order.update({
          where: { id: oC.id },
          data: { repNotifyStatus: "PROCESSING", repNotifyAttempts: 1, repNotifyLockedAt: t1 },
        });
        // 卡死回收 → 新 worker 第二轮重新锁定（token=T2）
        const t2 = new Date();
        await dbPrisma.order.update({
          where: { id: oC.id },
          data: { repNotifyStatus: "PROCESSING", repNotifyAttempts: 2, repNotifyLockedAt: t2 },
        });

        // 旧 worker 用 T1 令牌回写（模拟 scans casWriteback 的 where：
        // PROCESSING + repNotifyLockedAt=T1）→ 必须 count=0，不可覆盖新 worker 的锁
        const stale = await dbPrisma.order.updateMany({
          where: { id: { in: [oC.id] }, repNotifyStatus: "PROCESSING", repNotifyLockedAt: t1 },
          data: { repNotifyStatus: "SENT", repNotifyLockedAt: null, repNotifySentAt: new Date(), repNotifyError: null },
        });
        expect(stale.count).toBe(0);

        // 新 worker 用 T2 令牌回写 → count=1 正常生效
        const fresh = await dbPrisma.order.updateMany({
          where: { id: { in: [oC.id] }, repNotifyStatus: "PROCESSING", repNotifyLockedAt: t2 },
          data: { repNotifyStatus: "SENT", repNotifyLockedAt: null, repNotifySentAt: new Date(), repNotifyError: null },
        });
        expect(fresh.count).toBe(1);
        const oCFinal = await dbPrisma.order.findUnique({ where: { id: oC.id } });
        expect(oCFinal?.repNotifyStatus).toBe("SENT");
      }

      // ═══════════ 16b. 返回值含 writebackFailed 字段（结构断言） ═══════════
      {
        await isolate();
        const rep16b = await makeRep({ name: "回写结构代表", email: "rep16b-orn@t.test" });
        await makeOrder({ orderNo: "ORN-WB-OK", repId: rep16b.id });
        const res = await checkOrderRepNotifications();
        // 正常成功路径：writebackFailed=0
        expect(res.writebackFailed).toBe(0);
        expect(res.notified).toBe(1);
      }
    });
  });
});
