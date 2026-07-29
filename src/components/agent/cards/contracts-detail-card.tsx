"use client";

import { Download, FileSignature, Building2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";

function formatYuan(cents: number | undefined | null): string {
  if (cents == null || Number.isNaN(Number(cents))) return "¥0.00";
  return `¥${(Number(cents) / 100).toFixed(2)}`;
}

const STATUS_LABEL: Record<string, string> = {
  GENERATED: "已生成",
  PENDING_FILE: "待文件",
  ARCHIVED: "已归档",
};

function statusClassName(status?: string): string {
  switch (status) {
    case "GENERATED":
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
    case "PENDING_FILE":
      return "bg-amber-50 text-amber-700 border-amber-200";
    default:
      return "bg-muted/40 text-muted-foreground border-border/40";
  }
}

/**
 * Contract detail card for `contracts.get_detail`.
 */
export function ContractsDetailCard({ descriptor }: AgentCardProps) {
  const props = descriptor.props;
  const contractNo = typeof props.contractNo === "string" ? props.contractNo : "-";
  const status = typeof props.status === "string" ? props.status : undefined;
  const category = typeof props.category === "string" ? props.category : null;
  const totalAmountCents =
    typeof props.totalAmountCents === "number" ? props.totalAmountCents : undefined;
  const downloadUrl = typeof props.downloadUrl === "string" ? props.downloadUrl : null;
  const creatorName = typeof props.creatorName === "string" ? props.creatorName : null;
  const createdAt = typeof props.createdAt === "string" ? props.createdAt.slice(0, 10) : null;

  const seller = (props.seller ?? {}) as Record<string, unknown>;
  const buyer = (props.buyer ?? {}) as Record<string, unknown>;
  const sellerName =
    typeof seller.companyName === "string"
      ? seller.companyName
      : typeof seller.name === "string"
        ? seller.name
        : null;
  const buyerName =
    typeof buyer.buyerOrgName === "string"
      ? buyer.buyerOrgName
      : typeof buyer.name === "string"
        ? buyer.name
        : null;

  const coveredOrders = Array.isArray(props.coveredOrders)
    ? (props.coveredOrders as Array<{ orderNo?: string; orderId?: string }>)
    : [];

  return (
    <CardShell title="合同详情" state={descriptor.state}>
      <div className="flex items-start justify-between gap-2 rounded-xl bg-muted/30 px-3 py-2">
        <div className="flex min-w-0 items-start gap-2">
          <FileSignature className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{contractNo}</div>
            <div className="text-[11px] text-muted-foreground">
              {formatYuan(totalAmountCents)}
              {category ? ` · ${category}` : null}
              {createdAt ? ` · ${createdAt}` : null}
            </div>
          </div>
        </div>
        {status ? (
          <Badge variant="outline" className={`shrink-0 text-[10px] ${statusClassName(status)}`}>
            {STATUS_LABEL[status] ?? status}
          </Badge>
        ) : null}
      </div>

      {(sellerName || buyerName) ? (
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
          {sellerName ? (
            <div className="rounded-lg bg-muted/20 px-2.5 py-2">
              <div className="mb-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                <Building2 className="h-3 w-3" />
                卖方
              </div>
              <div className="font-medium">{sellerName}</div>
            </div>
          ) : null}
          {buyerName ? (
            <div className="rounded-lg bg-muted/20 px-2.5 py-2">
              <div className="mb-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                <Building2 className="h-3 w-3" />
                买方
              </div>
              <div className="font-medium">{buyerName}</div>
            </div>
          ) : null}
        </div>
      ) : null}

      {coveredOrders.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">
            覆盖订单（{coveredOrders.length}）
          </div>
          <div className="flex flex-wrap gap-1">
            {coveredOrders.slice(0, 8).map((o) => (
              <span
                key={o.orderId ?? o.orderNo}
                className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {o.orderNo || o.orderId}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {creatorName ? (
        <div className="mt-2 text-[11px] text-muted-foreground">创建人 {creatorName}</div>
      ) : null}

      {downloadUrl ? (
        <div className="mt-3">
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={() => window.open(downloadUrl, "_blank", "noopener,noreferrer")}
          >
            <Download className="h-4 w-4" />
            下载合同
          </Button>
          <div className="mt-1 truncate text-[10px] text-muted-foreground">{downloadUrl}</div>
        </div>
      ) : (
        <div className="mt-3 rounded-lg bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
          合同文件暂不可下载
        </div>
      )}
    </CardShell>
  );
}
