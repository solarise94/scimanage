/**
 * Agent boundary AST scanner (shared by CLI and vitest fixtures).
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export type AgentBoundaryFindingKind =
  | "prisma-import"
  | "prisma-call"
  | "tx-model"
  | "transaction-client-type"
  | "business-model-access"
  | "internal-api-fetch";

export type AgentBoundaryFinding = {
  kind: AgentBoundaryFindingKind;
  file: string;
  line: number;
  column: number;
  message: string;
  debt: boolean;
};

export const BUSINESS_MODEL_NAMES = new Set([
  "order",
  "orderLine",
  "orderSourceRecord",
  "orderProjectLink",
  "orderStatusHistory",
  "orderMerge",
  "orderInvoiceCoverage",
  "orderImportSession",
  "orderImportRow",
  "project",
  "projectMember",
  "projectNote",
  "projectNoteAttachment",
  "projectInvoice",
  "comment",
  "ticket",
  "ticketReply",
  "customer",
  "organization",
  "organizationAlias",
  "organizationSite",
  "crmCustomerProfile",
  "crmInteraction",
  "crmFollowUpTask",
  "crmVisitCheckin",
  "crmCustomerAddress",
  "crmCustomerRelation",
  "crmCustomerApplication",
  "crmRegionManager",
  "crmCustomerAssignmentLog",
  "crmCustomerPreference",
  "crmComplaint",
  "crmComplaintEvent",
  "externalOrder",
  "externalOrderInvoiceRequest",
  "billingProfile",
  "invoiceAdjustment",
  "invoiceDocument",
  "issuedInvoiceNumberClaim",
  "issuedInvoiceFileHashClaim",
  "financeCost",
  "financeReceiptAllocation",
  "financePayable",
  "financePayment",
  "financePaymentAllocation",
  "contractTemplate",
  "contractDocument",
  "contractGenerationIntent",
  "contractAttachment",
  "orderContractCoverage",
  "costEntry",
  "costSnapshot",
  "costRule",
  "serviceCatalog",
  "orderLineServiceMapping",
  "supplier",
  "supplyPlan",
  "activityLog",
  "notification",
  "user",
]);

function isAgentOwnModel(name: string): boolean {
  return name.startsWith("agent") || name.startsWith("Agent");
}

function lineOf(sourceFile: ts.SourceFile, pos: number): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
  return { line: line + 1, column: character + 1 };
}

function isPrismaModuleSpecifier(spec: string): boolean {
  const normalized = spec.replace(/\\/g, "/");
  return (
    normalized === "@/lib/prisma" ||
    normalized.endsWith("/lib/prisma") ||
    normalized.endsWith("/lib/prisma.ts") ||
    normalized.endsWith("/src/lib/prisma") ||
    normalized.endsWith("/src/lib/prisma.ts")
  );
}

function looksLikeApiPath(text: string): boolean {
  return text.includes("/api/");
}

/**
 * 浏览器客户端模块（首条语句为 "use client" 指令；容忍 "use strict" 在前）。
 * 客户端模块经同源 HTTP 调用自家 /api/** 是正常的 Web 架构，不构成
 * 「服务端自调用」反模式，internal-api-fetch 对其豁免；其余检测类型
 * （prisma-import/prisma-call 等）照常命中——客户端代码本就不应出现 Prisma。
 */
function hasUseClientDirective(sourceFile: ts.SourceFile): boolean {
  for (const stmt of sourceFile.statements) {
    if (ts.isExpressionStatement(stmt) && ts.isStringLiteralLike(stmt.expression)) {
      const text = stmt.expression.text;
      if (text === "use client") return true;
      if (text === "use strict") continue;
      return false;
    }
    return false;
  }
  return false;
}

function collectPrismaAliases(sourceFile: ts.SourceFile): Set<string> {
  const aliases = new Set<string>(["prisma"]);
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (isPrismaModuleSpecifier(node.moduleSpecifier.text) && node.importClause) {
        const clause = node.importClause;
        if (clause.name) aliases.add(clause.name.text);
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            const local = el.name.text;
            const imported = el.propertyName?.text ?? el.name.text;
            if (imported === "prisma" || imported === "default") aliases.add(local);
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isAwaitExpression(node.initializer)) {
      const inner = node.initializer.expression;
      if (
        ts.isCallExpression(inner) &&
        inner.expression.kind === ts.SyntaxKind.ImportKeyword &&
        inner.arguments[0] &&
        ts.isStringLiteral(inner.arguments[0]) &&
        isPrismaModuleSpecifier(inner.arguments[0].text)
      ) {
        if (ts.isIdentifier(node.name)) aliases.add(node.name.text);
        if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
              const imported = el.propertyName && ts.isIdentifier(el.propertyName)
                ? el.propertyName.text
                : el.name.text;
              if (imported === "prisma" || imported === "default") aliases.add(el.name.text);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliases;
}

function propertyAccessRootName(node: ts.PropertyAccessExpression): string | null {
  let cur: ts.Expression = node.expression;
  while (ts.isPropertyAccessExpression(cur) || ts.isCallExpression(cur) || ts.isElementAccessExpression(cur)) {
    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      cur = cur.expression;
    } else {
      cur = cur.expression;
    }
  }
  return ts.isIdentifier(cur) ? cur.text : null;
}

function firstPropertyName(node: ts.PropertyAccessExpression): string | null {
  // prisma.order.findMany → order; tx.order.create → order
  if (ts.isIdentifier(node.expression)) {
    return node.name.text;
  }
  if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
    return node.expression.name.text;
  }
  return null;
}

