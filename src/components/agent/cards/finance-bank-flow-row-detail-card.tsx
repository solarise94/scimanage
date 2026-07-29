"use client";

import { Building2, FileText, Layers, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";

interface MatchCombination {
  invoices?: Array<{
    invoiceId?: string;
    invoiceNo?: string;
    amountCents?: number;
  }>;
}

function formatYuan(cents: number | undefined | null): string {
  if (cents == null || Number.isNaN(Number(cents))) return "¥0.00";
  return `¥${(Number(cents) / 100).toFixed(2)}`;
}

function statusBadge(status: string | undefined) {
  switch (status) {
    case "MATCHED":
      return { label: "已匹配", className: "bg-emerald-50 text-emerald-700 border-emerald-200" };
    case "AMBIGUOUS_MATCH":
    case "AMBIGUOUS_ORG":
      return { label: "歧义", className: "bg-amber-50 text-amber-700 border-amber-200" };
    case "NO_MATCH":
    case "ORG_NOT_FOUND":
      return { label: "无匹配", className: "bg-rose-50 text-rose-700 border-rose-200" };
    case "SKIPPED":
      return { label: "已跳过", className: "bg-muted/40 text-muted-foreground border-border/40" };
    default:
      return { label: status || "待处理", className: "bg-muted/40 text-muted-foreground border-border/40" };
  }
}

function lastSix(id: string | undefined): string {
  if (!id) return "------";
  return id.length <= 6 ? id : id.slice(-6);
}

/**
 * Row detail card for `finance.get_bank_flow_row` and `finance.update_bank_flow_selection`.
 */
export function FinanceBankFlowRowDetailCard({ descriptor }: AgentCardProps) {
  const props = descriptor.props;
  const rowRaw = (props.row ?? {}) as Record<string, unknown>;
  const matchRaw = (rowRaw.match ?? props.match ?? {}) as Record<string, unknown>;
  const rowIndex = typeof rowRaw.index === "number" ? rowRaw.index : typeof props.rowIndex === "number" ? props.rowIndex : null;
  const payerName = typeof rowRaw.payerName === "string" ? rowRaw.payerName : "-";
  const amountCents = typeof rowRaw.amountCents === "number" ? rowRaw.amountCents : undefined;
  const date = typeof rowRaw.date === "string" ? rowRaw.date.slice(0, 10) : null;
  const status = typeof rowRaw.status === "string" ? rowRaw.status : undefined;
  const badge = statusBadge(status);

  const organization = matchRaw.organization as { id?: string; name?: string } | undefined;
  const orgCandidates = Array.isArray(matchRaw.orgCandidates)
    ? (matchRaw.orgCandidates as Array<{ id?: string; name?: string; score?: number }>)
    : [];
  const combinations = Array.isArray(matchRaw.combinations)
    ? (matchRaw.combinations as MatchCombination[])
    : [];
  const selectedIdx =
    typeof matchRaw.selectedCombinationIndex === "number"
      ? matchRaw.selectedCombinationIndex
      : null;

  return (
    <CardShell title="银行流水行详情" state={descriptor.state}>
      <div className="flex items-center justify-between gap-2 rounded-xl bg-muted/30 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Wallet className="h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {rowIndex != null ? `#${rowIndex} ` : null}
              {payerName}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {formatYuan(amountCents)}
              {date ? ` · ${date}` : null}
            </div>
          </div>
        </div>
        <Badge variant="outline" className={`shrink-0 text-[10px] ${badge.className}`}>
          {badge.label}
        </Badge>
      </div>

      {organization?.name ? (
        <div className="mt-3 rounded-lg border border-emerald-200/60 bg-emerald-50/50 px-3 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-emerald-900">
            <Building2 className="h-3.5 w-3.5" />
            匹配组织
          </div>
          <div className="text-sm">{organization.name}</div>
        </div>
      ) : orgCandidates.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Building2 className="h-3.5 w-3.5" />
            候选组织（{orgCandidates.length}）
          </div>
          <div className="divide-y divide-border/40 overflow-hidden rounded-lg border border-border/40">
            {orgCandidates.slice(0, 5).map((org) => (
              <div key={org.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                <span className="min-w-0 truncate">{org.name || org.id}</span>
                {typeof org.score === "number" ? (
                  <span className="shrink-0 tabular-nums text-muted-foreground">{org.score} 分</span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {combinations.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Layers className="h-3.5 w-3.5" />
            发票组合（{combinations.length}）
          </div>
          <div className="space-y-2">
            {combinations.map((combo, idx) => {
              const invoices = Array.isArray(combo.invoices) ? combo.invoices : [];
              const sum = invoices.reduce((s, inv) => s + (inv.amountCents ?? 0), 0);
              const selected = selectedIdx === idx;
              return (
                <div
                  key={idx}
                  className={`rounded-lg border px-3 py-2 text-xs ${
                    selected
                      ? "border-emerald-200/80 bg-emerald-50/60"
                      : "border-border/40 bg-muted/10"
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium">
                      组合 {idx + 1}
                      {selected ? " · 已选" : null}
                    </span>
                    <span className="tabular-nums font-medium">{formatYuan(sum)}</span>
                  </div>
                  <div className="space-y-0.5">
                    {invoices.map((inv) => (
                      <div
                        key={inv.invoiceId}
                        className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground"
                      >
                        <span className="flex items-center gap-1">
                          <FileText className="h-3 w-3" />
                          #{inv.invoiceNo || lastSix(inv.invoiceId)}
                        </span>
                        <span className="tabular-nums">{formatYuan(inv.amountCents)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </CardShell>
  );
}
