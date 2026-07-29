/**
 * orders.create：proposal → confirm 金额往返不得再 ×100。
 * ¥38,000 明细应在两次 parseInput 后仍为 3,800,000 分。
 */
import { describe, it, expect } from "vitest";
import { centsToYuan, yuanToCents } from "@/lib/finance/money";

/** 镜像 orders.create.parseInput 的 lines[].amount 转换。 */
function parseCreateLines(rawLines: Array<Record<string, unknown>>) {
  return rawLines.map((record, index) => {
    const amount = yuanToCents(Number(record.amount));
    if (!Number.isFinite(amount)) {
      throw new Error(`lines[${index}].amount must be a number`);
    }
    return {
      itemName: String(record.itemName),
      amount,
    };
  });
}

/** 镜像 orders.create.buildProposal 的 proposalInput 回写（分 → 元）。 */
function toProposalInputLines(lines: Array<{ itemName: string; amount: number }>) {
  return lines.map((l) => ({
    itemName: l.itemName,
    amount: centsToYuan(l.amount),
  }));
}

describe("orders.create amount roundtrip via proposalInput", () => {
  it("¥38,000 line stays 3,800,000 分 after proposal→confirm re-parse", () => {
    const agentInput = {
      title: "测试订单",
      profileId: "p1",
      lines: [{ itemName: "测序服务", amount: 38000 }],
    };

    const first = parseCreateLines(agentInput.lines);
    expect(first[0]!.amount).toBe(3_800_000);

    const proposalLines = toProposalInputLines(first);
    expect(proposalLines[0]!.amount).toBe(38000);

    const second = parseCreateLines(proposalLines);
    expect(second[0]!.amount).toBe(3_800_000);

    // 旧缺陷：若把已是分的 amount 再持久化，二次 parse 会变成 380,000,000
    const buggyPersist = first.map((l) => ({ itemName: l.itemName, amount: l.amount }));
    const buggySecond = parseCreateLines(buggyPersist);
    expect(buggySecond[0]!.amount).toBe(380_000_000);
  });

  it("totalAmount yuan path is unaffected by line conversion", () => {
    const yuan = 38000;
    expect(yuanToCents(yuan)).toBe(3_800_000);
    expect(yuanToCents(yuanToCents(yuan))).toBe(380_000_000);
  });
});
