/**
 * Agent canonical-service 边界扫描 allowlist。
 * 仅可减少，不可增加新文件。T9.1a 已清空（2026-07-25）：所有 Agent 入口/间接
 * 消费方的 Prisma 持久化收敛至 src/lib/application/ canonical service 层
 * （原路径保留 Prisma-free re-export facade），业务模型写入走各领域 canonical
 * service。新增 Agent 路径直连 Prisma / 业务模型 / 内部 HTTP 一律 blocking。
 */

export function repoRelativePosix(filePath: string, repoRoot: string): string {
  const relative = filePath.startsWith(repoRoot)
    ? filePath.slice(repoRoot.length).replace(/^[/\\]/, "")
    : filePath;
  return relative.replaceAll("\\", "/");
}

export function isPathAllowlisted(relativePosix: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => {
    if (prefix.endsWith("/")) return relativePosix.startsWith(prefix);
    return relativePosix === prefix || relativePosix.startsWith(`${prefix}/`);
  });
}

/**
 * 基线债务：曾直连 Prisma / 正式业务模型 / 内部 HTTP / TransactionClient 的 Agent 入口
 * 的 kind 计数上限。T9.1a 已清空——任何 Agent 路径债务都视为回归（blocking）。
 */
export const AGENT_BOUNDARY_ALLOWLIST = [] as const;

/**
 * Per-file debt kind ceilings for allowlisted Agent paths.
 * Counts may only decrease; exceeding a kind ceiling is blocking.
 */
export const AGENT_BOUNDARY_DEBT_BASELINE = {} as const;

export type AgentBoundaryDebtBaseline = typeof AGENT_BOUNDARY_DEBT_BASELINE;

export type DebtKindCount = Partial<Record<string, number>>;

export type BaselineRegression = {
  file: string;
  kind: string;
  baseline: number;
  actual: number;
};

/** Compare actual kind counts against per-file ceilings; growth is a regression. */
export function findDebtBaselineRegressions(
  file: string,
  actualCounts: DebtKindCount,
  baseline: Record<string, DebtKindCount> = AGENT_BOUNDARY_DEBT_BASELINE as Record<string, DebtKindCount>,
): BaselineRegression[] {
  const ceiling = baseline[file] ?? {};
  const regressions: BaselineRegression[] = [];
  for (const [kind, count] of Object.entries(actualCounts)) {
    const n = count ?? 0;
    const max = ceiling[kind] ?? 0;
    if (n > max) {
      regressions.push({ file, kind, baseline: max, actual: n });
    }
  }
  return regressions;
}
