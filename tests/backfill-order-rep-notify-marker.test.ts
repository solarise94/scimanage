/**
 * backfill-order-rep-notify-skipped.ts 一次性迁移 marker 测试（真实子进程 + 临时 SQLite）。
 *
 * 覆盖：
 *  1. 首次无 --cutoff → 非零退出；
 *  2. 首次运行：cutoff 前 PENDING → SKIPPED，marker 写入；
 *  3. 第二次运行（更晚 cutoff，模拟下次常规部署）：no-op，新建的 PENDING 订单不受影响；
 *  4. marker 存在后无 --cutoff 也正常退出（no-op）；
 *  5. 三审 raw `_MigrationMarker`（createdAt TEXT DEFAULT datetime('now')）→ 当前 schema
 *     的 `db push --skip-generate`（不带 --accept-data-loss）无提示完成，Prisma 可读
 *     marker 且 backfill no-op。
 *
 * 性能约束：
 * - 复用 withTempSmokeDb 的 schema 模板，不在本文件重复全量 bootstrap db push；
 * - 种子和断言直接用当前测试进程的 Prisma，仅 CLI 边界保留真实子进程；
 * - 直接调用 node_modules/.bin，避免每次 `npx` 的解析与缓存写入。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";

const repoRoot = path.resolve(__dirname, "..");
const SCRIPT = path.join(repoRoot, "scripts/backfill-order-rep-notify-skipped.ts");
const MARKER_KEY = "order_rep_notify_backfill_v1";
const prismaBin = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "prisma.cmd" : "prisma",
);

/** 三审版 raw DDL（非 Prisma 管理时的表结构）。 */
const RAW_MARKER_DDL = `
CREATE TABLE "_MigrationMarker" (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
)`;

function run(cmd: string[], env: Record<string, string>): { status: number; out: string } {
  const r = spawnSync(cmd[0], cmd.slice(1), {
    cwd: repoRoot,
    env: { ...process.env, RUST_LOG: "info", ...env },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function runBackfill(args: string[], databaseUrl: string): { status: number; out: string } {
  return run([process.execPath, "--import", "tsx", SCRIPT, ...args], {
    DATABASE_URL: databaseUrl,
  });
}

describe("backfill-order-rep-notify-skipped 一次性 marker", () => {
  it("首次回填、后续 no-op、raw marker 升级均符合预期", async () => {
    await withTempSmokeDb(async ({ databaseUrl }) => {
      const { prisma } = await import("@/lib/prisma");

      // 种子：1 代表 + 1 管理员 + 2 历史单（cutoff 前，有代表/无代表各一）
      const rep = await prisma.representative.create({
        data: { name: "回填代表", email: "bf-rep@t.test" },
      });
      const user = await prisma.user.create({
        data: { email: "bf-admin@t.test", name: "管理员", password: "x", role: "ADMIN" },
      });
      const past = new Date(Date.now() - 86_400_000);
      await prisma.order.createMany({
        data: [
          {
            orderNo: "BF-OLD-1",
            title: "历史单",
            totalAmount: 100,
            representativeId: rep.id,
            createdById: user.id,
            createdAt: past,
            updatedAt: past,
          },
          {
            orderNo: "BF-OLD-2",
            title: "历史无代表单",
            totalAmount: 100,
            createdById: user.id,
            createdAt: past,
            updatedAt: past,
          },
        ],
      });

      // 1. 首次无 --cutoff → 非零退出
      const noCutoff = runBackfill([], databaseUrl);
      expect(noCutoff.status).not.toBe(0);
      expect(noCutoff.out).toContain("--cutoff");

      // 2. 首次回填（cutoff=now）
      const cutoff1 = new Date().toISOString();
      const first = runBackfill(["--cutoff", cutoff1], databaseUrl);
      expect(first.status).toBe(0);
      expect(first.out).toContain("marker 已写入");

      // 验证：两单 SKIPPED + marker 存在
      const ordersAfterFirst = await prisma.order.findMany({
        select: { orderNo: true, repNotifyStatus: true },
      });
      const markerAfterFirst = await prisma.migrationMarker.findUnique({
        where: { key: MARKER_KEY },
      });
      expect(ordersAfterFirst.every((order) => order.repNotifyStatus === "SKIPPED")).toBe(true);
      expect(markerAfterFirst?.key).toBe(MARKER_KEY);

      // 首次回填后新建一单（有代表，PENDING——等待通知的合法新单）
      await prisma.order.create({
        data: {
          orderNo: "BF-NEW-1",
          title: "新单",
          totalAmount: 100,
          representativeId: rep.id,
          createdById: user.id,
        },
      });

      // 3. 第二次运行（更晚 cutoff，模拟下次常规部署）→ no-op，新单不受影响
      const cutoff2 = new Date(Date.now() + 60_000).toISOString();
      const second = runBackfill(["--cutoff", cutoff2], databaseUrl);
      expect(second.status).toBe(0);
      expect(second.out).toContain("no-op");

      // 4. marker 存在后无 --cutoff → 也是 no-op
      const third = runBackfill([], databaseUrl);
      expect(third.status).toBe(0);
      expect(third.out).toContain("no-op");

      // 验证：新单仍 PENDING（未被误回填），历史单仍 SKIPPED
      const state2 = await prisma.order.findMany({
        select: { orderNo: true, repNotifyStatus: true },
        orderBy: { orderNo: "asc" },
      });
      const byNo = Object.fromEntries(
        state2.map((order) => [order.orderNo, order.repNotifyStatus]),
      );
      expect(byNo["BF-NEW-1"]).toBe("PENDING");
      expect(byNo["BF-OLD-1"]).toBe("SKIPPED");
      expect(byNo["BF-OLD-2"]).toBe("SKIPPED");

      // 三审 raw `_MigrationMarker` → 当前 schema 的标准 db push。
      const rawMarkerValue = "cutoff=2026-07-27T00:00:00.000Z updated=2";
      await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "_MigrationMarker"');
      await prisma.$executeRawUnsafe(RAW_MARKER_DDL);
      await prisma.$executeRawUnsafe(
        'INSERT INTO "_MigrationMarker" (key, value) VALUES (?, ?)',
        MARKER_KEY,
        rawMarkerValue,
      );
      const rawRows = await prisma.$queryRawUnsafe<Array<{ key: string; value: string; createdAt: string }>>(
        'SELECT key, value, createdAt FROM "_MigrationMarker"',
      );
      expect(rawRows).toHaveLength(1);
      expect(rawRows[0].key).toBe(MARKER_KEY);
      expect(rawRows[0].value).toBe(rawMarkerValue);

      // 标准 prod 路径：不带 --accept-data-loss。必须无提示完成，且不得删 marker。
      const upgrade = run([prismaBin, "db", "push", "--skip-generate"], {
        DATABASE_URL: databaseUrl,
      });
      expect(upgrade.status).toBe(0);
      expect(upgrade.out.toLowerCase()).not.toMatch(/data loss|dataloss|accept-data-loss/);

      const marker = await prisma.migrationMarker.findUnique({ where: { key: MARKER_KEY } });
      expect(marker?.key).toBe(MARKER_KEY);
      expect(marker?.value).toBe(rawMarkerValue);

      const noop = runBackfill(["--cutoff", new Date().toISOString()], databaseUrl);
      expect(noop.status).toBe(0);
      expect(noop.out).toContain("no-op");
    });
  }, 240_000);
});
