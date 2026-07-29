"use client";

import { CheckCircle2, AlertCircle, Wallet, FileText, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";
import { ENTITY_ROW_BUTTON_CLASS, openEntityResource } from "./open-resource";

interface Combination {
  invoiceIds?: string[];
  invoiceCount?: number;
  sum?: number;
}

interface CandidateInvoice {
  id: string;
  totalAmount?: number;
  outstanding?: number;
  outstandingAmount?: number;
  amount?: number;
}

function formatYuan(cents: number | undefined | null): string {
  if (cents == null || Number.isNaN(Number(cents))) return "¥0.00";
  return `¥${(Number(cents) / 100).toFixed(2)}`;
}

function lastSix(id: string | undefined): string {
  if (!id) return "------";
  return id.length <= 6 ? id : id.slice(-6);
}

function displayValue(value: unknown, fallback = "未知"): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

/**
 * Finance match-result card (read-only) for `finance.match_payment`.
 *
 * Shows the organization, payment amount, and match status.  When matched,
 * lists the invoice combinations (count + sum).  Always lists candidate
 * invoices (id last 6 chars, outstanding amount).
 */
export function FinanceMatchResultCard({
  descriptor,
  onApplyViewIntent,
  onOpenResource,
}: AgentCardProps) {
  const organization = (descriptor.props.organization ?? {}) as Record<string, unknown>;
  const organizationName = displayValue(organization.name, "未知单位");
  const amount = (typeof descriptor.props.amountCents === "number"
    ? descriptor.props.amountCents
    : undefined) as number | undefined;
  const status = descriptor.props.status as string | undefined;
  const matched = status === "MATCHED";
  const combinations = Array.isArray(descriptor.props.combinations)
    ? (descriptor.props.combinations as Combination[])
    : [];
  const candidates = Array.isArray(descriptor.props.candidateInvoices)
    ? (descriptor.props.candidateInvoices as CandidateInvoice[])
    : Array.isArray(descriptor.props.candidates)
      ? (descriptor.props.candidates as CandidateInvoice[])
      : [];

  const handlers = { onOpenResource, onApplyViewIntent };

  return (
    <CardShell title="收款匹配结果" state={descriptor.state}>
      <div className="flex items-center justify-between gap-2 rounded-xl bg-muted/30 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Wallet className="h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="text-sm font-medium">{organizationName}</div>
            <div className="text-[11px] text-muted-foreground">收款 {formatYuan(amount)}</div>
          </div>
        </div>
        {matched ? (
          <Badge
            variant="outline"
            className="shrink-0 bg-emerald-50 text-[10px] text-emerald-700 border-emerald-200"
          >
            <CheckCircle2 className="h-3 w-3" />
            已匹配
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="shrink-0 bg-amber-50 text-[10px] text-amber-700 border-amber-200"
          >
            <AlertCircle className="h-3 w-3" />
            无精确匹配
          </Badge>
        )}
      </div>

      {matched && combinations.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
            匹配组合（{combinations.length}）
          </div>
          <div className="space-y-2">
            {combinations.map((combo, idx) => {
              const ids = Array.isArray(combo.invoiceIds) ? combo.invoiceIds.filter(Boolean) : [];
              return (
                <div
                  key={idx}
                  className="rounded-lg border border-emerald-200/60 bg-emerald-50/60 px-3 py-2 text-xs"
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-emerald-900">
                      发票 {ids.length || combo.invoiceCount || 0} 张
                    </span>
                    <span className="shrink-0 tabular-nums font-medium text-emerald-700">
                      合计 {formatYuan(combo.sum)}
                    </span>
                  </div>
                  {ids.length > 0 ? (
                    <div className="space-y-0.5">
                      {ids.map((invoiceId) => (
                        <button
                          key={invoiceId}
                          type="button"
                          className={`${ENTITY_ROW_BUTTON_CLASS} text-emerald-950 hover:bg-emerald-100/80`}
                          onClick={() => openEntityResource("invoice", invoiceId, "打开发票详情", handlers)}
                        >
                          <span className="font-mono">#{lastSix(invoiceId)}</span>
                          <ChevronRight className="h-3 w-3 text-emerald-700/60" />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {candidates.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <FileText className="h-3.5 w-3.5" />
            候选发票（{candidates.length}）
          </div>
          <div className="divide-y divide-border/40 overflow-hidden rounded-lg border border-border/40">
            {candidates.map((inv) => (
              <button
                key={inv.id}
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                onClick={() => openEntityResource("invoice", inv.id, "打开发票详情", handlers)}
              >
                <span className="min-w-0 truncate font-mono text-foreground">
                  #{lastSix(inv.id)}
                </span>
                <span className="flex shrink-0 items-center gap-1 tabular-nums text-muted-foreground">
                  未结 {formatYuan(inv.outstanding ?? inv.outstandingAmount ?? inv.amount)}
                  <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {!matched ? (
        <div className="mt-3 rounded-lg border border-amber-200/80 bg-amber-50/70 px-3 py-2 text-[11px] leading-5 text-amber-950">
          未找到精确匹配的发票组合，请人工核对后选择发票或创建收款。
        </div>
      ) : null}
    </CardShell>
  );
}
