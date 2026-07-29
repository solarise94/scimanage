import { describe, expect, it } from "vitest";
import { scanSource } from "../scripts/lib/agent-boundaries-scan";

describe("check-agent-boundaries scanSource", () => {
  it("flags static prisma import", () => {
    const findings = scanSource(
      "src/lib/agent-actions/actions/demo.ts",
      `import { prisma } from "@/lib/prisma";\n`,
    );
    expect(findings.some((f) => f.kind === "prisma-import")).toBe(true);
  });

  it("flags dynamic prisma import", () => {
    const findings = scanSource(
      "src/lib/agent-actions/actions/demo.ts",
      `export async function run() { const m = await import("@/lib/prisma"); return m.prisma; }\n`,
    );
    expect(findings.some((f) => f.kind === "prisma-import")).toBe(true);
  });

  it("flags aliased prisma calls", () => {
    const findings = scanSource(
      "src/lib/agent-actions/actions/demo.ts",
      `import { prisma as db } from "@/lib/prisma";\nexport async function run() { return db.order.findMany(); }\n`,
    );
    expect(findings.some((f) => f.kind === "prisma-import")).toBe(true);
    expect(findings.some((f) => f.kind === "prisma-call" && f.message.includes("db.order"))).toBe(true);
  });

  it("flags tx.order.create", () => {
    const findings = scanSource(
      "src/lib/agent-actions/actions/demo.ts",
      `export async function run(tx: any) { return tx.order.create({ data: {} }); }\n`,
    );
    expect(findings.some((f) => f.kind === "tx-model" && f.message === "tx.order")).toBe(true);
  });

  it("flags business-model-access for resource resolver paths", () => {
    const findings = scanSource(
      "src/lib/agent-resources/resolve.ts",
      `import { prisma } from "@/lib/prisma";\nexport async function go() { return prisma.order.findFirst(); }\n`,
    );
    expect(findings.some((f) => f.kind === "business-model-access")).toBe(true);
  });

  it("allows agent-own models in runtime without business-model-access", () => {
    const findings = scanSource(
      "src/lib/agent-runtime/memory.ts",
      `import { prisma } from "@/lib/prisma";\nexport async function go() { return prisma.agentRun.findUnique({ where: { id: "1" } }); }\n`,
    );
    expect(findings.some((f) => f.kind === "prisma-import")).toBe(true);
    expect(findings.some((f) => f.kind === "prisma-call")).toBe(true);
    expect(findings.some((f) => f.kind === "business-model-access")).toBe(false);
  });

  it("flags internal /api/ fetch", () => {
    const findings = scanSource(
      "src/app/api/agent/chat-stream/route.ts",
      `export async function go() { return fetch("/api/agent/tools/execute"); }\n`,
    );
    expect(findings.some((f) => f.kind === "internal-api-fetch")).toBe(true);
  });

  it("flags internal /api/ fetch in server-side lib (no 'use client')", () => {
    const findings = scanSource(
      "src/lib/agent/server-helper.ts",
      `export async function go() { return fetch("/api/agent/invoice-staging"); }\n`,
    );
    expect(findings.some((f) => f.kind === "internal-api-fetch")).toBe(true);
  });

  it("exempts 'use client' browser modules from internal-api-fetch (同源 HTTP 是正常 Web 架构)", () => {
    const findings = scanSource(
      "src/lib/agent/browser-upload.ts",
      `"use client";\nexport async function upload() { return fetch("/api/agent/attachments", { method: "POST" }); }\n`,
    );
    expect(findings.some((f) => f.kind === "internal-api-fetch")).toBe(false);
  });

  it("tolerates 'use strict' before 'use client'", () => {
    const findings = scanSource(
      "src/lib/agent/browser-upload.ts",
      `"use strict";\n"use client";\nexport async function upload() { return fetch("/api/agent/attachments"); }\n`,
    );
    expect(findings.some((f) => f.kind === "internal-api-fetch")).toBe(false);
  });

  it("still flags prisma in 'use client' modules (豁免仅限 internal-api-fetch)", () => {
    const findings = scanSource(
      "src/lib/agent/browser-broken.ts",
      `"use client";\nimport { prisma } from "@/lib/prisma";\nexport async function go() { return prisma.order.findMany(); }\n`,
    );
    expect(findings.some((f) => f.kind === "prisma-import")).toBe(true);
    expect(findings.some((f) => f.kind === "prisma-call")).toBe(true);
  });

  it("does not treat mid-file 'use client' string as a directive", () => {
    const findings = scanSource(
      "src/lib/agent/server-helper.ts",
      `const hint = "use client";\nexport async function go() { return fetch("/api/agent/tools"); }\n`,
    );
    expect(findings.some((f) => f.kind === "internal-api-fetch")).toBe(true);
  });

  it("flags Prisma.TransactionClient", () => {
    const findings = scanSource(
      "src/lib/agent-actions/types.ts",
      `import type { Prisma } from "@prisma/client";\nexport type Hook = (tx: Prisma.TransactionClient) => Promise<void>;\n`,
    );
    expect(findings.some((f) => f.kind === "transaction-client-type")).toBe(true);
  });

  it("treats allowlist kind-count growth as a baseline regression", async () => {
    const { findDebtBaselineRegressions } = await import("../scripts/agent-boundaries-allowlist");
    // 自定义基线：计数只可减少，超过上限即回归
    const file = "src/lib/example-debt.ts";
    const baseline = { [file]: { "prisma-import": 1, "prisma-call": 21, "tx-model": 4 } };
    const ok = findDebtBaselineRegressions(
      file,
      { "prisma-import": 1, "prisma-call": 21, "tx-model": 4 },
      baseline,
    );
    expect(ok).toEqual([]);

    const grew = findDebtBaselineRegressions(
      file,
      { "prisma-import": 1, "prisma-call": 22, "tx-model": 4 },
      baseline,
    );
    expect(grew).toEqual([
      { file, kind: "prisma-call", baseline: 21, actual: 22 },
    ]);

    const newKind = findDebtBaselineRegressions(
      file,
      { "prisma-import": 1, "prisma-call": 21, "tx-model": 4, "business-model-access": 1 },
      baseline,
    );
    expect(newKind.some((r) => r.kind === "business-model-access" && r.baseline === 0)).toBe(true);
  });

  it("empty baseline (T9.1a 后状态): allowlist/baseline 均空，任何债务计数都是回归", async () => {
    const { findDebtBaselineRegressions, AGENT_BOUNDARY_ALLOWLIST, AGENT_BOUNDARY_DEBT_BASELINE } =
      await import("../scripts/agent-boundaries-allowlist");
    expect(AGENT_BOUNDARY_ALLOWLIST).toEqual([]);
    expect(AGENT_BOUNDARY_DEBT_BASELINE).toEqual({});
    const regressions = findDebtBaselineRegressions("src/lib/agent-actions/proposals.ts", {
      "prisma-call": 1,
    });
    expect(regressions).toEqual([
      { file: "src/lib/agent-actions/proposals.ts", kind: "prisma-call", baseline: 0, actual: 1 },
    ]);
  });
});
