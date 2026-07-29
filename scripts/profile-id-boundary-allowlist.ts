/**
 * Profile-ID 边界扫描 allow-list。
 *
 * Phase A：冻结新增残留；已知脚本债务在 Phase F 清掉前挂在这里。
 * contract 阶段启用 --contract 后，schema/源码中的 *CustomerId* 命中也走此表。
 */

/** 已删除的 19 个 Customer 业务列（禁止再出现在 Customer Prisma 调用的 data/where/select/orderBy）。 */
export const LEGACY_CUSTOMER_BUSINESS_FIELDS = [
  "customerCode",
  "name",
  "nameDisambiguator",
  "principal",
  "email",
  "wechat",
  "phone",
  "miniProgramId",
  "address",
  "addressNote",
  "receiverPhone",
  "receiverAddress",
  "organization",
  "organizationId",
  "organizationSiteId",
  "organizationRawInput",
  "labOrGroup",
  "archived",
  "archivedAt",
] as const;

export type LegacyCustomerBusinessField = (typeof LEGACY_CUSTOMER_BUSINESS_FIELDS)[number];

export const LEGACY_CUSTOMER_BUSINESS_FIELD_SET = new Set<string>(LEGACY_CUSTOMER_BUSINESS_FIELDS);

/**
 * 允许扫描旧 Customer 业务列 / 做 cutover SQL 的专用脚本。
 * 这些文件本身是迁移工具，不能被边界扫描误判。
 */
export const LEGACY_FIELD_SCAN_ALLOWLIST = [
  "scripts/check-customer-profile-migration.ts",
  "scripts/check-profile-id-boundary.ts",
  "scripts/profile-id-boundary-allowlist.ts",
  "scripts/migrate-customer-fields-to-profile.ts",
  "scripts/expand-profile-fks.ts",
] as const;

/**
 * Phase F 前已知仍向 Customer 写旧业务字段、或读旧列的脚本。
 * 命中只记为 known-debt，不阻断 Phase A；新增脚本不得加入本表，应直接写 Profile。
 *
 * W6.5/W6.6：活跃 smoke 与 fix-imported / scan-resolver-impact 已 Profile-only，本表清空。
 * 历史 cutover 脚本只挂 CONTRACT_CUSTOMER_ID_HISTORY_ALLOWLIST（historyDebt）。
 */
export const KNOWN_LEGACY_SCRIPT_DEBT = [] as const;

/**
 * contract 阶段前，schema 与运行时仍合法持有的 *CustomerId* 技术字段。
 * --contract 模式下这些命中也会失败，除非文件在下方历史 allow-list。
 *
 * W6.0：一次性 cutover / 迁移 / 审计脚本进此表（指标豁免）；活跃 smoke 不得加入，须重写。
 * 豁免命中由 `--contract` 记为 historyDebt，不计入 blocking；Phase E 判定不得只看 blocking 下降。
 * 本阶段不得把 --contract 接入 npm run check。
 */
export const CONTRACT_CUSTOMER_ID_HISTORY_ALLOWLIST = [
  "docs/",
  "scripts/check-customer-profile-migration.ts",
  "scripts/check-profile-id-boundary.ts",
  "scripts/profile-id-boundary-allowlist.ts",
  "scripts/migrate-customer-fields-to-profile.ts",
  "scripts/expand-profile-fks.ts",
  // W6.0 cutover / isolation tools（只读审计、一次性 backfill、停服迁移）
  "scripts/govern-customer-merge-orphans.ts",
  "scripts/backfill-merge-profile-ids.ts",
  "scripts/migrate-owner-to-reptag.ts",
  "scripts/backfill-effective-representative.ts",
  "scripts/migrate-demo-receipts-to-orders.ts",
  "scripts/backfill-payment-invoice.ts",
  "scripts/dryrun-payment-invoice-backfill.ts",
  "scripts/diff-old-communication-metrics.ts",
  "scripts/rematch-unmatched-contract-orders.ts",
  "scripts/audit-external-orders-before-migration.ts",
  "scripts/backfill-anomalies.ts",
  "scripts/migrate-project-budget-costs.ts",
  "scripts/migrate-external-orders-to-orders.ts",
  "scripts/backfill-order-buyer-organization.ts",
  "scripts/migrate-finance-cost-to-cost-entry.ts",
  "scripts/migrate-invoice-coverage-backfill.ts",
  "scripts/import-history-orders.ts",
  "scripts/govern-customer-profile-fields.ts",
  "scripts/fix-archived-drift.ts",
  // Phase E 一次性迁移代码（precheck/backfill/data-disposition，迁移完成并确认无再跑需求后按 W6.0 条件退役）
  "scripts/phase-e-precheck.ts",
  "scripts/phase-e-backfill.ts",
  "scripts/phase-e-data-disposition.ts",
] as const;

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
