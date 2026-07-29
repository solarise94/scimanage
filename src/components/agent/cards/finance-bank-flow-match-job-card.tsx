"use client";

import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, XCircle, Clock3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";

type JobPayload = {
  job: {
    id: string;
    status: string;
    workspaceId: string | null;
  };
  items: Array<{
    id: string;
    status: string;
    sequenceNo: number;
    errorCode?: string | null;
  }>;
};

const TERMINAL = new Set([
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "CANCELLED",
  "FAILED",
  "EXPIRED",
]);

/**
 * Progress card for async `finance.match_bank_flow_rows` (mode=async).
 * Polls GET /api/agent/background-jobs/[id].
 */
export function FinanceBankFlowMatchJobCard({ descriptor }: AgentCardProps) {
  const props = descriptor.props;
  const jobId = typeof props.jobId === "string" ? props.jobId : "";
  const workspaceId = typeof props.workspaceId === "string" ? props.workspaceId : "";
  const queued =
    typeof props.rowCount === "number"
      ? props.rowCount
      : typeof (props.summary as { queued?: number } | undefined)?.queued === "number"
        ? (props.summary as { queued: number }).queued
        : 0;

  const [data, setData] = useState<JobPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const res = await fetch(`/api/agent/background-jobs/${encodeURIComponent(jobId)}`);
        if (!res.ok) {
          if (!cancelled) setError(res.status === 404 ? "任务不存在" : "查询失败");
          return;
        }
        const json = (await res.json()) as JobPayload;
        if (cancelled) return;
        setData(json);
        setError(null);
        if (!TERMINAL.has(json.job.status)) {
          timer = setTimeout(() => void poll(), 2500);
        }
      } catch {
        if (!cancelled) setError("网络错误");
        timer = setTimeout(() => void poll(), 4000);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  const items = data?.items ?? [];
  const done = items.filter((i) => i.status === "DONE" || i.status === "SKIPPED").length;
  const failed = items.filter((i) => i.status === "FAILED").length;
  const total = items.length || queued;
  const status = data?.job.status ?? "QUEUED";
  const isTerminal = TERMINAL.has(status);
  const isRunning = status === "RUNNING" || status === "QUEUED";

  return (
    <CardShell title="银行流水异步匹配" state={descriptor.state}>
      <div className="flex items-start justify-between gap-2 rounded-xl bg-muted/30 px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            {isRunning ? (
              <Loader2 className="h-4 w-4 animate-spin text-sky-600" />
            ) : status === "COMPLETED" || status === "COMPLETED_WITH_ERRORS" ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            ) : (
              <XCircle className="h-4 w-4 text-rose-600" />
            )}
            <span>
              {isRunning
                ? "匹配进行中"
                : status === "COMPLETED"
                  ? "匹配完成"
                  : status === "COMPLETED_WITH_ERRORS"
                    ? "完成（含失败）"
                    : status === "CANCELLED"
                      ? "已取消"
                      : "匹配失败"}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {total > 0 ? `${done}/${total} 行` : `${queued} 行排队`}
            {failed > 0 ? ` · ${failed} 失败` : null}
            {workspaceId ? ` · 工作区 …${workspaceId.slice(-6)}` : null}
          </div>
        </div>
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {status}
        </Badge>
      </div>

      {error ? (
        <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50/70 px-3 py-2 text-[11px] text-rose-900">
          {error}
        </div>
      ) : null}

      {isTerminal && (status === "COMPLETED" || status === "COMPLETED_WITH_ERRORS") ? (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-emerald-200/80 bg-emerald-50/70 px-3 py-2 text-[11px] text-emerald-950">
          <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            匹配已写入工作区。请让 Agent 查看匹配结果，或对歧义行调用
            finance.get_bank_flow_row / update_bank_flow_selection。
          </span>
        </div>
      ) : null}

      {jobId ? (
        <div className="mt-2 text-[10px] text-muted-foreground">任务 …{jobId.slice(-8)}</div>
      ) : null}
    </CardShell>
  );
}
