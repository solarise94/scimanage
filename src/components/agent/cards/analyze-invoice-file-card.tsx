"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, FileSearch, Loader2, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";

function formatYuan(cents: number | undefined | null): string {
  if (cents == null || Number.isNaN(Number(cents))) return "-";
  return `¥${(Number(cents) / 100).toFixed(2)}`;
}

function matchStatusLabel(status: string | undefined): { label: string; tone: string } {
  switch (status) {
    case "EXACT":
      return { label: "唯一匹配", tone: "bg-emerald-50 text-emerald-700 border-emerald-200" };
    case "AMBIGUOUS":
      return { label: "多个候选", tone: "bg-amber-50 text-amber-700 border-amber-200" };
    case "NO_MATCH":
      return { label: "未匹配", tone: "bg-slate-50 text-slate-700 border-slate-200" };
    case "CONFLICT":
      return { label: "事实冲突", tone: "bg-rose-50 text-rose-700 border-rose-200" };
    case "DUPLICATE":
      return { label: "重复发票", tone: "bg-rose-50 text-rose-700 border-rose-200" };
    case "OCR_FAILED":
      return { label: "识别失败", tone: "bg-rose-50 text-rose-700 border-rose-200" };
    default:
      return { label: status || "已分析", tone: "bg-muted text-muted-foreground border-border" };
  }
}

function invoiceTypeLabel(type: string | undefined | null): string {
  if (type === "SPECIAL") return "专票";
  if (type === "NORMAL") return "普票";
  if (type === "UNKNOWN") return "未识别";
  return type || "-";
}

/**
 * Result card for `finance.analyze_invoice_file`.
 *
 * P0-4：当 analyze 唯一匹配（EXACT）时，propose_invoice_registration facade 已自动产
 * register_issued_invoice 的 PENDING proposal；本卡片复用现有 proposal confirm 链路，
 * 加「确认登记」按钮 → onConfirmProposal(proposal.id)。无 proposal 句柄（多候选/无匹配/重复）
 * 时按钮不出现。
 */