export function isIndirectAgentConsumerPath(relativePosix: string): boolean {
  // Phase A public facade 适配层（src/lib/agent-actions/public/**）必须零 Prisma。
  // 它属于 agent-actions 扫描根（已覆盖），但 prisma-import/prisma-call 检测对所有
  // agent-actions 子路径生效；这里保持 false 表示"非间接消费者路径"，business-model-access
  // 的 indirect 加判不适用。public 目录的零 Prisma 由 listAgentBoundaryFiles + prisma-import/call 检测守护。
  if (relativePosix.startsWith("src/lib/agent-actions/")) return false;
  if (relativePosix.startsWith("src/app/api/agent/")) return false;
  if (relativePosix.startsWith("src/lib/agent-resources/")) return true;
  if (relativePosix.startsWith("src/lib/agent-runtime/")) return true;
  if (relativePosix.startsWith("src/lib/agent-attachments/")) return true;
  if (relativePosix.startsWith("src/lib/agent/")) return true;
  if (/^src\/lib\/agent-[^/]+\.ts$/.test(relativePosix)) return true;
  return false;
}

export function scanSource(relativePosix: string, sourceText: string): AgentBoundaryFinding[] {
  const findings: AgentBoundaryFinding[] = [];
  const sourceFile = ts.createSourceFile(
    relativePosix,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relativePosix.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const prismaAliases = collectPrismaAliases(sourceFile);
  const indirect = isIndirectAgentConsumerPath(relativePosix);
  const clientModule = hasUseClientDirective(sourceFile);

  const push = (kind: AgentBoundaryFindingKind, node: ts.Node, message: string) => {
    const loc = lineOf(sourceFile, node.getStart(sourceFile));
    findings.push({
      kind,
      file: relativePosix,
      line: loc.line,
      column: loc.column,
      message,
      debt: false,
    });
  };

  const maybeApiString = (node: ts.Node, text: string) => {
    if (looksLikeApiPath(text)) {
      push("internal-api-fetch", node, `internal fetch to "${text}"`);
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (isPrismaModuleSpecifier(node.moduleSpecifier.text)) {
        push("prisma-import", node.moduleSpecifier, `import Prisma from "${node.moduleSpecifier.text}"`);
      }
    }

    if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const spec = node.arguments[0].text;
        if (isPrismaModuleSpecifier(spec)) {
          push("prisma-import", node.arguments[0], `dynamic import("${spec}")`);
        }
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const spec = node.arguments[0].text;
        if (isPrismaModuleSpecifier(spec)) {
          push("prisma-import", node.arguments[0], `require("${spec}")`);
        }
      }

      // fetch(...) — 浏览器客户端模块豁免（见 hasUseClientDirective）
      if (!clientModule && ts.isIdentifier(node.expression) && node.expression.text === "fetch" && node.arguments[0]) {
        const arg = node.arguments[0];
        if (ts.isStringLiteralLike(arg)) maybeApiString(arg, arg.text);
        if (ts.isTemplateExpression(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
          maybeApiString(arg, arg.getText(sourceFile));
        }
        if (ts.isNewExpression(arg) && arg.arguments?.[0] && ts.isStringLiteralLike(arg.arguments[0])) {
          maybeApiString(arg.arguments[0], arg.arguments[0].text);
        }
      }
    }

    // Prisma.TransactionClient
    if (
      ts.isTypeReferenceNode(node) &&
      ts.isQualifiedName(node.typeName) &&
      ts.isIdentifier(node.typeName.left) &&
      node.typeName.left.text === "Prisma" &&
      node.typeName.right.text === "TransactionClient"
    ) {
      push("transaction-client-type", node, "Prisma.TransactionClient in adapter/type surface");
    }

    if (ts.isPropertyAccessExpression(node)) {
      const root = propertyAccessRootName(node);
      const model = firstPropertyName(node);

      if (root && prismaAliases.has(root)) {
        // Only flag the first-level prisma.model access to reduce noise
        if (ts.isIdentifier(node.expression) && prismaAliases.has(node.expression.text)) {
          push("prisma-call", node, `${root}.${node.name.text}`);
          if (indirect && BUSINESS_MODEL_NAMES.has(node.name.text) && !isAgentOwnModel(node.name.text)) {
            push(
              "business-model-access",
              node,
              `indirect Agent consumer accesses business model ${root}.${node.name.text}`,
            );
          }
        }
      }

      if (root === "tx" && ts.isIdentifier(node.expression) && node.expression.text === "tx" && model) {
        // tx.order / tx.agentRun
        push("tx-model", node, `tx.${node.name.text}`);
        if (indirect && BUSINESS_MODEL_NAMES.has(node.name.text) && !isAgentOwnModel(node.name.text)) {
          push(
            "business-model-access",
            node,
            `indirect Agent consumer accesses business model tx.${node.name.text}`,
          );
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

export function listAgentBoundaryFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const dirRoots = [
    "src/lib/agent-actions",
    "src/app/api/agent",
    "src/lib/agent-resources",
    "src/lib/agent-runtime",
    "src/lib/agent-attachments",
    "src/lib/agent",
  ];

  const listFiles = (absDir: string) => {
    if (!fs.existsSync(absDir)) return;
    const stack = [absDir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
        // Characterization / unit tests may use prisma against temp SQLite; not production adapters.
        if (entry.isDirectory() && (entry.name === "__tests__" || entry.name === "fixtures")) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) continue;
        if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
      }
    }
  };

  for (const rel of dirRoots) {
    listFiles(path.join(repoRoot, rel));
  }

  const libDir = path.join(repoRoot, "src/lib");
  if (fs.existsSync(libDir)) {
    for (const entry of fs.readdirSync(libDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (/^agent-.*\.(ts|tsx)$/.test(entry.name)) {
        out.push(path.join(libDir, entry.name));
      }
    }
  }

  return [...new Set(out)].sort();
}
