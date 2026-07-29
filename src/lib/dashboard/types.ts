export type DashboardSection<T> = {
  data: T | null;
  error: string | null;
};

export type DashboardOrdersSummary = {
  totalCount: number;
  monthNewCount: number;
  lastMonthNewCount: number;
  /** 最近 6 个自然月（含本月）趋势；amount 单位元 */
  monthlyTrend: Array<{ month: string; label: string; count: number; amount: number }>;
};

export type DashboardFinanceSummary = {
  monthBusinessAmount: number;
  weekBusinessAmount: number;
  monthReceiptAmount: number;
  monthReceiptCount: number;
  profitAmount: number;
  profitRate: number | null;
};

export type DashboardCrmMonthlyTrendPoint = {
  month: string;
  label: string;
  newCustomers: number;
  interactions: number;
};

export type DashboardCrmSummary =
  | {
      mode: "admin";
      totalProfiles: number;
      pendingFollowUps: number;
      overdueFollowUps: number;
      communicationCoverageRate30d: number;
      monthlyTrend: DashboardCrmMonthlyTrendPoint[];
    }
  | {
      mode: "personal";
      myCustomerCount: number;
      overdueTaskCount: number;
      dueTodayTaskCount: number;
      suggestedContactCount: number;
      suggestedVisitCount: number;
      monthlyTrend: DashboardCrmMonthlyTrendPoint[];
    };

export type DashboardRepresentativeOpsSummary = {
  activeRepresentativeCount: number;
  interactionCount30d: number;
  overdueFollowUps: number;
  longUnvisitedCount: number;
  hasManagedRepresentatives: boolean;
};

export interface DashboardBusinessOverview {
  generatedAt: string;
  orders: DashboardSection<DashboardOrdersSummary>;
  finance: DashboardSection<DashboardFinanceSummary>;
  crm: DashboardSection<DashboardCrmSummary>;
  representativeOps: DashboardSection<DashboardRepresentativeOpsSummary>;
}
