/**
 * Customer → Profile 边界扫描（AST）。
 *
 * Phase A 默认规则：
 * - 禁止任意 Prisma client alias 上的 customer.(create|update|upsert) data 出现 19 个旧业务字段
 * - 禁止 customer.find* / count / aggregate 的 where/select/orderBy 出现这些字段
 * - 禁止 include/select 里 sourceCustomer 子树选择这些字段
 * - 允许 crmProfile / Profile 字段、DTO、Order snapshot
 * - 迁移工具与 Phase F 已知脚本债务走 allow-list（known-debt 不阻断）
 *
 * contract 模式（--contract）：
 * - 额外禁止 prisma/schema 与 src/scripts 源码出现 *CustomerId* 技术标识符
 * - 历史文档与专用 cutover 脚本走 CONTRACT_CUSTOMER_ID_HISTORY_ALLOWLIST（记为 historyDebt，不阻断）
 * - Phase E 判定须同时看 blocking 与 historyDebt；allowlist 降指标 ≠ 实际清理
 *
 * 用法：
 *   npx tsx scripts/check-profile-id-boundary.ts
 *   npx tsx scripts/check-profile-id-boundary.ts --contract
 *   npx tsx scripts/check-profile-id-boundary.ts --json
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  CONTRACT_CUSTOMER_ID_HISTORY_ALLOWLIST,
  KNOWN_LEGACY_SCRIPT_DEBT,
  LEGACY_CUSTOMER_BUSINESS_FIELD_SET,
  LEGACY_FIELD_SCAN_ALLOWLIST,
  isPathAllowlisted,
  repoRelativePosix,
} from "./profile-id-boundary-allowlist";

type FindingKind =
  | "legacy-customer-field"
  | "source-customer-legacy-field"
  | "customer-id-identifier";

type Finding = {
  kind: FindingKind;
  file: string;
  line: number;
  column: number;
  message: string;
  debt: boolean;
  /** contract allowlist 豁免命中（非 Phase A knownDebt） */
  historyDebt?: boolean;
};

const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOTS = [
  path.join(REPO_ROOT, "src"),
  path.join(REPO_ROOT, "scripts"),
  path.join(REPO_ROOT, "prisma"),
];

const CUSTOMER_WRITE_METHODS = new Set(["create", "createMany", "update", "updateMany", "upsert"]);
const CUSTOMER_READ_METHODS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);
const CUSTOMER_ARG_KEYS_TO_SCAN = new Set([
  "data",
  "where",
  "select",
  "orderBy",
  "create",
  "update",
  "include",
]);

const CUSTOMER_ID_IDENT = /^(?:[A-Za-z]*)[Cc]ustomerId(?:[A-Za-z]*)$/;

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (/\.(ts|tsx|mts|cts|prisma)$/.test(entry.name)) out.push(full);
    }
  }
  return out;
}

function lineOf(sourceFile: ts.SourceFile, pos: number): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
  return { line: line + 1, column: character + 1 };
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isPrivateIdentifier(name)) return name.text;
  return null;
}

/** 只收集对象字面量的顶层键；不深入 relation（crmProfile 等）以免误报 Profile 字段。 */
function collectTopLevelKeys(
  node: ts.Expression | undefined,
  onKey: (key: string, keyNode: ts.Node) => void,
): void {
  if (!node) return;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    collectTopLevelKeys(node.expression, onKey);
    return;
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
        const key = propertyNameText(prop.name);
        if (key) onKey(key, prop.name);
      } else if (ts.isSpreadAssignment(prop)) {
        collectTopLevelKeys(prop.expression, onKey);
      }
    }
    return;
  }
  // createMany data: [...] — 检查每个元素的顶层键
  if (ts.isArrayLiteralExpression(node)) {
    for (const el of node.elements) {
      if (!ts.isSpreadElement(el)) collectTopLevelKeys(el, onKey);
    }
  }
}

/** where 子句：顶层键 + AND/OR/NOT 递归。 */
function collectWhereKeys(
  node: ts.Expression | undefined,
  onKey: (key: string, keyNode: ts.Node) => void,
  depth = 0,
): void {
  if (!node || depth > 8) return;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    collectWhereKeys(node.expression, onKey, depth);
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const el of node.elements) {
      if (!ts.isSpreadElement(el)) collectWhereKeys(el, onKey, depth + 1);
    }
    return;
  }
  if (!ts.isObjectLiteralExpression(node)) return;
  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop)) {
      collectWhereKeys(prop.expression, onKey, depth + 1);
      continue;
    }
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
    const key = propertyNameText(prop.name);
    if (!key) continue;
    onKey(key, prop.name);
    if (
      ts.isPropertyAssignment(prop) &&
      (key === "AND" || key === "OR" || key === "NOT")
    ) {
      collectWhereKeys(prop.initializer, onKey, depth + 1);
    }
  }
}

