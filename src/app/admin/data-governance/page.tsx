import { redirect } from "next/navigation";

type SearchParams = Record<string, string | string[] | undefined>;

const LEGACY_TAB_MAP: Record<string, string> = {
  center: "org-bindings",
  missingProfiles: "org-bindings",
  emptyShellCustomers: "org-bindings",
  emptyShellOrders: "org-bindings",
  repMismatch: "rep-mismatch",
  "rep-mismatch": "rep-mismatch",
  suspectedMisbinding: "org-bindings",
  noCustomerOrders: "order-bindings",
  "order-org-missing": "order-org-bindings",
  orderOrgMissing: "order-org-bindings",
  orderOrgBindings: "order-org-bindings",
};

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

// 数据治理入口收敛：旧「数据治理中心」跳到新治理工作台，并保留可识别的旧 tab 深链。
export default async function Page({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const params = (await searchParams) ?? {};
  const rawTab = first(params.tab);
  const tab = rawTab && LEGACY_TAB_MAP[rawTab] ? LEGACY_TAB_MAP[rawTab] : "org-bindings";
  redirect(`/admin/governance?tab=${tab}`);
}
