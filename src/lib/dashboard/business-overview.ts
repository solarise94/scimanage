import { getOrderDashboardSummary } from "@/lib/orders/dashboard-summary";
import { getFinanceProfileScopeWhere, getFinanceProjectScopeWhere } from "@/lib/finance/permissions";
import { getFinanceSummary } from "@/lib/finance/calculations";
import { getCrmAdminDashboardSummary, getCrmPersonalDashboardSummary } from "@/lib/crm/dashboard-summary";
import { getRepresentativeOpsDashboardSummary } from "@/lib/crm/representative-ops-summary";
import type { DashboardBusinessOverview, DashboardCrmSummary, DashboardSection } from "@/lib/dashboard/types";

async function loadSection<T>(loader: (() => Promise<T>) | null): Promise<DashboardSection<T>> {
  if (!loader) return { data: null, error: null };
  try {
    return { data: await loader(), error: null };
  } catch (error) {
    console.error("[DASHBOARD] business overview section failed", error);
    return { data: null, error: "数据暂时无法加载" };
  }
}

export async function getDashboardBusinessOverview(
  userId: string,
  role: string,
  department: string,
  now: Date = new Date(),
): Promise<DashboardBusinessOverview> {
  const canUseOrders = ["ADMIN", "USER", "REGIONAL_MANAGER", "REPRESENTATIVE"].includes(role);
  const canUseFinance = ["ADMIN", "USER", "REGIONAL_MANAGER"].includes(role);
  const hasPersonalCrm = role === "REPRESENTATIVE" || role === "REGIONAL_MANAGER";
  const hasAdminCrm = role === "ADMIN";
  const hasRepresentativeOps = role === "ADMIN" || role === "REGIONAL_MANAGER";

  const [orders, finance, crm, representativeOps] = await Promise.all([
    loadSection(canUseOrders ? () => getOrderDashboardSummary(userId, role, department, now) : null),
    loadSection(canUseFinance
      ? async () => {
          const [profileScope, projectScope] = await Promise.all([
            getFinanceProfileScopeWhere(userId, role, department),
            getFinanceProjectScopeWhere(userId, role, department),
          ]);
          const summary = await getFinanceSummary(
            profileScope,
            projectScope,
            false,
            now,
            role === "ADMIN" ? null : department,
          );
          return {
            monthBusinessAmount: summary.monthBusinessAmount,
            weekBusinessAmount: summary.weekBusinessAmount,
            monthReceiptAmount: summary.monthReceiptAmount,
            monthReceiptCount: summary.monthReceiptCount,
            profitAmount: summary.profitAmount,
            profitRate: summary.profitRate,
          };
        }
      : null),
    loadSection<DashboardCrmSummary>(hasAdminCrm
      ? () => getCrmAdminDashboardSummary(userId, role, now).then((summary) => ({ mode: "admin" as const, ...summary }))
      : hasPersonalCrm
        ? () => getCrmPersonalDashboardSummary(userId, role, now).then((summary) => ({ mode: "personal" as const, ...summary }))
        : null),
    loadSection(hasRepresentativeOps
      ? () => getRepresentativeOpsDashboardSummary(userId, role, now)
      : null),
  ]);

  return {
    generatedAt: now.toISOString(),
    orders,
    finance,
    crm,
    representativeOps,
  };
}