/** upsert 的 create/update，以及嵌套在 data 里的同名块，再扫一层顶层键。 */
function collectCustomerDataKeys(
  node: ts.Expression | undefined,
  onKey: (key: string, keyNode: ts.Node) => void,
): void {
  if (!node) return;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    collectCustomerDataKeys(node.expression, onKey);
    return;
  }
  collectTopLevelKeys(node, onKey);
  if (!ts.isObjectLiteralExpression(node)) return;
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = propertyNameText(prop.name);
    if (key === "create" || key === "update" || key === "createMany") {
      collectTopLevelKeys(prop.initializer, onKey);
    }
  }
}

function isCustomerModelAccess(expr: ts.Expression): boolean {
  // *.customer.<method>  or  *.customer
  if (!ts.isPropertyAccessExpression(expr)) return false;
  return expr.name.text === "customer" && !expr.questionDotToken;
}

function calleeMethod(call: ts.CallExpression): { receiver: ts.Expression; method: string } | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  return { receiver: call.expression.expression, method: call.expression.name.text };
}

function scanSourceCustomerSubtree(
  node: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
  relative: string,
  findings: Finding[],
  debt: boolean,
  depth = 0,
): void {
  if (!node || depth > 10) return;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    scanSourceCustomerSubtree(node.expression, sourceFile, relative, findings, debt, depth);
    return;
  }
  if (!ts.isObjectLiteralExpression(node)) return;
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
    const key = propertyNameText(prop.name);
    if (!key) continue;
    if (key === "sourceCustomer") {
      if (ts.isPropertyAssignment(prop)) {
        // sourceCustomer: true | { select/where: { name: ... } }
        const init = prop.initializer;
        if (ts.isObjectLiteralExpression(init)) {
          for (const nested of init.properties) {
            if (!ts.isPropertyAssignment(nested)) continue;
            const nestedArg = propertyNameText(nested.name);
            if (!nestedArg || !CUSTOMER_ARG_KEYS_TO_SCAN.has(nestedArg)) continue;
            collectTopLevelKeys(nested.initializer, (legacyKey, keyNode) => {
              if (!LEGACY_CUSTOMER_BUSINESS_FIELD_SET.has(legacyKey)) return;
              const loc = lineOf(sourceFile, keyNode.getStart(sourceFile));
              findings.push({
                kind: "source-customer-legacy-field",
                file: relative,
                line: loc.line,
                column: loc.column,
                message: `sourceCustomer 选择/过滤了已删除 Customer 业务字段 "${legacyKey}"`,
                debt,
              });
            });
          }
        }
      }
      continue;
    }
    if (ts.isPropertyAssignment(prop)) {
      scanSourceCustomerSubtree(prop.initializer, sourceFile, relative, findings, debt, depth + 1);
    }
  }
}

