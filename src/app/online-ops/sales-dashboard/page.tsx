import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { OnlineOpsSalesDashboardPanel } from "@/portals/online-ops/sales-dashboard-panel";

/**
 * 销量看板（ONLINE_OPS 门户 P2，设计 §10）。
 * 只读；数据 API 走现有 Order scope（部门隔离）。
 */
export default function SalesDashboardPage() {
  return (
    <PageShell>
      <PageHeader
        title="销量看板"
        description="网络运营部专属：本部门订单金额、单量与趋势聚合。"
      />
      <OnlineOpsSalesDashboardPanel />
    </PageShell>
  );
}
