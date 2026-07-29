/**
 * Tool-result → model-text money adapter.
 *
 * Business actions keep integer cents in `result` for GenUI.
 * Model-facing text must only see ¥ labels (e.g. ¥506.60), never raw cents
 * that the model would misread as yuan (¥50,660).
 */

import type { AgentActionDefinition, AgentActionPresentation } from "./types";
import { buildCardToolNarration } from "./tool-adapter";

/** Format integer cents as ¥X.XX — no thousands separators (avoids ¥50,660 ambiguity). */
export function formatCentsAsYuanLabel(cents: number): string {
  if (!Number.isFinite(cents)) return "¥0.00";
  return `¥${(cents / 100).toFixed(2)}`;
}

function asYuanLabel(value: unknown): unknown {
  if (typeof value !== "number" || !Number.isFinite(value)) return value;
  return formatCentsAsYuanLabel(value);
}

function mapRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const next: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of keys) {
    if (key in next) next[key] = asYuanLabel(next[key]);
  }
  return next;
}

function mapItems(
  result: unknown,
  itemKeys: readonly string[],
  rootKeys: readonly string[] = [],
): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const root = { ...(result as Record<string, unknown>) };
  for (const key of rootKeys) {
    if (key in root) root[key] = asYuanLabel(root[key]);
  }
  if (Array.isArray(root.items)) {
    root.items = root.items.map((item) => mapRecord(item, itemKeys));
  }
  return root;
}

/**
 * Clone an action result for model narration, replacing known cent fields with ¥ labels.
 * Unknown actions are returned unchanged (still JSON-serializable).
 */
