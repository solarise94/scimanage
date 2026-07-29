export interface NotificationPrefs {
  emailOnReminder: boolean;
  emailOnStatusChange: boolean;
  emailOnTicketReply: boolean;
  emailOnComment: boolean;
}

export interface CustomerItem {
  id: string;
  customerCode: string;
  name: string;
  principal?: string | null;
  email?: string | null;
  wechat?: string | null;
  organization?: string | null;
  address?: string | null;
  miniProgramId?: string | null;
  organizationId?: string | null;
  organizationSiteId?: string | null;
  organizationRawInput?: string | null;
  archived: boolean;
  archivedAt?: string | null;
  deleted: boolean;
  deletedAt?: string | null;
  mergedIntoId?: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: { projects: number };
}

export interface ProjectItem {
  id: string;
  name: string;
  projectNo?: string | null;
  description?: string | null | undefined;
  orderNumber?: string | null | undefined;
  organization?: string | null | undefined;
  client?: string | null | undefined;
  representative?: string | null | undefined;
  representativeId?: string | null | undefined;
  profileId?: string | null | undefined;
  status: string;
  progress: number;
  startDate?: string | null | undefined;
  endDate?: string | null | undefined;
  archived: boolean;
  deleted: boolean;
  deletedAt?: string | null;
  deletedReason?: string | null;
  projectType?: string | null | undefined;
  projectContent?: string | null | undefined;
  quantity?: number | null | undefined;
  procurementSource?: string | null | undefined;
  brand?: string | null | undefined;
  techSupport?: string | null | undefined;
  budgetAmount?: number | null | undefined;
  budgetCost?: number | null | undefined;
  members?: Array<{
    user: { id: string; name: string; email: string; avatar?: string | null };
    role: string;
  }>;
  _count?: { tickets: number; comments: number; attachments?: number };
  rep?: { id: string; name: string; email: string } | null;
  cust?: { id: string; name: string; customerCode: string; organization?: string | null; organizationId?: string | null } | null;
  orderLinks?: Array<{
    id: string;
    treatment: string;
    allocatedAmount: number | null;
    isPrimary: boolean;
    relationType: string;
    order: {
      id: string;
      orderNo: string;
      title: string;
      category: string;
      status: string;
      totalAmount: number;
      financeAmountOverride: number | null;
      financeTreatment: string;
      source: string;
      externalOrderNo: string | null;
      customer?: { id: string; name: string } | null;
      _count?: { projectLinks: number; invoiceRequests?: number; financeCosts?: number } | null;
    };
  }>;
  archiveNotice?: { id: string; notifiedAt: string; archivedAt: string | null } | null;
}

export interface TicketItem {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority: string;
  reminderDate?: string | null;
  reminderSent: boolean;
  projectId: string;
  project?: { id: string; name: string };
  assignee?: { id: string; name: string; avatar?: string | null } | null;
  assigneeId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineItem {
  id: string;
  type: string;
  content: string;
  metadata: string | null;
  createdAt: string;
  user: { id: string; name: string; avatar?: string | null } | null;
  kind: "activity" | "comment" | "attachment" | "status" | "plugin";
}

export interface TicketReplyItem {
  id: string;
  content: string;
  ticketId: string;
  author: { id: string; name: string; avatar?: string | null };
  createdAt: string;
}

export interface NotificationItem {
  id: string;
  userId: string;
  title: string;
  content: string;
  type: string;
  read: boolean;
  link?: string | null;
  emailStatus?: string | null;
  emailError?: string | null;
  createdAt: string;
}

export interface DashboardStats {
  totalProjects: number;
  inProgressProjects: number;
  completedProjects: number;
  pendingTickets: number;
  weekProjects: number;
  weekTickets: number;
  statusDistribution: Array<{ status: string; _count: { status: number } }>;
  ticketTrend: Array<{ date: string; count: number }>;
}
