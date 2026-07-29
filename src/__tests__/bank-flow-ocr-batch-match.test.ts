/**
 * OCR workspace 复用：manifest.stagingFileIds 必须与输入批次完全一致。
 */
import { describe, it, expect } from "vitest";
import { bankFlowStagingIdsMatch } from "@/lib/agent-actions/actions/finance-bank-flow";

describe("bankFlowStagingIdsMatch", () => {
  it("matches exact set regardless of order", () => {
    expect(bankFlowStagingIdsMatch(["b", "a"], undefined, ["a", "b"])).toBe(true);
  });

  it("rejects subset reuse (A+B workspace vs A-only request)", () => {
    expect(bankFlowStagingIdsMatch(["a", "b"], "a", ["a"])).toBe(false);
  });

  it("rejects superset request", () => {
    expect(bankFlowStagingIdsMatch(["a"], "a", ["a", "b"])).toBe(false);
  });

  it("falls back to stagingFileId when stagingFileIds absent", () => {
    expect(bankFlowStagingIdsMatch(undefined, "a", ["a"])).toBe(true);
    expect(bankFlowStagingIdsMatch([], "a", ["a"])).toBe(true);
    expect(bankFlowStagingIdsMatch(undefined, "a", ["a", "b"])).toBe(false);
  });
});
