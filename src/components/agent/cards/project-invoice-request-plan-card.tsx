"use client";

import { FileSpreadsheet, AlertTriangle, CheckCircle2, XCircle, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";
import {
  ENTITY_BLOCK_BUTTON_CLASS,
  ENTITY_ROW_BUTTON_CLASS,
  openEntityResource,
} from "./open-resource";

function formatYuan(cents: number | undefined | null): string {
  if (cents == null || Number.isNaN(Number(cents))) return "¥0.00";
  return `¥${(Number(cents) / 100).toFixed(2)}`;
}

function invoiceTypeLabel(type: string | undefined | null): string {
  if (type === "SPECIAL") return "专票";
  if (type === "NORMAL") return "普票";
  return "待定";
}

type PlanItem = {
  planKey: string;
  orderNos: string[];
  buyerOrganizationName: string;
  sellerName: string | null;
  invoiceType: string | null;
  totalAmountCents: number;
  coverageAllocations: Array<{ orderId: string; orderNo: string; amountCents: number }>;
  missingFields: string[];
  warnings: string[];
};

type ExcludedOrder = {
  orderId: string;
  orderNo: string;
  reasonCode: string;
  message: string;
};

/**
 * Informational card for `finance.plan_project_invoice_requests`.
 * Shows the planning result: eligible orders, excluded orders, and generated plans.
 */
export function ProjectInvoiceRequestPlanCard({
  descriptor,
  onSendPrefilled,
  onApplyViewIntent,
  onOpenResource,
}: AgentCardProps) {
  const props = descriptor.props;

  const project = (props.project ?? {}) as { id?: string; projectNo?: string | null; name?: string };
  const status = typeof props.status === "string" ? props.status : "";
  const plans = (Array.isArray(props.plans) ? props.plans : []) as PlanItem[];
  const excludedOrders = (Array.isArray(props.excludedOrders) ? props.excludedOrders : []) as ExcludedOrder[];
  const questions = (Array.isArray(props.questions) ? props.questions : []) as Array<{ code: string; prompt: string }>;

  const totalPlannedAmount = plans.reduce((s, p) => s + (p.totalAmountCents || 0), 0);
  const eligibleCount = plans.reduce((s, p) => s + p.coverageAllocations.length, 0);
  const projectId = typeof project.id === "string" ? project.id : undefined;
  const handlers = { onOpenResource, onApplyViewIntent };

  const projectHeader = (
    <>
      <FileSpreadsheet className="h-5 w-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {project.name || "未知项目"}
          {project.projectNo ? <span className="ml-1 text-[11px] text-muted-foreground">({project.projectNo})</span> : null}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {status === "READY"
            ? `${plans.length} 张计划 · ${eligibleCount} 笔订单 · 合计 ${formatYuan(totalPlannedAmount)}`
            : status === "NEEDS_INPUT"
              ? "需要补充信息"
              : "无可开票订单"}
        </div>
      </div>
    </>
  );

  return (
    <CardShell title="项目开票规划" state={descriptor.state}>
      {projectId ? (
        <button
          type="button"
          className={ENTITY_BLOCK_BUTTON_CLASS}
          onClick={() => openEntityResource("project", projectId, "打开项目详情", handlers)}
        >
          {projectHeader}
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        </button>
      ) : (
        <div className="flex items-center gap-3 rounded-xl bg-muted/30 px-3 py-2">
          {projectHeader}
        </div>
      )}

      {questions.length > 0 ? (
        <div className="mt-3 space-y-1.5">
          {questions.map((q) => (
            <div key={q.code} className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{q.prompt}</span>
            </div>
          ))}
        </div>
      ) : null}

      {plans.length > 0 ? (
        <div className="mt-3 space-y-2">
          {plans.map((plan, idx) => {
            const canSelect =
              status === "READY" &&
              plan.missingFields.length === 0 &&
              Boolean(plan.sellerName) &&
              Boolean(plan.invoiceType) &&
              Boolean(onSendPrefilled) &&
              projectId;
            return (
              <div key={plan.planKey} className="rounded-lg border border-border/50 px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-muted-foreground">第 {idx + 1} 张</span>
                  <span className="text-sm font-semibold tabular-nums">{formatYuan(plan.totalAmountCents)}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-muted-foreground">
                  <span>购方：{plan.buyerOrganizationName}</span>
                  <span>销方：{plan.sellerName || "待定"}</span>
                  <span>票种：{invoiceTypeLabel(plan.invoiceType)}</span>
                </div>
                {plan.coverageAllocations.length > 0 ? (
                  <div className="mt-1.5 space-y-0.5">
                    <div className="text-[11px] text-muted-foreground">可开票订单</div>
                    {plan.coverageAllocations.map((c) => (
                      <button
                        key={c.orderId}
                        type="button"
                        className={ENTITY_ROW_BUTTON_CLASS}
                        onClick={() => openEntityResource("order", c.orderId, "打开订单详情", handlers)}
                      >
                        <span className="min-w-0 truncate font-medium">
                          {c.orderNo || c.orderId.slice(-6)}
                        </span>
                        <span className="flex shrink-0 items-center gap-1 tabular-nums text-muted-foreground">
                          {formatYuan(c.amountCents)}
                          <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {plan.missingFields.length > 0 ? (
                  <div className="mt-1 text-[11px] text-amber-700">
                    待补充：{plan.missingFields.join("、")}
                  </div>
                ) : null}
                {canSelect ? (
                  <div className="mt-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="w-full"
                      onClick={() =>
                        onSendPrefilled!(
                          `请用 planKey=${plan.planKey} 提交这张开票申请`,
                          { projectId, planKey: plan.planKey },
                        )
                      }
                    >
                      <CheckCircle2 className="mr-1 h-4 w-4" />
                      选择这张开票
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {excludedOrders.length > 0 ? (
        <div className="mt-3">
          <div className="text-[11px] font-medium text-muted-foreground">不可开票订单 ({excludedOrders.length})</div>
          <div className="mt-1 space-y-0.5">
            {excludedOrders.slice(0, 5).map((eo) => (
              <button
                key={eo.orderId}
                type="button"
                className={ENTITY_ROW_BUTTON_CLASS}
                onClick={() => openEntityResource("order", eo.orderId, "打开订单详情", handlers)}
              >
                <span className="flex min-w-0 items-start gap-1.5 text-muted-foreground">
                  <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-red-400" />
                  <span className="truncate">{eo.orderNo}：{eo.message}</span>
                </span>
                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
              </button>
            ))}
            {excludedOrders.length > 5 ? (
              <div className="text-[11px] text-muted-foreground">另有 {excludedOrders.length - 5} 笔</div>
            ) : null}
          </div>
        </div>
      ) : null}

      {status === "READY" && plans.length > 0 && onSendPrefilled ? (
        <div className="mt-3">
          <Button
            size="sm"
            className="w-full"
            onClick={() => onSendPrefilled("请开始逐张确认开票申请计划")}
          >
            <CheckCircle2 className="mr-1 h-4 w-4" />
            开始逐张确认
          </Button>
        </div>
      ) : null}
    </CardShell>
  );
}
