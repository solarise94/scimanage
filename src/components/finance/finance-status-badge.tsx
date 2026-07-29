import { Badge } from "@/components/ui/badge";

type BadgeVariant = "default" | "secondary" | "outline" | "destructive";

interface StatusConfig { label: string; variant: BadgeVariant; className?: string }

// ── 发票状态 ──
const INVOICE_STATUS_MAP: Record<string, StatusConfig> = {
  DRAFT: { label: "草稿", variant: "secondary" },
  REQUESTED: { label: "已申请", variant: "default" },
  ISSUED: { label: "已开具", variant: "outline" },
  CANCELLED: { label: "已取消", variant: "destructive" },
};

// ── 回款状态 ──
const PAYMENT_STATUS_MAP: Record<string, StatusConfig> = {
  UNINVOICED: { label: "未开票", variant: "secondary", className: "text-muted-foreground bg-muted/50 border-muted-foreground/20" },
  UNPAID: { label: "未回款", variant: "outline", className: "bg-warning-bg text-warning border-warning-border" },
  PARTIAL: { label: "部分回款", variant: "secondary" },
  PAID: { label: "已回款", variant: "default" },
};

// ── 匹配状态 ──
const MATCH_STATUS_MAP: Record<string, StatusConfig> = {
  UNMATCHED: { label: "未匹配", variant: "secondary" },
  AUTO_MATCHED: { label: "自动匹配", variant: "default" },
  MANUAL_MATCHED: { label: "人工绑定", variant: "outline" },
  CONFLICT: { label: "冲突", variant: "destructive" },
};

// ── 财务口径 ──
const TREATMENT_STATUS_MAP: Record<string, StatusConfig> = {
  AUTO: { label: "自动", variant: "secondary" },
  STANDALONE: { label: "独立计入", variant: "default" },
  PROJECT_INCLUDED: { label: "并入项目", variant: "outline" },
  EXCLUDED: { label: "排除", variant: "destructive" },
};

// ── 历史/归档状态 ──
const HISTORY_STATUS_MAP: Record<string, StatusConfig> = {
  ARCHIVED: { label: "历史只读", variant: "outline" },
  DEPRECATED: { label: "已停用", variant: "secondary" },
};

type StatusGroup = "invoice" | "payment" | "match" | "treatment" | "history";

interface FinanceStatusBadgeProps {
  status: string;
  group?: StatusGroup;
  className?: string;
}

export function FinanceStatusBadge({ status, group, className }: FinanceStatusBadgeProps) {
  let config: StatusConfig | undefined;

  if (group) {
    const map =
      group === "invoice"
        ? INVOICE_STATUS_MAP
        : group === "payment"
          ? PAYMENT_STATUS_MAP
          : group === "match"
            ? MATCH_STATUS_MAP
            : group === "treatment"
              ? TREATMENT_STATUS_MAP
              : HISTORY_STATUS_MAP;
    config = map[status];
  }

  if (!config) {
    // Fallback: search all maps
    config =
      INVOICE_STATUS_MAP[status] ??
      PAYMENT_STATUS_MAP[status] ??
      MATCH_STATUS_MAP[status] ??
      TREATMENT_STATUS_MAP[status] ??
      HISTORY_STATUS_MAP[status] ??
      { label: status, variant: "secondary" };
  }

  const mergedClass = [config.className, className].filter(Boolean).join(" ");

  return (
    <Badge variant={config.variant} className={mergedClass || undefined}>
      {config.label}
    </Badge>
  );
}

// Convenience exports for direct use
export function InvoiceStatusBadge({ status, className }: { status: string; className?: string }) {
  return <FinanceStatusBadge status={status} group="invoice" className={className} />;
}

export function PaymentStatusBadge({ status, className }: { status: string; className?: string }) {
  return <FinanceStatusBadge status={status} group="payment" className={className} />;
}

export function MatchStatusBadge({ status, className }: { status: string; className?: string }) {
  return <FinanceStatusBadge status={status} group="match" className={className} />;
}

export function TreatmentStatusBadge({ status, className }: { status: string; className?: string }) {
  return <FinanceStatusBadge status={status} group="treatment" className={className} />;
}
