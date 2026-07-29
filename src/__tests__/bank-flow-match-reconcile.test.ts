/**
 * BANK_FLOW_MATCH：终态 Job 与 MATCHING workspace 的 reconcile 决策。
 */
import { describe, it, expect } from "vitest";
import { JOB_STATUS } from "@/lib/agent-background-jobs";
import { decideBankFlowMatchReconcileAction } from "@/lib/finance/bank-flow-match-job";

describe("decideBankFlowMatchReconcileAction", () => {
  const base = {
    phase: "MATCHING",
    matchJobId: "job-1",
    jobId: "job-1",
  };

  it("finalizes when job completed", () => {
    expect(
      decideBankFlowMatchReconcileAction({
        ...base,
        jobStatus: JOB_STATUS.COMPLETED,
      }),
    ).toBe("finalize");
    expect(
      decideBankFlowMatchReconcileAction({
        ...base,
        jobStatus: JOB_STATUS.COMPLETED_WITH_ERRORS,
      }),
    ).toBe("finalize");
  });

  it("reverts when job cancelled / failed / expired / missing", () => {
    for (const jobStatus of [
      JOB_STATUS.CANCELLED,
      JOB_STATUS.FAILED,
      JOB_STATUS.EXPIRED,
      null,
    ]) {
      expect(
        decideBankFlowMatchReconcileAction({ ...base, jobStatus }),
      ).toBe("revert");
    }
  });

  it("noops while job still running or phase already unfrozen", () => {
    expect(
      decideBankFlowMatchReconcileAction({
        ...base,
        jobStatus: JOB_STATUS.RUNNING,
      }),
    ).toBe("noop");
    expect(
      decideBankFlowMatchReconcileAction({
        ...base,
        jobStatus: JOB_STATUS.QUEUED,
      }),
    ).toBe("noop");
    expect(
      decideBankFlowMatchReconcileAction({
        ...base,
        phase: "MATCHED",
        jobStatus: JOB_STATUS.COMPLETED,
      }),
    ).toBe("noop");
    expect(
      decideBankFlowMatchReconcileAction({
        ...base,
        matchJobId: "other-job",
        jobStatus: JOB_STATUS.COMPLETED,
      }),
    ).toBe("noop");
  });
});
