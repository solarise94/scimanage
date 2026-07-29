import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { OnlineOpsServiceAccountsPanel } from "@/portals/online-ops/service-accounts-panel";

/**
 * 客服账号管理页（ONLINE_OPS 门户 P1，设计 §10）。
 * 路由本身不带权限；API /api/online-ops/service-accounts 由 assertPortalAccess + 部门校验保护。
 */
export default function ServiceAccountsPage() {
  return (
    <PageShell>
      <PageHeader
        title="客服账号管理"
        description="网络运营部专属：管理客服微信账号、负责人与启用状态。"
      />
      <OnlineOpsServiceAccountsPanel />
    </PageShell>
  );
}
