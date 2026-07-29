/**
 * Task B regression：CrmVisitCheckin DRAFT 孤儿 sweep。
 *
 * 场景：
 *  - DRAFT 超 48h（被清理）
 *  - DRAFT 未超期（保留）
 *  - COMPLETED 超 48h（保留——非孤儿，COMPLETED 是签到事实）
 *  - batchLimit 上限
 *  - 并发完成竞态（status=DRAFT 守卫）
 *  - runAllReminders 聚合：返回 checkinDraftSwept 字段。
 *
 * 约定：与同目录其他测试一致——单个 withTempSmokeDb 包多个 it（避免多次
 * withTempSmokeDb 串扰 prisma 单例的缓存）。
 */
import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

describe("checkin-draft-sweep (Task B)", () => {
  it(
    "sweeps only DRAFT rows older than 48h; leaves recent DRAFT and any COMPLETED; "
    + "respects batchLimit; survives concurrent completion race; "
    + "and runAllReminders aggregates checkinDraftSwept",
    async () => {
      await withTempSmokeDb(async () => {
        const { prisma } = await import("@/lib/prisma");
        const {
          CHECKIN_DRAFT_SWEEP_AGE_MS,
          sweepStaleCheckinDrafts,
        } = await import("../checkin-draft-sweep");

        // ── 公共种子：admin + 客户 ──────────────────────────────────────
        const user = await prisma.user.create({
          data: { email: "taskb-sweep@example.com", name: "Rep", password: "h", role: "USER" },
        });
        const profile = await prisma.crmCustomerProfile.create({
          data: { name: "客户A", ownerUserId: user.id },
        });

        const now = new Date("2026-07-26T00:00:00.000Z");
        const oldDate = new Date(now.getTime() - CHECKIN_DRAFT_SWEEP_AGE_MS - 60_000); // 超 48h+1min
        const recentDate = new Date(now.getTime() - 60_000); // 1min 前

        // ── 场景 1：选择性删除 ─────────────────────────────────────────
        const staleDraft = await prisma.crmVisitCheckin.create({
          data: {
            profileId: profile.id,
            userId: user.id,
            status: "DRAFT",
            createdAt: oldDate,
            updatedAt: oldDate,
          },
        });
        const freshDraft = await prisma.crmVisitCheckin.create({
          data: {
            profileId: profile.id,
            userId: user.id,
            status: "DRAFT",
            createdAt: recentDate,
            updatedAt: recentDate,
          },
        });
        const oldCompleted = await prisma.crmVisitCheckin.create({
          data: {
            profileId: profile.id,
            userId: user.id,
            status: "COMPLETED",
            createdAt: oldDate,
            updatedAt: oldDate,
            completedAt: oldDate,
          },
        });

        const r1 = await sweepStaleCheckinDrafts({ now, db: prisma });
        expect(r1.swept).toBe(1);

        const remaining1 = await prisma.crmVisitCheckin.findMany({ select: { id: true, status: true } });
        const ids1 = new Set(remaining1.map((r) => r.id));
        expect(ids1.has(staleDraft.id)).toBe(false);
        expect(ids1.has(freshDraft.id)).toBe(true);
        expect(ids1.has(oldCompleted.id)).toBe(true);
        expect(remaining1.filter((r) => r.status === "DRAFT")).toHaveLength(1);
        expect(remaining1.filter((r) => r.status === "COMPLETED")).toHaveLength(1);

        // ── 场景 2：batchLimit 上限 ────────────────────────────────────
        // 5 个孤儿 DRAFT，batchLimit=2 → 单轮最多删 2，多轮删完。
        const staleIds: string[] = [];
        for (let i = 0; i < 5; i++) {
          const row = await prisma.crmVisitCheckin.create({
            data: {
              profileId: profile.id,
              userId: user.id,
              status: "DRAFT",
              createdAt: oldDate,
              updatedAt: oldDate,
            },
          });
          staleIds.push(row.id);
        }

        const r2a = await sweepStaleCheckinDrafts({ now, db: prisma, batchLimit: 2 });
        expect(r2a.swept).toBe(2);
        const r2b = await sweepStaleCheckinDrafts({ now, db: prisma, batchLimit: 2 });
        expect(r2b.swept).toBe(2);
        const r2c = await sweepStaleCheckinDrafts({ now, db: prisma, batchLimit: 2 });
        expect(r2c.swept).toBe(1);
        const r2d = await sweepStaleCheckinDrafts({ now, db: prisma, batchLimit: 2 });
        expect(r2d.swept).toBe(0);

        // 5 个孤儿全清；freshDraft + oldCompleted 仍在
        const remaining2 = await prisma.crmVisitCheckin.findMany({ select: { id: true } });
        const ids2 = new Set(remaining2.map((r) => r.id));
        for (const id of staleIds) {
          expect(ids2.has(id)).toBe(false);
        }
        expect(ids2.has(freshDraft.id)).toBe(true);
        expect(ids2.has(oldCompleted.id)).toBe(true);

        // ── 场景 3：并发完成竞态 ───────────────────────────────────────
        // findMany 之后、deleteMany 之前被并发 completeVisitCheckin 转成 COMPLETED：
        // status='DRAFT' 双校验应阻止误删。
        const target = await prisma.crmVisitCheckin.create({
          data: {
            profileId: profile.id,
            userId: user.id,
            status: "DRAFT",
            createdAt: oldDate,
            updatedAt: oldDate,
          },
        });
        await prisma.crmVisitCheckin.update({
          where: { id: target.id },
          data: { status: "COMPLETED", completedAt: now },
        });
        const r3 = await sweepStaleCheckinDrafts({ now, db: prisma });
        expect(r3.swept).toBe(0);
        const still = await prisma.crmVisitCheckin.findUnique({ where: { id: target.id } });
        expect(still?.status).toBe("COMPLETED");

        // ── 场景 4：runAllReminders 聚合（safe 兜底 + checkinDraftSwept 字段）──
        // 再 seed 一个孤儿 DRAFT，触发 sweep 在聚合内有非零计数。
        await prisma.crmVisitCheckin.create({
          data: {
            profileId: profile.id,
            userId: user.id,
            status: "DRAFT",
            createdAt: new Date(Date.now() - CHECKIN_DRAFT_SWEEP_AGE_MS - 60_000),
            updatedAt: new Date(Date.now() - CHECKIN_DRAFT_SWEEP_AGE_MS - 60_000),
          },
        });

        const { runAllReminders } = await import("@/lib/reminder");
        const agg = await runAllReminders();
        expect(agg).toHaveProperty("checkinDraftSwept");
        expect(typeof agg.checkinDraftSwept).toBe("number");
        expect(agg.checkinDraftSwept).toBeGreaterThanOrEqual(1);
        expect(agg).toHaveProperty("durationMs");
      });
    },
    240_000,
  );
});
