"use client";

import { CheckCircle2, AlertCircle, XCircle, GitCompareArrows } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";

interface MatchResult {
  rowIndex?: number;
  organization?: { id?: string; name?: string };
  orgCandidates?: Array<{ id?: string; name?: string; score?: number }>;
  combinations?: Array<{ invoices?: unknown[] }>;
  selectedCombinationIndex?: number;
}

function formatYuan(cents: number | undefined | null): string {
  if (cents == null || Number.isNaN(Number(cents))) return "¥0.00";
  return `¥${(Number(cents) / 100).toFixed(2)}`;
}

function summaryCounts(summary: Record<string, unknown> | undefined) {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    matched: n(summary?.matched),
    ambiguousOrg: n(summary?.ambiguousOrg),
    ambiguousMatch: n(summary?.ambiguousMatch),
    noMatch: n(summary?.noMatch),
    orgNotFound: n(summary?.orgNotFound),
    skipped: n(summary?.skipped),
    total: n(summary?.total),
  };
}

function inferStatus(match: MatchResult): string {
  if (match.orgCandidates?.length) return "AMBIGUOUS_ORG";
  if (!match.organization) return "ORG_NOT_FOUND";
  if (!match.combinations?.length) return "NO_MATCH";
  if (match.combinations.length > 1) return "AMBIGUOUS_MATCH";
  return "MATCHED";
}

function statusBadge(status: string) {
  switch (status) {
    case "MATCHED":
      return {
        label: "已匹配",
        icon: CheckCircle2,
        className: "bg-emerald-50 text-emerald-700 border-emerald-200",
      };
    case "AMBIGUOUS_MATCH":
    case "AMBIGUOUS_ORG":
      return {
        label: "歧义",
        icon: AlertCircle,
        className: "bg-amber-50 text-amber-700 border-amber-200",
      };
    case "NO_MATCH":
    case "ORG_NOT_FOUND":
      return {
        label: status === "ORG_NOT_FOUND" ? "组织未找到" : "无匹配",
        icon: XCircle,
        className: "bg-rose-50 text-rose-700 border-rose-200",
      };
    default:
      return {
        label: status,
        icon: AlertCircle,
        className: "bg-muted/40 text-muted-foreground border-border/40",
      };
  }
}

/**
 * Match results card for `finance.match_bank_flow_rows`.
 */
export function FinanceBankFlowMatchResultsCard({ descriptor }: AgentCardProps) {
  const props = descriptor.props;
  const counts = summaryCounts(props.summary as Record<string, unknown> | undefined);
  const results = Array.isArray(props.results) ? (props.results as MatchResult[]) : [];
  const truncated = props.truncated === true;

  return (
    <CardShell title="银行流水匹配结果" state={descriptor.state}>
      <div className="flex items-center gap-2 rounded-xl bg-muted/30 px-3 py-2">
        <GitCompareArrows className="h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="text-sm font-medium">
          共 {counts.total || results.length} 行
          {counts.matched > 0 ? ` · ${counts.matched} 已匹配` : null}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div className="rounded-lg bg-emerald-50/50 px-2.5 py-1.5">
          <div className="text-[10px] text-muted-foreground">已匹配</div>
          <div className="font-medium text-emerald-700">{counts.matched}</div>
        </div>
        <div className="rounded-lg bg-amber-50/50 px-2.5 py-1.5">
          <div className="text-[10px] text-muted-foreground">歧义</div>
          <div className="font-medium text-amber-700">{counts.ambiguousOrg + counts.ambiguousMatch}</div>
        </div>
        <div className="rounded-lg bg-rose-50/50 px-2.5 py-1.5">
          <div className="text-[10px] text-muted-foreground">无匹配</div>
          <div className="font-medium text-rose-700">{counts.noMatch + counts.orgNotFound}</div>
        </div>
      </div>

      {results.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">逐行状态</div>
          <div className="divide-y divide-border/40 overflow-hidden rounded-lg border border-border/40">
            {results.map((match) => {
              const status = inferStatus(match);
              const badge = statusBadge(status);
              const Icon = badge.icon;
              const orgName =
                match.organization?.name
                || match.orgCandidates?.[0]?.name
                || "-";
              const comboCount = match.combinations?.length ?? 0;
              return (
                <div
                  key={match.rowIndex}
                  className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                >
                  <div className="min-w-0">
                    <span className="font-mono text-muted-foreground">#{match.rowIndex}</span>
                    <span className="ml-2 truncate">{orgName}</span>
                    {comboCount > 0 ? (
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        · {comboCount} 组合
                      </span>
                    ) : null}
                  </div>
                  <Badge variant="outline" className={`shrink-0 text-[10px] ${badge.className}`}>
                    <Icon className="h-3 w-3" />
                    {badge.label}
                  </Badge>
                </div>
              );
            })}
          </div>
          {truncated ? (
            <div className="mt-1.5 text-[10px] text-muted-foreground">仅展示前 30 行详情</div>
          ) : null}
        </div>
      ) : null}
    </CardShell>
  );
}