export function formatToolResultMoneyForModel(actionKey: string, result: unknown): unknown {
  switch (actionKey) {
    case "orders.search":
      return mapItems(result, ["totalAmount", "financeAmount"]);

    case "orders.list_pending_receipts":
      return mapItems(result, ["financeAmount", "receivedAmount", "outstandingAmount"]);

    case "orders.get_finance_snapshot": {
      if (!result || typeof result !== "object" || Array.isArray(result)) return result;
      const root = { ...(result as Record<string, unknown>) };
      root.order = mapRecord(root.order, ["totalAmount", "financeAmount"]);
      root.finance = mapRecord(root.finance, [
        "financeAmount",
        "invoicedAmount",
        "receiptAmount",
        "costAmount",
        "outstandingAmount",
      ]);
      if (Array.isArray(root.projectLinks)) {
        root.projectLinks = root.projectLinks.map((link) =>
          mapRecord(link, ["allocatedAmount"]),
        );
      }
      if (Array.isArray(root.invoices)) {
        root.invoices = root.invoices.map((inv) => mapRecord(inv, ["totalAmount"]));
      }
      return root;
    }

    case "orders.get_detail": {
      if (!result || typeof result !== "object" || Array.isArray(result)) return result;
      const root = { ...(result as Record<string, unknown>) };
      root.order = mapRecord(root.order, ["totalAmount"]);
      root.finance = mapRecord(root.finance, [
        "financeAmount",
        "invoicedAmount",
        "receiptAmount",
        "outstandingAmount",
      ]);
      if (Array.isArray(root.lines)) {
        root.lines = root.lines.map((line) => mapRecord(line, ["amount", "unitPrice"]));
      }
      if (Array.isArray(root.projectLinks)) {
        root.projectLinks = root.projectLinks.map((link) =>
          mapRecord(link, ["allocatedAmount"]),
        );
      }
      if (Array.isArray(root.invoices)) {
        root.invoices = root.invoices.map((inv) => mapRecord(inv, ["totalAmount"]));
      }
      return root;
    }

    case "finance.get_invoice_detail": {
      if (!result || typeof result !== "object" || Array.isArray(result)) return result;
      const root = { ...(result as Record<string, unknown>) };
      root.invoice = mapRecord(root.invoice, ["totalAmount"]);
      root.allocatedAmount = asYuanLabel(root.allocatedAmount);
      root.outstandingAmount = asYuanLabel(root.outstandingAmount);
      const lineKey = Array.isArray(root.lineItems) ? "lineItems" : "items";
      if (Array.isArray(root[lineKey])) {
        root[lineKey] = (root[lineKey] as unknown[]).map((item) => mapRecord(item, ["amount"]));
      }
      if (Array.isArray(root.coveredOrders)) {
        root.coveredOrders = root.coveredOrders.map((row) => mapRecord(row, ["amount"]));
      }
      return root;
    }

    case "finance.plan_project_invoice_requests": {
      if (!result || typeof result !== "object" || Array.isArray(result)) return result;
      const root = { ...(result as Record<string, unknown>) };
      root.totalPlannedAmountCents = asYuanLabel(root.totalPlannedAmountCents);
      root.requestedTotalAmountCents = asYuanLabel(root.requestedTotalAmountCents);
      if (Array.isArray(root.plans)) {
        root.plans = root.plans.map((plan) => {
          if (!plan || typeof plan !== "object" || Array.isArray(plan)) return plan;
          const p = { ...(plan as Record<string, unknown>) };
          p.totalAmountCents = asYuanLabel(p.totalAmountCents);
          if (Array.isArray(p.coverageAllocations)) {
            p.coverageAllocations = p.coverageAllocations.map((c) =>
              mapRecord(c, ["amountCents"]),
            );
          }
          if (Array.isArray(p.items)) {
            p.items = p.items.map((item) => mapRecord(item, ["amountCents"]));
          }
          return p;
        });
      }
      if (Array.isArray(root.eligibleOrders)) {
        root.eligibleOrders = root.eligibleOrders.map((row) =>
          mapRecord(row, [
            "financeAmountCents",
            "invoicedAmountCents",
            "remainingInvoiceableCents",
            "plannedAmountCents",
          ]),
        );
      }
      return root;
    }

    case "finance.match_payment": {
      if (!result || typeof result !== "object" || Array.isArray(result)) return result;
      const root = { ...(result as Record<string, unknown>) };
      root.amountCents = asYuanLabel(root.amountCents);
      if (Array.isArray(root.combinations)) {
        root.combinations = root.combinations.map((c) => mapRecord(c, ["sum"]));
      }
      if (Array.isArray(root.candidateInvoices)) {
        root.candidateInvoices = root.candidateInvoices.map((inv) =>
          mapRecord(inv, ["totalAmount", "outstanding", "outstandingAmount", "amount"]),
        );
      }
      if (Array.isArray(root.candidates)) {
        root.candidates = root.candidates.map((inv) =>
          mapRecord(inv, ["totalAmount", "outstanding", "outstandingAmount", "amount"]),
        );
      }
      return root;
    }

    case "finance.create_receipt":
    case "finance.register_issued_invoice":
    case "finance.analyze_invoice_file":
    case "finance.submit_invoice_request":
    case "finance.analyze_bank_flow_file":
    case "finance.apply_bank_flow_mapping":
    case "finance.ocr_bank_flow_receipts":
    case "finance.match_bank_flow_rows":
    case "finance.get_bank_flow_row":
    case "finance.confirm_bank_flow_batch": {
      return rewriteCommonCentKeys(result);
    }

    case "contracts.check_coverage": {
      if (!result || typeof result !== "object" || Array.isArray(result)) return result;
      const root = { ...(result as Record<string, unknown>) };
      if (Array.isArray(root.orders)) {
        root.orders = root.orders.map((order) => mapRecord(order, ["totalAmountCents"]));
      }
      return root;
    }

    case "contracts.prepare_draft": {
      if (!result || typeof result !== "object" || Array.isArray(result)) return result;
      const root = { ...(result as Record<string, unknown>) };
      root.draft = mapRecord(root.draft, ["totalAmountCents"]);
      return root;
    }

    case "contracts.generate":
      return mapItems(result, [], ["totalAmountCents"]);

    case "contracts.get_detail":
      return mapItems(result, [], ["totalAmountCents"]);

    case "contracts.list": {
      if (!result || typeof result !== "object" || Array.isArray(result)) return result;
      const root = { ...(result as Record<string, unknown>) };
      if (Array.isArray(root.contracts)) {
        root.contracts = root.contracts.map((contract) => mapRecord(contract, ["totalAmountCents"]));
      }
      return root;
    }

    default:
      return result;
  }
}

function rewriteCommonCentKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteCommonCentKeys);
  if (!value || typeof value !== "object") return value;
  const COMMON = new Set([
    "amountCents",
    "totalAmountCents",
    "totalAmount",
    "financeAmount",
    "receivedAmount",
    "outstandingAmount",
    "invoicedAmount",
    "receiptAmount",
    "costAmount",
    "allocatedAmount",
  ]);
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (COMMON.has(key) && typeof child === "number") {
      next[key] = asYuanLabel(child);
    } else {
      next[key] = rewriteCommonCentKeys(child);
    }
  }
  return next;
}

function stringifyJson(value: unknown, maxLength = 5000): string {
  try {
    const text = JSON.stringify(value, null, 2);
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}\n…(truncated)`;
  } catch {
    return "";
  }
}

/**
 * Shared model-facing tool text for Pi runtime and legacy /api/agent/chat.
 * Prefers card/minimal narration; otherwise money-formatted JSON.
 */
export function buildModelFacingToolText(opts: {
  actionKey: string;
  presentation?: AgentActionPresentation;
  mode: "result" | "proposal";
  result?: unknown;
  proposalTitle?: string | null;
  proposalSummary?: string | null;
}): string {
  const cardNarration = buildCardToolNarration(opts.presentation, opts.mode, {
    actionKey: opts.actionKey,
    result: opts.result,
  });
  if (cardNarration) return cardNarration;

  if (opts.mode === "proposal") {
    const title = opts.proposalTitle?.trim() || opts.actionKey;
    const summary = opts.proposalSummary?.trim() || "";
    return `已生成待确认 proposal：${title}${summary ? `\n${summary}` : ""}`;
  }

  const formatted = formatToolResultMoneyForModel(opts.actionKey, opts.result);
  return stringifyJson(formatted, 5000) || `${opts.actionKey} 执行成功。`;
}

export function buildModelFacingToolTextForAction(
  action: Pick<AgentActionDefinition<unknown, unknown>, "key" | "presentation"> | null | undefined,
  opts: {
    mode: "result" | "proposal";
    result?: unknown;
    proposalTitle?: string | null;
    proposalSummary?: string | null;
  },
): string {
  return buildModelFacingToolText({
    actionKey: action?.key || "unknown",
    presentation: action?.presentation,
    mode: opts.mode,
    result: opts.result,
    proposalTitle: opts.proposalTitle,
    proposalSummary: opts.proposalSummary,
  });
}

/**
 * Parse link-to-project allocated amount → integer 分.
 *
 * Precedence (do NOT treat bare `allocatedAmount` as 元):
 * 1. `allocatedAmountYuan` — Agent / NL path (元 → 分)
 * 2. `allocatedAmountCents` — explicit cents
 * 3. bare `allocatedAmount` — legacy proposal inputJson already stored as 分
 *    (old code persisted model numbers as cents without conversion)
 */
export function parseLinkAllocatedAmountToCents(
  input: Record<string, unknown>,
  yuanToCents: (yuan: number) => number,
): number | undefined {
  if (input.allocatedAmountYuan != null && input.allocatedAmountYuan !== "") {
    const yuan = typeof input.allocatedAmountYuan === "number"
      ? input.allocatedAmountYuan
      : Number(input.allocatedAmountYuan);
    if (!Number.isFinite(yuan) || yuan < 0) {
      throw new Error("allocatedAmountYuan must be a non-negative number (yuan)");
    }
    return yuanToCents(yuan);
  }

  const centsRaw = input.allocatedAmountCents ?? input.allocatedAmount;
  if (centsRaw == null || centsRaw === "") return undefined;
  const cents = typeof centsRaw === "number" ? centsRaw : Number(centsRaw);
  if (!Number.isFinite(cents) || cents < 0) {
    throw new Error("allocatedAmount must be a non-negative number (cents)");
  }
  return Math.round(cents);
}

/**
 * Rewrite PENDING orders.link_to_project proposal inputJson:
 * legacy `{ allocatedAmount: <cents> }` → `{ allocatedAmountYuan: <yuan>, inputVersion: 2 }`.
 * Idempotent when allocatedAmountYuan already present.
 */
export function migrateLinkToProjectProposalInput(
  raw: Record<string, unknown>,
  centsToYuan: (cents: number) => number,
): { migrated: boolean; input: Record<string, unknown> } {
  if (raw.allocatedAmountYuan != null || raw.allocatedAmountCents != null) {
    const next = { ...raw, inputVersion: raw.inputVersion ?? 2 };
    return { migrated: next.inputVersion !== raw.inputVersion, input: next };
  }
  if (raw.allocatedAmount == null || raw.allocatedAmount === "") {
    return { migrated: false, input: raw };
  }
  const cents = typeof raw.allocatedAmount === "number"
    ? raw.allocatedAmount
    : Number(raw.allocatedAmount);
  if (!Number.isFinite(cents) || cents < 0) {
    return { migrated: false, input: raw };
  }
  const { allocatedAmount: _drop, ...rest } = raw;
  return {
    migrated: true,
    input: {
      ...rest,
      allocatedAmountYuan: centsToYuan(cents),
      inputVersion: 2,
    },
  };
}

/**
 * Parse plan_project_invoice_requests money fields → cents for the planner.
 * Agent/NL: requestedTotalAmountYuan / allocations[].amountYuan
 * Internal: requestedTotalAmountCents / allocations[].amountCents
 */
export function parsePlanInvoiceMoneyToCents(
  input: Record<string, unknown>,
  yuanToCents: (yuan: number) => number,
): {
  requestedTotalAmountCents?: number;
  allocations?: Array<{ orderId: string; amountCents: number }>;
} {
  let requestedTotalAmountCents: number | undefined;
  if (input.requestedTotalAmountYuan != null && input.requestedTotalAmountYuan !== "") {
    const yuan = typeof input.requestedTotalAmountYuan === "number"
      ? input.requestedTotalAmountYuan
      : Number(input.requestedTotalAmountYuan);
    if (!Number.isFinite(yuan) || yuan <= 0) {
      throw new Error("requestedTotalAmountYuan must be a positive number (yuan)");
    }
    requestedTotalAmountCents = yuanToCents(yuan);
  } else if (input.requestedTotalAmountCents != null && input.requestedTotalAmountCents !== "") {
    const cents = typeof input.requestedTotalAmountCents === "number"
      ? input.requestedTotalAmountCents
      : Number(input.requestedTotalAmountCents);
    if (!Number.isFinite(cents) || !Number.isInteger(cents) || cents <= 0) {
      throw new Error("requestedTotalAmountCents must be a positive integer (cents)");
    }
    requestedTotalAmountCents = cents;
  }

  const arr = Array.isArray(input.allocations) ? input.allocations : undefined;
  if (!arr) {
    return { requestedTotalAmountCents };
  }

  const allocations = arr.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`allocations[${index}] must be an object`);
    }
    const row = item as Record<string, unknown>;
    const orderId = row.orderId;
    if (typeof orderId !== "string" || !orderId.trim()) {
      throw new Error(`allocations[${index}].orderId is required`);
    }
    if (row.amountYuan != null && row.amountYuan !== "") {
      const yuan = typeof row.amountYuan === "number" ? row.amountYuan : Number(row.amountYuan);
      if (!Number.isFinite(yuan) || yuan <= 0) {
        throw new Error(`allocations[${index}].amountYuan must be a positive number (yuan)`);
      }
      return { orderId, amountCents: yuanToCents(yuan) };
    }
    if (row.amountCents != null && row.amountCents !== "") {
      const cents = typeof row.amountCents === "number" ? row.amountCents : Number(row.amountCents);
      if (!Number.isFinite(cents) || cents <= 0) {
        throw new Error(`allocations[${index}].amountCents must be a positive number (cents)`);
      }
      return { orderId, amountCents: Math.round(cents) };
    }
    throw new Error(`allocations[${index}] needs amountYuan (元) or amountCents (分)`);
  });

  return { requestedTotalAmountCents, allocations };
}
