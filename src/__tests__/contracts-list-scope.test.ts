/**
 * contracts.list 非 ADMIN scope：全部覆盖订单可见才可返回。
 * T8.1b 起算法收敛于 src/lib/contracts/application/query-contracts.ts。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { coverageFindMany, contractFindMany } = vi.hoisted(() => ({
  coverageFindMany: vi.fn(),
  contractFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    orderContractCoverage: { findMany: coverageFindMany },
    contractDocument: { findMany: contractFindMany },
  },
}));

import { isContractFullyVisible } from "@/lib/contracts/application/contract-order-scope";
import { listContractsFullyInScope } from "@/lib/contracts/application/query-contracts";

function mockResolve<T>(value: T): never {
  return value as never;
}

describe("isContractFullyVisible", () => {
  const visible = new Set(["o1", "o2", "o3"]);

  it("rejects empty coverage", () => {
    expect(isContractFullyVisible([], visible)).toBe(false);
  });

  it("accepts when every covered order is visible", () => {
    expect(
      isContractFullyVisible([{ orderId: "o1" }, { orderId: "o2" }], visible),
    ).toBe(true);
  });

  it("rejects when any covered order is outside scope", () => {
    expect(
      isContractFullyVisible([{ orderId: "o1" }, { orderId: "hidden" }], visible),
    ).toBe(false);
  });

  it("rejects when all covered orders are outside scope", () => {
    expect(isContractFullyVisible([{ orderId: "x" }], visible)).toBe(false);
  });
});

describe("listContractsFullyInScope", () => {
  beforeEach(() => {
    coverageFindMany.mockReset();
    contractFindMany.mockReset();
  });

  it("returns contracts beyond the former 500-row global scan with exact total", async () => {
    const ids = Array.from({ length: 501 }, (_, index) => `contract-${index}`);
    const hiddenId = "contract-mixed-scope";
    coverageFindMany.mockResolvedValue(mockResolve([
      ...ids.map((contractId) => ({ contractId })),
      { contractId: hiddenId },
    ]));
    contractFindMany.mockImplementation((args: { where: { AND: Array<{ id?: { in?: string[] } }> } }) => {
      const chunk = args.where.AND[1]?.id?.in ?? [];
      return Promise.resolve(mockResolve(chunk.map((id) => {
        if (id === hiddenId) {
          return {
            id,
            contractNo: id,
            status: "GENERATED",
            totalAmount: 100,
            buyerOrgName: "测试单位",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            template: { category: "SEQUENCING" },
            orderCoverage: [{ orderId: "visible-order" }, { orderId: "hidden-order" }],
          };
        }
        const index = Number(id.slice("contract-".length));
        return {
          id,
          contractNo: id,
          status: "GENERATED",
          totalAmount: 100,
          buyerOrgName: "测试单位",
          // contract-0 最新；contract-500 位于第 11 页，原实现会被 500 条上限截断。
          createdAt: new Date(2026, 0, 1, 0, 0, 0, 501 - index),
          template: { category: "SEQUENCING" },
          orderCoverage: [{ orderId: "visible-order" }],
        };
      })));
    });

    const result = await listContractsFullyInScope({
      where: { status: { not: "PENDING_FILE" } },
      visibleOrderIds: new Set(["visible-order"]),
      page: 11,
      pageSize: 50,
    });

    expect(result.total).toBe(501);
    expect(result.contracts.map((contract) => contract.id)).toEqual(["contract-500"]);
    expect(result.contracts).not.toContainEqual(expect.objectContaining({ id: hiddenId }));
    // 502 candidate IDs exercise the SQLite-safe 500-ID chunking path.
    expect(contractFindMany).toHaveBeenCalledTimes(2);
  });
});
