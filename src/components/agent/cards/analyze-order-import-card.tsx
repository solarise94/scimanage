"use client";

import { AlertCircle, CheckCircle2, FileSearch, Loader2, Table2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";

function summaryCounts(summary: Record<string, unknown> | undefined): {
  autoSuggested: number;
  ambiguous: number;
  noMatch: number;
  parseFailed: number;
} {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    autoSuggested: n(summary?.autoSuggested),
    ambiguous: n(summary?.ambiguous),
    noMatch: n(summary?.noMatch),
    parseFailed: n(summary?.parseFailed),
  };
}

function parserLabel(parserKey: string | undefined): string {
  if (parserKey === "PINGOODMICE") return "拼好鼠";
  if (parserKey === "ORDER_GENERIC") return "通用订单";
  return parserKey || "-";
}

/**
 * Result card for `orders.analyze_import_file`.
 * Renders either:
 *   - a session summary (sessionId / parserKey / rowCount / counts / nextRowId), or
 *   - a needsColumnMapping state (masked sample rows + allowedTargets).
 */
export function AnalyzeOrderImportCard({ descriptor }: AgentCardProps) {
  const props = descriptor.props;
  const needsColumnMapping = props.needsColumnMapping === true;
  const fileName = typeof props.fileName === "string" ? props.fileName : "订单导入文件";

  if (descriptor.state === "loading") {
    return (
      <CardShell title="分析订单文件中" state="loading">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在识别表头并匹配客户…
        </div>
      </CardShell>
    );
  }

  // ─── needsColumnMapping 分支 ──────────────────────────────────────────────
  if (needsColumnMapping) {
    const rawColumns = Array.isArray(props.rawColumns)
      ? (props.rawColumns as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const sampleRows = Array.isArray(props.sampleRows)
      ? (props.sampleRows as unknown[][])
          .filter(Array.isArray)
          .map((row) => row.filter((x): x is string => typeof x === "string"))
      : [];
    const allowedTargets = Array.isArray(props.allowedTargets)
      ? (props.allowedTargets as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const expectedVersion = typeof props.expectedVersion === "number" ? props.expectedVersion : null;

    return (
      <CardShell title="订单文件需要列映射" state={descriptor.state}>
        <div className="flex items-start gap-2 rounded-xl bg-amber-50/70 px-3 py-2 text-xs text-amber-900">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            文件表头无法自动识别为标准订单格式。请与用户确认列映射后，调用
            <span className="font-medium"> orders.apply_import_column_mapping</span>。
            {expectedVersion != null ? `（expectedVersion=${expectedVersion}）` : null}
          </div>
        </div>

        <div className="mt-3">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">
            检测到的列（{rawColumns.length}）
          </div>
          <div className="flex flex-wrap gap-1">
            {rawColumns.slice(0, 16).map((col, i) => (
              <span
                key={`${col}-${i}`}
                className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {col}
              </span>
            ))}
          </div>
        </div>

        {sampleRows.length > 0 ? (
          <div className="mt-3">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">
              脱敏样例（最多 3 行）
            </div>
            <div className="overflow-hidden rounded-lg border border-border/40">
              <table className="w-full text-[10px]">
                <tbody>
                  {sampleRows.map((row, ri) => (
                    <tr key={ri} className="border-b border-border/20 last:border-0">
                      {row.slice(0, 8).map((cell, ci) => (
                        <td key={ci} className="px-1.5 py-1 text-muted-foreground">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        <div className="mt-3">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">
            允许的目标字段（{allowedTargets.length}）
          </div>
          <div className="flex flex-wrap gap-1">
            {allowedTargets.slice(0, 16).map((t, i) => (
              <span
                key={`${t}-${i}`}
                className="rounded bg-sky-50 px-1.5 py-0.5 text-[10px] text-sky-700"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      </CardShell>
    );
  }

  // ─── 已分析会话分支 ────────────────────────────────────────────────────────
  const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
  const parserKey = typeof props.parserKey === "string" ? props.parserKey : "";
  const rowCount = typeof props.rowCount === "number" ? props.rowCount : 0;
  const counts = summaryCounts(props.summary as Record<string, unknown> | undefined);
  const nextRowId = typeof props.nextRowId === "string" ? props.nextRowId : "";
  const hasIssues = counts.ambiguous > 0 || counts.noMatch > 0 || counts.parseFailed > 0;

  return (
    <CardShell title="订单导入分析结果" state={descriptor.state}>
      <div className="flex items-start justify-between gap-2 rounded-xl bg-muted/30 px-3 py-2">
        <div className="flex min-w-0 items-start gap-2">
          <FileSearch className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{fileName}</div>
            <div className="text-[11px] text-muted-foreground">
              {rowCount} 行 · {parserLabel(parserKey)}
            </div>
          </div>
        </div>
        <Badge
          variant="outline"
          className={`shrink-0 text-[10px] ${
            hasIssues
              ? "bg-amber-50 text-amber-700 border-amber-200"
              : "bg-emerald-50 text-emerald-700 border-emerald-200"
          }`}
        >
          {hasIssues ? <AlertCircle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
          {hasIssues ? "需逐行确认" : "可导入"}
        </Badge>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-emerald-50/50 px-2.5 py-1.5">
          <div className="text-[10px] text-muted-foreground">自动建议</div>
          <div className="font-medium text-emerald-700">{counts.autoSuggested}</div>
        </div>
        <div className="rounded-lg bg-amber-50/50 px-2.5 py-1.5">
          <div className="text-[10px] text-muted-foreground">歧义客户</div>
          <div className="font-medium text-amber-700">{counts.ambiguous}</div>
        </div>
        <div className="rounded-lg bg-slate-50/70 px-2.5 py-1.5">
          <div className="text-[10px] text-muted-foreground">未匹配</div>
          <div className="font-medium text-slate-700">{counts.noMatch}</div>
        </div>
        <div className="rounded-lg bg-rose-50/50 px-2.5 py-1.5">
          <div className="text-[10px] text-muted-foreground">解析失败</div>
          <div className="font-medium text-rose-700">{counts.parseFailed}</div>
        </div>
      </div>

      {sessionId ? (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-muted/20 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          <Table2 className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">会话 {sessionId}</span>
          {nextRowId ? <span className="ml-auto shrink-0">下一行 …{nextRowId.slice(-6)}</span> : null}
        </div>
      ) : null}

      <div className="mt-2 text-[10px] text-muted-foreground">
        后续按顺序导入规则逐行处理（Phase C）；每行单独确认后再落库。
      </div>
    </CardShell>
  );
}
