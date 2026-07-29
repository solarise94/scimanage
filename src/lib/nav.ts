import type { ElementType } from "react";
import {
  LayoutDashboard,
  Package,
  Boxes,
  FolderKanban,
  Ticket,
  MessageSquareText,
  HeartHandshake,
  Banknote,
  Radio,
  Users,
  UserCog,
  MapPin,
  Link2,
  FileText,
  FileSignature,
  Mail,
  MailCheck,
  MoreHorizontal,
  Truck,
  Calculator,
  Building2,
} from "lucide-react";
import {
  Headphones,
  LineChart,
} from "lucide-react";
import { canAccessOrders, canAccessFinance, canAccessSupplyChain, canAccessCosting, canAccessAgent, isAdmin, isInternalStaff } from "./role-guards";
import {
  clientPortalHasCapability,
  type ClientPortalCapability,
} from "./portal/client-config";

export type NavItem = {
  href: string;
  label: string;
  icon: ElementType;
  adminOnly?: boolean;
  /** 仅在移动端"更多"抽屉中展示，桌面 Sidebar 隐藏。 */
  mobileOnly?: boolean;
  badge?: string;
  /**
   * 该入口只属于某个 Portal 的 capability 时声明；与当前 Portal 不匹配则隐藏。
   * undefined 表示两门户共享。
   */
  portalCapability?: ClientPortalCapability;
};

export type NavGroup = {
  title: string;
  items: NavItem[];
};

/** Items that should never be considered active for a given prefix. */
const AMBIGUOUS_PREFIXES: Record<string, string[]> = {
  "/projects": ["/projects-archive"],
};

/**
 * Unified active matcher used by both Sidebar and MobileNav.
 *
 * - `/crm` is exact-match only (so `/crm/customers` does not light up the CRM root tab).
 * - Other items use `pathname.startsWith(href)` with a small exclusion list for ambiguous prefixes.
 */
export function isActiveNavItem(pathname: string, href: string): boolean {
  if (href === "/crm") {
    return pathname === "/crm";
  }

  if (!pathname.startsWith(href)) {
    return false;
  }

  const exclusions = AMBIGUOUS_PREFIXES[href];
  if (exclusions) {
    return !exclusions.some((prefix) => pathname.startsWith(prefix));
  }

  return true;
}

/** Full navigation groups used by the desktop Sidebar and the mobile overflow drawer. */
export function getNavGroups(role?: string | null): NavGroup[] {
  const core: NavGroup = {
    title: "核心业务",
    items: [
      { href: "/dashboard", label: "仪表盘", icon: LayoutDashboard },
    ],
  };

  // Agent：代表正式使用（移动底栏/抽屉）；ADMIN 调试可见（桌面侧栏也显示）。
  if (canAccessAgent(role)) {
    core.items.push({
      href: "/agent",
      label: "Agent",
      icon: MessageSquareText,
      mobileOnly: !isAdmin(role),
    });
  }

  if (canAccessOrders(role)) {
    core.items.push({ href: "/orders", label: "订单管理", icon: Package });
  }

  core.items.push(
    { href: "/projects", label: "项目", icon: FolderKanban },
    { href: "/tickets", label: "工单", icon: Ticket }
  );

  const ops: NavGroup = {
    title: "运营模块",
    items: [
      { href: "/crm", label: "CRM 管理", icon: HeartHandshake },
    ],
  };

  // 销售代表看“我的汇报”；管理员/区域经理才看“代表运营”
  // 代表运营视角属于地推门户 capability（representative-ops）。
  if (role === "REPRESENTATIVE") {
    ops.items.push({
      href: "/crm/my-report",
      label: "我的汇报",
      icon: FileText,
      portalCapability: "representative-ops",
    });
  } else if (role && role !== "REPRESENTATIVE") {
    ops.items.push({
      href: "/crm/representatives",
      label: "代表运营",
      icon: Radio,
      portalCapability: "representative-ops",
    });
  }

  if (canAccessSupplyChain(role)) {
    ops.items.push({ href: "/supply-chain", label: "供应链", icon: Truck });
  }

  if (isInternalStaff(role)) {
    ops.items.push({ href: "/products", label: "产品目录", icon: Boxes });
  }

  if (canAccessCosting(role)) {
    ops.items.push({ href: "/costing", label: "成本核算", icon: Calculator });
  }

  if (canAccessFinance(role)) {
    ops.items.push({ href: "/finance", label: "财务管理", icon: Banknote });
  }

  const groups: NavGroup[] = [core, ops];

  // ONLINE_OPS 门户专属入口（设计 §10）：客服账号管理（P1）+ 销量看板（P2）。
  // 仅 ONLINE_OPS Portal 展示；FIELD_SALES Portal 不出现这些入口。
  // API 权限仍由 /api/online-ops/** 的 assertPortalAccess + 部门校验保证。
  if (clientPortalHasCapability("customer-service-accounts")) {
    groups.push({
      title: "网络运营",
      items: [
        {
          href: "/online-ops/service-accounts",
          label: "客服账号",
          icon: Headphones,
          portalCapability: "customer-service-accounts",
        },
        {
          href: "/online-ops/sales-dashboard",
          label: "销量看板",
          icon: LineChart,
          portalCapability: "sales-dashboard",
        },
      ],
    });
  }

  if (role === "ADMIN") {
    groups.push({
      title: "系统管理",
      items: [
        { href: "/admin/users", label: "用户管理", icon: Users },
        { href: "/admin/representatives", label: "代表账号管理", icon: UserCog },
        { href: "/admin/representative-regions", label: "地区管理", icon: MapPin },
        { href: "/admin/representative-organizations", label: "绑定审核", icon: Link2 },
        { href: "/admin/organizations", label: "组织管理", icon: Building2 },
        { href: "/admin/dev-logs", label: "开发日志", icon: FileText },
        { href: "/admin/contract-templates", label: "合同模板管理", icon: FileSignature },
        { href: "/admin/external-contacts", label: "外部通讯录", icon: Mail },
        { href: "/admin/business-email-logs", label: "邮件发送历史", icon: MailCheck },
      ],
    });
  }

  // Portal capability 过滤：删除不属于当前 Portal 的入口。
  // 菜单隐藏只是产品表面，不是权限边界（设计 §2.4 / §10）。
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          !item.portalCapability ||
          clientPortalHasCapability(item.portalCapability),
      ),
    }))
    .filter((group) => group.items.length > 0);
}