export function AnalyzeInvoiceFileCard({
  descriptor,
  proposal,
  proposalBusyId,
  onConfirmProposal,
}: AgentCardProps) {
  const props = descriptor.props;
  const staging = (props.staging ?? {}) as Record<string, unknown>;
  const extracted = (props.extracted ?? {}) as Record<string, unknown>;
  const match = (props.match ?? {}) as Record<string, unknown>;
  const fileName =
    (typeof staging.fileName === "string" ? staging.fileName : null)
    || (typeof props.fileName === "string" ? props.fileName : "发票文件");
  const matchStatus = typeof match.status === "string" ? match.status : "";
  const statusMeta = matchStatusLabel(matchStatus);
  const candidates = Array.isArray(match.candidates)
    ? (match.candidates as Array<Record<string, unknown>>)
    : [];
  const warnings = Array.isArray(extracted.warnings)
    ? extracted.warnings.filter((x): x is string => typeof x === "string")
    : [];
  const isRed = extracted.isRedInvoice === true;

  // P0-4：唯一匹配（EXACT）且服务端已产 register proposal → 启用确认登记按钮。
  const proposalId = proposal?.id ?? null;
  const canConfirm = matchStatus === "EXACT" && !!proposalId && !!onConfirmProposal;
  const [confirming, setConfirming] = useState(false);
  const busy = confirming || (proposalId ? proposalBusyId === proposalId : false);

  async function handleConfirm() {
    if (!proposalId) return;
    setConfirming(true);
    try {
      await onConfirmProposal(proposalId);
    } catch {
      // 错误由父级处理（toast）
    } finally {
      setConfirming(false);
    }
  }

  if (descriptor.state === "loading") {
    return (
      <CardShell title="识别发票中" state="loading">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在调用 OCR 并匹配开票申请…
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell
      title="发票识别结果"
      state={descriptor.state}
      footer={
        canConfirm ? (
          <Button size="sm" className="w-full" disabled={busy} onClick={handleConfirm}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            确认登记
          </Button>
        ) : null
      }
    >
      <div className="flex items-start justify-between gap-2 rounded-xl bg-muted/30 px-3 py-2">
        <div className="flex min-w-0 items-start gap-2">
          <FileSearch className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{fileName}</div>
            <div className="text-[11px] text-muted-foreground">
              {typeof extracted.invoiceNumber === "string" && extracted.invoiceNumber
                ? `NO. ${extracted.invoiceNumber}`
                : "未识别发票号"}
              {" · "}
              {formatYuan(
                typeof extracted.totalAmountCents === "number" ? extracted.totalAmountCents : null,
              )}
              {" · "}
              {invoiceTypeLabel(
                typeof extracted.invoiceType === "string" ? extracted.invoiceType : null,
              )}
            </div>
          </div>
        </div>
        <Badge variant="outline" className={`shrink-0 text-[10px] ${statusMeta.tone}`}>
          {matchStatus === "EXACT" ? (
            <CheckCircle2 className="h-3 w-3" />
          ) : (
            <AlertCircle className="h-3 w-3" />
          )}
          {statusMeta.label}
        </Badge>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-muted/20 px-2.5 py-1.5">
          <div className="text-[10px] text-muted-foreground">购方</div>
          <div className="truncate font-medium">
            {typeof extracted.buyerName === "string" && extracted.buyerName
              ? extracted.buyerName
              : "-"}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">
            {typeof extracted.buyerTaxIdMasked === "string" ? extracted.buyerTaxIdMasked : ""}
          </div>
        </div>
        <div className="rounded-lg bg-muted/20 px-2.5 py-1.5">
          <div className="text-[10px] text-muted-foreground">开票日期</div>
          <div className="font-medium">
            {typeof extracted.issuedAt === "string" && extracted.issuedAt
              ? extracted.issuedAt
              : "-"}
          </div>
        </div>
      </div>

      {isRed ? (
        <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50/80 px-3 py-2 text-xs text-rose-800">
          检测到红字发票，不能走普通登记流程。
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className="mt-3 rounded-lg bg-amber-50/70 px-3 py-2 text-[11px] text-amber-900">
          {warnings.slice(0, 4).map((w) => (
            <div key={w}>· {w}</div>
          ))}
        </div>
      ) : null}

      {candidates.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
            候选申请（{candidates.length}）
          </div>
          <div className="space-y-1.5">
            {candidates.slice(0, 5).map((c) => {
              const id = typeof c.invoiceRequestId === "string" ? c.invoiceRequestId : "";
              const canSelect = c.canSelect !== false;
              const conflicts = Array.isArray(c.conflicts)
                ? c.conflicts.filter((x): x is string => typeof x === "string")
                : [];
              const reasons = Array.isArray(c.reasons)
                ? c.reasons.filter((x): x is string => typeof x === "string")
                : [];
              return (
                <div
                  key={id || JSON.stringify(c).slice(0, 40)}
                  className={`rounded-lg border px-3 py-2 text-xs ${
                    canSelect
                      ? "border-border/50 bg-background/60"
                      : "border-rose-200/70 bg-rose-50/40"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 truncate font-medium">
                      {typeof c.buyerOrganizationName === "string"
                        ? c.buyerOrganizationName
                        : "未知购方"}
                    </div>
                    <div className="shrink-0 tabular-nums text-muted-foreground">
                      {formatYuan(
                        typeof c.totalAmountCents === "number" ? c.totalAmountCents : null,
                      )}
                      {typeof c.score === "number" ? ` · ${c.score}分` : ""}
                    </div>
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    {typeof c.orderNo === "string" && c.orderNo ? `${c.orderNo} · ` : ""}
                    {id ? `…${id.slice(-8)}` : ""}
                    {reasons[0] ? ` · ${reasons[0]}` : ""}
                  </div>
                  {conflicts[0] ? (
                    <div className="mt-0.5 text-[10px] text-rose-700">{conflicts[0]}</div>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="mt-2 text-[10px] text-muted-foreground">
            请对当前这一张单独生成登记确认；确认后继续下一张。
          </div>
        </div>
      ) : (
        <div className="mt-3 text-[11px] text-muted-foreground">
          {matchStatus === "DUPLICATE"
            ? "发票号或文件已登记过，默认跳过本张。"
            : matchStatus === "NO_MATCH"
              ? "未找到可用开票申请，可手工指定申请或跳过。"
              : "暂无候选申请。"}
        </div>
      )}
    </CardShell>
  );
}
