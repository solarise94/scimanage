/**
 * Agent canonical-service 边界扫描 CLI。
 *
 * 用法：
 *   npx tsx scripts/check-agent-boundaries.ts
 *   npx tsx scripts/check-agent-boundaries.ts --json
 */
import fs from "node:fs";
import path from "node:path";
import {
  AGENT_BOUNDARY_ALLOWLIST,
  AGENT_BOUNDARY_DEBT_BASELINE,
  findDebtBaselineRegressions,
  isPathAllowlisted,
  repoRelativePosix,
} from "./agent-boundaries-allowlist";
import {
  listAgentBoundaryFiles,
  scanSource,
  type AgentBoundaryFinding,
} from "./lib/agent-boundaries-scan";

const REPO_ROOT = path.resolve(__dirname, "..");

function countByKind(findings: AgentBoundaryFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) {
    counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  }
  return counts;
}

function main(): void {
  const json = process.argv.includes("--json");
  const files = listAgentBoundaryFiles(REPO_ROOT);
  const findings: AgentBoundaryFinding[] = [];
  const regressions = [] as ReturnType<typeof findDebtBaselineRegressions>;

  for (const abs of files) {
    const relative = repoRelativePosix(abs, REPO_ROOT);
    const source = fs.readFileSync(abs, "utf8");
    const fileFindings = scanSource(relative, source);
    const debt = isPathAllowlisted(relative, AGENT_BOUNDARY_ALLOWLIST);
    for (const f of fileFindings) {
      findings.push({ ...f, debt });
    }

    if (!debt || fileFindings.length === 0) continue;
    regressions.push(
      ...findDebtBaselineRegressions(
        relative,
        countByKind(fileFindings),
        AGENT_BOUNDARY_DEBT_BASELINE as Record<string, Record<string, number>>,
      ),
    );
  }

  const regressionKeys = new Set(regressions.map((r) => `${r.file}::${r.kind}`));
  const normalized = findings.map((f) => {
    if (f.debt && regressionKeys.has(`${f.file}::${f.kind}`)) {
      return { ...f, debt: false };
    }
    return f;
  });

  const blocking = normalized.filter((f) => !f.debt);
  const debtFindings = normalized.filter((f) => f.debt);

  const allowlistUnused = AGENT_BOUNDARY_ALLOWLIST.filter((file) => {
    return !debtFindings.some((f) => f.file === file) && !regressions.some((r) => r.file === file);
  });

  const summary = {
    scannedFiles: files.length,
    blockingCount: blocking.length,
    debtCount: debtFindings.length,
    allowlistSize: AGENT_BOUNDARY_ALLOWLIST.length,
    baselineRegressions: regressions,
    allowlistUnused,
    blocking,
    debt: debtFindings,
  };

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `[check-agent-boundaries] files=${summary.scannedFiles} blocking=${summary.blockingCount} debt=${summary.debtCount} allowlist=${summary.allowlistSize}`,
    );
    for (const r of regressions) {
      console.error(
        `REGRESS  ${r.file}  [${r.kind}] baseline=${r.baseline} actual=${r.actual} (allowlist debt grew)`,
      );
    }
    for (const f of blocking) {
      console.error(`BLOCK  ${f.file}:${f.line}:${f.column}  [${f.kind}] ${f.message}`);
    }
    for (const f of debtFindings) {
      console.warn(`DEBT   ${f.file}:${f.line}:${f.column}  [${f.kind}] ${f.message}`);
    }
    if (allowlistUnused.length > 0) {
      console.warn(
        `[check-agent-boundaries] allowlist entries with 0 hits (safe to remove): ${allowlistUnused.join(", ")}`,
      );
    }
    if (blocking.length === 0 && regressions.length === 0) {
      console.log("✅ Agent boundary scan passed");
    }
  }

  if (blocking.length > 0 || regressions.length > 0) {
    process.exitCode = 1;
  }
}

main();