/** Mobile primary nav: at most 4 main items + a fixed "More" entry that opens the drawer. */
export function getMobilePrimaryNav(role?: string | null): {
  primary: NavItem[];
  overflow: NavItem[];
  groups: NavGroup[];
} {
  const groups = getNavGroups(role);

  // Flatten groups while preserving order, filtering out items the role cannot see.
  const allItems: NavItem[] = [];
  for (const group of groups) {
    for (const item of group.items) {
      if (item.adminOnly && role !== "ADMIN") continue;
      allItems.push(item);
    }
  }

  switch (role) {
    case "ADMIN": {
      const primary = [
        allItems.find((i) => i.href === "/dashboard")!,
        allItems.find((i) => i.href === "/orders")!,
        allItems.find((i) => i.href === "/projects")!,
        allItems.find((i) => i.href === "/tickets")!,
      ];
      const overflow = allItems.filter(
        (i) => !primary.some((p) => p.href === i.href)
      );
      return { primary, overflow, groups };
    }
    case "USER": {
      const primary = [
        allItems.find((i) => i.href === "/dashboard")!,
        allItems.find((i) => i.href === "/orders")!,
        allItems.find((i) => i.href === "/projects")!,
        allItems.find((i) => i.href === "/tickets")!,
      ];
      const overflow = allItems.filter(
        (i) => !primary.some((p) => p.href === i.href)
      );
      return { primary, overflow, groups };
    }
    case "REGIONAL_MANAGER": {
      const primary = [
        allItems.find((i) => i.href === "/dashboard")!,
        allItems.find((i) => i.href === "/orders")!,
        allItems.find((i) => i.href === "/crm")!,
        allItems.find((i) => i.href === "/projects")!,
      ];
      const overflow = allItems.filter(
        (i) => !primary.some((p) => p.href === i.href)
      );
      return { primary, overflow, groups };
    }
    case "REPRESENTATIVE": {
      // 代表底栏：工作台 / 订单 / CRM / Agent；「项目」落入「更多」抽屉。
      const primary = [
        allItems.find((i) => i.href === "/dashboard")!,
        allItems.find((i) => i.href === "/orders")!,
        allItems.find((i) => i.href === "/crm")!,
        allItems.find((i) => i.href === "/agent")!,
      ];
      const overflow = allItems.filter(
        (i) => !primary.some((p) => p.href === i.href)
      );
      return { primary, overflow, groups };
    }
    default: {
      // Unauthenticated / unknown role: show the safe subset.
      const primary = allItems.slice(0, 4);
      const overflow = allItems.slice(4);
      return { primary, overflow, groups };
    }
  }
}

/** The fixed "More" entry displayed as the 5th bottom-nav item. */
export function getMobileMoreItem(): NavItem {
  return { href: "#more", label: "更多", icon: MoreHorizontal };
}
