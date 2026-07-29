const ORDER_CATEGORY_LABELS: Record<string, string> = {
  SERVICE: "服务",
  PRODUCT: "商品",
  MIXED: "混合",
  UNKNOWN: "未分类",
};

export function getOrderCategoryLabel(value?: string | null): string {
  if (value == null) return "未分类";
  const raw = String(value).trim();
  if (!raw) return "未分类";
  return ORDER_CATEGORY_LABELS[raw] || raw;
}
