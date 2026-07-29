const PROJECT_TYPE_LABELS: Record<string, string> = {
  商品: "商品",
  产品: "商品",
  货物: "商品",
  服务: "服务",
  预存款抵扣: "预存款抵扣",
  product: "商品",
  products: "商品",
  service: "服务",
  mixed: "混合",
  unknown: "未分类",
};

export function normalizeProjectType(value?: string | null): string | null {
  if (value == null) return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  return PROJECT_TYPE_LABELS[raw] || raw;
}

export function getProjectTypeLabel(value?: string | null): string {
  return normalizeProjectType(value) || "未分类";
}

export function isProductProjectType(value?: string | null): boolean {
  return normalizeProjectType(value) === "商品";
}