function scanTsFile(absPath: string, relative: string, findings: Finding[]): void {
  if (isPathAllowlisted(relative, LEGACY_FIELD_SCAN_ALLOWLIST)) return;

  const debt = isPathAllowlisted(relative, KNOWN_LEGACY_SCRIPT_DEBT);
  const text = fs.readFileSync(absPath, "utf8");
  const sourceFile = ts.createSourceFile(
    absPath,
    text,
    ts.ScriptTarget.Latest,
    true,
    absPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = calleeMethod(node);
      if (callee && isCustomerModelAccess(callee.receiver)) {
        const method = callee.method;
        const scanArgs =
          CUSTOMER_WRITE_METHODS.has(method) || CUSTOMER_READ_METHODS.has(method);
        if (scanArgs) {
          for (const arg of node.arguments) {
            if (!ts.isObjectLiteralExpression(arg)) continue;
            for (const prop of arg.properties) {
              if (!ts.isPropertyAssignment(prop)) continue;
              const argKey = propertyNameText(prop.name);
              if (!argKey || !CUSTOMER_ARG_KEYS_TO_SCAN.has(argKey)) continue;
              const keyCollector =
                argKey === "data" || argKey === "create" || argKey === "update"
                  ? collectCustomerDataKeys
                  : argKey === "where"
                    ? collectWhereKeys
                    : collectTopLevelKeys;
              keyCollector(prop.initializer, (key, keyNode) => {
                if (!LEGACY_CUSTOMER_BUSINESS_FIELD_SET.has(key)) return;
                const loc = lineOf(sourceFile, keyNode.getStart(sourceFile));
                findings.push({
                  kind: "legacy-customer-field",
                  file: relative,
                  line: loc.line,
                  column: loc.column,
                  message: `Customer.${method}(...${argKey}) 使用了已删除业务字段 "${key}"`,
                  debt,
                });
              });
              // select/include/where 内的 sourceCustomer
              scanSourceCustomerSubtree(prop.initializer, sourceFile, relative, findings, debt);
            }
            // 顶层 include
            for (const prop of arg.properties) {
              if (!ts.isPropertyAssignment(prop)) continue;
              const argKey = propertyNameText(prop.name);
              if (argKey === "include" || argKey === "select") {
                scanSourceCustomerSubtree(prop.initializer, sourceFile, relative, findings, debt);
              }
            }
          }
        }
      }

      // 任意调用参数里也可能带 include: { sourceCustomer: { select: { name: true }}}
      for (const arg of node.arguments) {
        if (ts.isObjectLiteralExpression(arg)) {
          scanSourceCustomerSubtree(arg, sourceFile, relative, findings, debt);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

function scanCustomerIdIdentifiers(
  absPath: string,
  relative: string,
  findings: Finding[],
  options?: { historyDebt?: boolean },
): void {
  const asHistoryDebt = options?.historyDebt === true;
  if (relative.endsWith(".prisma")) {
    const text = fs.readFileSync(absPath, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const re = /\b([A-Za-z]*[Cc]ustomerId[A-Za-z]*)\b/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(line))) {
        findings.push({
          kind: "customer-id-identifier",
          file: relative,
          line: index + 1,
          column: match.index + 1,
          message: asHistoryDebt
            ? `historyDebt（allowlist 豁免）Prisma 字段/标识 "${match[1]}"`
            : `contract 模式禁止 Prisma 字段/标识 "${match[1]}"`,
          debt: asHistoryDebt,
          historyDebt: asHistoryDebt,
        });
      }
    });
    return;
  }

  if (!/\.(ts|tsx|mts|cts)$/.test(relative)) return;
  const text = fs.readFileSync(absPath, "utf8");
  const sourceFile = ts.createSourceFile(
    absPath,
    text,
    ts.ScriptTarget.Latest,
    true,
    absPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && CUSTOMER_ID_IDENT.test(node.text)) {
      const loc = lineOf(sourceFile, node.getStart(sourceFile));
      findings.push({
        kind: "customer-id-identifier",
        file: relative,
        line: loc.line,
        column: loc.column,
        message: asHistoryDebt
          ? `historyDebt（allowlist 豁免）标识符 "${node.text}"`
          : `contract 模式禁止标识符 "${node.text}"`,
        debt: asHistoryDebt,
        historyDebt: asHistoryDebt,
      });
    }
    // 字符串字面量里的 API 字段名（如 "customerId"）
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      CUSTOMER_ID_IDENT.test(node.text)
    ) {
      const loc = lineOf(sourceFile, node.getStart(sourceFile));
      findings.push({
        kind: "customer-id-identifier",
        file: relative,
        line: loc.line,
        column: loc.column,
        message: asHistoryDebt
          ? `historyDebt（allowlist 豁免）字符串契约 "${node.text}"`
          : `contract 模式禁止字符串契约 "${node.text}"`,
        debt: asHistoryDebt,
        historyDebt: asHistoryDebt,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function main(): void {
  const argv = process.argv.slice(2);
  const contract = argv.includes("--contract");
  const json = argv.includes("--json");

  const findings: Finding[] = [];
  const files = SCAN_ROOTS.flatMap(listFiles);

  for (const abs of files) {
    const relative = repoRelativePosix(abs, REPO_ROOT);
    if (relative.endsWith(".prisma")) {
      if (contract) scanCustomerIdIdentifiers(abs, relative, findings);
      continue;
    }
    scanTsFile(abs, relative, findings);
    if (contract) {
      const historyDebt = isPathAllowlisted(relative, CONTRACT_CUSTOMER_ID_HISTORY_ALLOWLIST);
      scanCustomerIdIdentifiers(abs, relative, findings, { historyDebt });
    }
  }

  const blocking = findings.filter((f) => !f.debt);
  const historyDebt = findings.filter((f) => f.historyDebt);
  const knownDebt = findings.filter((f) => f.debt && !f.historyDebt);

  const summary = {
    mode: contract ? "contract" : "phase-a",
    scannedFiles: files.length,
    blockingCount: blocking.length,
    knownDebtCount: knownDebt.length,
    /** W6.0 allowlist 豁免命中：指标下降不等于实际清理，Phase E 不得只看 blocking */
    historyDebtCount: historyDebt.length,
    blocking,
    knownDebt,
    historyDebt,
  };

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `[check-profile-id-boundary] mode=${summary.mode} files=${summary.scannedFiles} blocking=${summary.blockingCount} knownDebt=${summary.knownDebtCount}` +
        (contract ? ` historyDebt=${summary.historyDebtCount}` : ""),
    );
    for (const f of blocking) {
      console.error(`BLOCK  ${f.file}:${f.line}:${f.column}  ${f.message}`);
    }
    for (const f of knownDebt) {
      console.warn(`DEBT   ${f.file}:${f.line}:${f.column}  ${f.message}`);
    }
    if (contract && historyDebt.length > 0) {
      const byFile = new Map<string, number>();
      for (const f of historyDebt) {
        byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1);
      }
      console.warn(
        `HISTORY_DEBT  total=${historyDebt.length} files=${byFile.size}（allowlist 豁免，非实际清理）`,
      );
      for (const [file, count] of [...byFile.entries()].sort((a, b) => b[1] - a[1])) {
        console.warn(`  ${count}\t${file}`);
      }
    }
    if (blocking.length === 0) {
      console.log("✅ Profile-ID 边界扫描通过");
    }
  }

  if (blocking.length > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error("[check-profile-id-boundary]", error);
  process.exitCode = 1;
}
