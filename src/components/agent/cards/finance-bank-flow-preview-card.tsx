"use client";

import { AlertCircle, FileSpreadsheet, Table2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";

interface PreviewRow {
  index?: number;
  payerName?: string;
  amountCents?: number;
  date?: string | null;
  remark?: string | null;
  status?: string;
}

function formatYuan(cents: number | undefined | null): string {
  if (cents == null || Number.isNaN(Number(cents))) return "¥0.00";
  return `¥${(Number(cents) / 100).toFixed(2)}`;
}

function encodingLabel(encoding: string | undefined): string {
  if (encoding === "utf-8") return "UTF-8";
  if (encoding === "gb18030") return "GB18030";
  if (encoding === "unknown") return "未知";
  return encoding || "-";
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
      return { label: "跳过", className: "bg-muted/40 text-muted-foreground border-border/40" };
    default:
      return { label: status || "待处理", className: "bg-muted/40 text-muted-foreground border-border/40" };
  }
}

/**
 * Preview card for analyze / apply_mapping / ocr_bank_flow_receipts.
 */
export function FinanceBankFlowPreviewCard({
  descriptor,
  onSendPrefilled,
}: AgentCardProps) {
  const props = descriptor.props;
  const rowCount = typeof props.rowCount === "number" ? props.rowCount : 0;
  const encoding = typeof props.encoding === "string" ? props.encoding : undefined;
  const mapping = (props.mapping ?? {}) as Record<string, unknown>;
  const preview = Array.isArray(props.preview) ? (props.preview as PreviewRow[]) : [];
  const warnings = Array.isArray(props.warnings)
    ? (props.warnings as unknown[]).filter((w): w is string => typeof w === "string")
    : [];
  const workspaceId = typeof props.workspaceId === "string" ? props.workspaceId : "";
  const expectedVersion =
    typeof props.expectedVersion === "number"
      ? props.expectedVersion
      : typeof props.version === "number"
        ? props.version
        : typeof props.newVersion === "number"
          ? props.newVersion
          : undefined;
  const source = typeof props.source === "string" ? props.source : undefined;
  const encodingUnknown =
    encoding === "unknown" ||
    (props.stats as { encodingUnknown?: boolean } | undefined)?.encodingUnknown === true;

  const mappingEntries = [
    { key: "payerName", label: "付款方" },
    { key: "amount", label: "金额" },
    { key: "date", label: "日期" },
    { key: "remark", label: "备注" },
  ].filter(({ key }) => typeof mapping[key] === "string" && mapping[key]);

  const canChooseEncoding =
    encodingUnknown &&
    Boolean(workspaceId) &&
    expectedVersion != null &&
    typeof mapping.payerName === "string" &&
    typeof mapping.amount === "string" &&
    Boolean(onSendPrefilled);

  function sendEncodingChoice(nextEncoding: "utf-8" | "gb18030") {
    if (!onSendPrefilled || !workspaceId || expectedVersion == null) return;
    const label = nextEncoding === "utf-8" ? "UTF-8" : "GB18030";
    onSendPrefilled(`请用 ${label} 重新应用银行流水列映射`, {
      actionHint: "finance.apply_bank_flow_mapping",
      workspaceId,
      expectedVersion,
      encoding: nextEncoding,
      mapping: {
        payerName: mapping.payerName,
        amount: mapping.amount,
        date: mapping.date,
        remark: mapping.remark,
        payerAccount: mapping.payerAccount,
      },
    });
  }

  return (
    <CardShell title="银行流水预览" state={descriptor.state}>
      <div className="flex items-start justify-between gap-2 rounded-xl bg-muted/30 px-3 py-2">
        <div className="flex min-w-0 items-start gap-2">
          <FileSpreadsheet className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="text-sm font-medium">{rowCount} 行流水</div>
            <div className="text-[11px] text-muted-foreground">
              编码 {encodingLabel(encoding)}
              {source === "ocr" ? " · OCR 回单" : null}
              {workspaceId ? ` · 工作区 …${workspaceId.slice(-6)}` : null}
            </div>
          </div>
        </div>
      </div>

      {canChooseEncoding ? (
        <div className="mt-3 rounded-lg border border-amber-200/80 bg-amber-50/70 px-3 py-2">
          <div className="text-[11px] text-amber-950">
            未能自动识别编码，请选择后重新解析：
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              onClick={() => sendEncodingChoice("utf-8")}
            >
              使用 UTF-8
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              onClick={() => sendEncodingChoice("gb18030")}
            >
              使用 GB18030
            </Button>
          </div>
        </div>
      ) : null}

      {mappingEntries.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">列映射</div>
          <div className="flex flex-wrap gap-1">
            {mappingEntries.map(({ key, label }) => (
              <span
                key={key}
                className="rounded bg-sky-50 px-1.5 py-0.5 text-[10px] text-sky-700"
              >
                {label} → {String(mapping[key])}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-amber-200/80 bg-amber-50/70 px-3 py-2 text-[11px] text-amber-950">
          列映射未完成，请确认 payerName / amount 列后重新应用映射。
        </div>
      )}

      {preview.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Table2 className="h-3.5 w-3.5" />
            预览（前 {Math.min(preview.length, 5)} 行）
          </div>
          <div className="overflow-hidden rounded-lg border border-border/40">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="border-b border-border/30 bg-muted/20 text-left text-muted-foreground">
                  <th className="px-2 py-1 font-medium">#</th>
                  <th className="px-2 py-1 font-medium">付款方</th>
                  <th className="px-2 py-1 font-medium">金额</th>
                  <th className="px-2 py-1 font-medium">日期</th>
                  <th className="px-2 py-1 font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {preview.slice(0, 5).map((row, idx) => {
                  const badge = statusBadge(row.status);
                  return (
                    <tr key={row.index ?? idx} className="border-b border-border/20 last:border-0">
                      <td className="px-2 py-1 tabular-nums text-muted-foreground">
                        {row.index ?? idx}
                      </td>
                      <td className="max-w-[8rem] truncate px-2 py-1">{row.payerName || "-"}</td>
                      <td className="px-2 py-1 tabular-nums">{formatYuan(row.amountCents)}</td>
                      <td className="px-2 py-1 text-muted-foreground">
                        {row.date?.slice(0, 10) || "-"}
                      </td>
                      <td className="px-2 py-1">
                        <Badge variant="outline" className={`text-[9px] ${badge.className}`}>
                          {badge.label}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className="mt-3 space-y-1">
          {warnings.slice(0, 5).map((w, i) => (
            <div
              key={i}
              className="flex items-start gap-1.5 rounded-lg bg-amber-50/70 px-2.5 py-1.5 text-[11px] text-amber-950"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      ) : null}
    </CardShell>
  );
}
