/**
 * Task A regression：buildImportRowAnalysisOutput 的日期反序列化 latent bug。
 *
 * 背景：`OrderImportRow.normalizedPayloadJson` 由 `JSON.stringify(row)` 写入——
 * 其中 `orderAt/paidAt`（Date）会被序列化成 ISO 字符串。读取时 `parseNormalizedPayload`
 * 做 `JSON.parse(raw) as NormalizedOrderRow`（类型断言骗过 TS，运行时是 string）。
 *
 * 旧实现直接 `nf.orderAt?.toISOString()`：当 normalizedFields.orderAt 为 string 时
 * 抛 `TypeError: nf.orderAt.toISOString is not a function`，整个 orders.get_import_row
 * action 崩溃。现有 phase-d-workflow.test.ts 通过「不列 下单时间/付款时间 列」规避了它。
 *
 * 本测试直接构造含日期列的 normalized payload，覆盖：
 *  - 合法 ISO 字符串（运行时类型，模拟 JSON.parse 后真实形态）→ 输出 ISO
 *  - 非法日期字符串 → 输出 null（不抛错）
 *  - null → null
 *
 * 不走完整 analyze_import_file CSV 链路（无须 fingerprint），直接 seed 一行
 * normalizedPayloadJson，调用 analyzeImportRow + buildImportRowAnalysisOutput 等价路径。
 */
import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../scripts/lib/temp-smoke-db";
// 注意：被测 helper（isoOrNull）从 action 注册模块导出，须在 withTempSmokeDb 回调内动态导入，
// 与本仓库其他 temp-SQLite 测试一致（避免顶层 import 串扰 DATABASE_URL / prisma 单例）。

describe("buildImportRowAnalysisOutput date deserialization (Task A)", () => {
  it("valid ISO string date → ISO output; invalid date string → null; null → null (no throw)", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { analyzeImportRow } = await import("@/lib/orders/import-single-row");
      const { isoOrNull } = await import("@/lib/agent-actions/actions/orders");

      const admin = await prisma.user.create({
        data: { email: "taska-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const session = await prisma.orderImportSession.create({
        data: {
          createdById: admin.id,
          status: "OPEN",
          source: "OTHER_IMPORT",
          parserKey: "ORDER_GENERIC",
          fileName: "taska.csv",
        },
      });

      // 构造含 下单时间/付款时间 列的行——日期以 ISO 字符串形式持久化（运行时真相）。
      // 故意把 paidAt 写成非法日期字符串，断言不抛错且输出 null。
      const orderAtIso = "2025-06-01T08:30:00.000Z";
      const row = await prisma.orderImportRow.create({
        data: {
          sessionId: session.id,
          rowNo: 0,
          reviewStatus: "NO_MATCH",
          version: 1,
          rawPayloadJson: JSON.stringify({
            订单号: "EXT-A",
            下单时间: orderAtIso,
            付款时间: "not-a-real-date",
          }),
          normalizedPayloadJson: JSON.stringify({
            externalOrderNo: "EXT-A",
            receiverName: "甲",
            productNamesRaw: "测序服务",
            paidAmount: 1000,
            // 关键：模拟 JSON.stringify 后的运行时类型——字符串，而非 Date 实例。
            orderAt: orderAtIso,
            paidAt: "not-a-real-date",
          }),
          fieldProvenanceJson: JSON.stringify({
            externalOrderNo: "FILE",
            orderAt: "FILE",
            paidAt: "FILE",
          }),
        },
      });

      // 1) analyzeImportRow 本身返回的 normalizedFields 在运行时是字符串日期。
      const analysis = await analyzeImportRow({
        sessionId: session.id,
        rowId: row.id,
        userId: admin.id,
      });
      const nf = analysis.normalizedFields!;
      // 验证根因条件：JSON.parse 出来的日期确实是 string（断言 latent bug 前提成立）。
      expect(typeof nf.orderAt).toBe("string");
      expect(typeof nf.paidAt).toBe("string");

      // 2) isoOrNull 防御：合法 ISO 字符串 → ISO；非法 → null；不抛错。
      //    旧代码 `nf.orderAt?.toISOString()` 在此处会抛 TypeError。
      expect(isoOrNull(nf.orderAt)).toBe(orderAtIso);
      expect(isoOrNull(nf.paidAt)).toBeNull();
      expect(isoOrNull(null)).toBeNull();
      expect(isoOrNull(undefined)).toBeNull();
      // Date 实例路径（生产中不会出现，但 helper 仍须支持）。
      expect(isoOrNull(new Date(orderAtIso))).toBe(orderAtIso);
      // Invalid Date 实例 → null（不抛错）。
      expect(isoOrNull(new Date("garbage"))).toBeNull();
      // 数字时间戳（毫秒）路径。
      expect(isoOrNull(new Date("2025-01-01T00:00:00Z").getTime())).toBe(
        "2025-01-01T00:00:00.000Z",
      );
      // 不支持类型（含 boolean）→ null。
      expect(isoOrNull({ foo: 1 })).toBeNull();
      expect(isoOrNull([1, 2, 3])).toBeNull();
      expect(isoOrNull(true)).toBeNull();
    });
  }, 120_000);
});
