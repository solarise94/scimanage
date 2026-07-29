import { centsToYuan } from "@/lib/finance/money";
import { RECEIVABLE_BELOW_THRESHOLD_CENTS } from "@/lib/finance/collection-analysis";

export function formatCollectionCycle(days: number | null, pairCount: number): string {
  if (days == null) return "—";
  return `${days}天 (${pairCount})`;
}

export function formatCollectionRate(
  rate: number | null,
  receiptCents: number,
  receivableCents: number,
  belowThreshold = receivableCents < RECEIVABLE_BELOW_THRESHOLD_CENTS,
): string {
  if (belowThreshold || rate == null || receivableCents <= 0) return "—";
  const receiptWan = (centsToYuan(receiptCents) / 10000).toFixed(1);
  const receivableWan = (centsToYuan(receivableCents) / 10000).toFixed(1);
  return `${Math.round(rate * 100)}% (${receiptWan}万/${receivableWan}万)`;
}
