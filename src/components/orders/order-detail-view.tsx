"use client";

/**
 * OrderDetailView — the body of the order detail, decoupled from any Sheet
 * chrome so it can be embedded both as a Drawer (legacy /orders?focus= flow)
 * and inside the Agent workspace Resource Panel/Sheet.
 *
 * Data loading uses TanStack Query with key `["order", orderId]` so the drawer
 * and the embedded resource view share a single cache (and `OrderRevisionDialog`
 * already invalidates the same key on success — see
 * src/components/finance/order-revision-dialog.tsx).
 *
 * mode="drawer" preserves the legacy /orders drawer behaviour exactly (uses
 * next/link + router for in-app navigation). mode="panel" | "sheet" routes
 * internal links through `useResourceNavigation()` so they push onto the Agent
 * resource history instead of leaving the workspace.
 *
 * This is a pure structural extraction from `order-row-drawer.tsx`; all API
 * calls, permissions, mutations and Dialogs are unchanged.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import {
  FolderTree,
  Receipt,
  Banknote,
  UserRound,
  Pencil,
  Link2,
  RefreshCw,
  MoreHorizontal,
  AlertTriangle,
  FileText,
  ArrowLeft,
  ClipboardList,
  Package,
  History,
  ShoppingCart,
  Download,
  Loader2,
} from "lucide-react";
import { ProjectBindDialog } from "@/components/finance/project-bind-dialog";
import { CustomerMatchDialog } from "@/components/finance/customer-match-dialog";
import { InvoiceFormDialog } from "@/components/invoice-form-dialog";
import { OrderSupplyCostTab } from "@/components/orders/order-supply-cost-tab";
import { CostFormDialog } from "@/components/finance/cost-form-dialog";
import { OrderRevisionDialog } from "@/components/finance/order-revision-dialog";
import { OrderEditDialog } from "@/components/orders/order-edit-dialog";
import {
  OrderStatusButtons,
  OrderStatusMenuItems,
  OrderCloseReasonDialog,
  shouldShowAccrualOption,
} from "@/components/orders/order-transition-controls";
import { ContractGenerateDialog } from "@/components/contract-generate-dialog";
import { AnimatedMoney } from "@/components/ui/animated-money";
import { isSalesRole } from "@/lib/role-guards";
import { getCustomerOrganizationName } from "@/lib/customer-organization";
import { getOrderSourcePublicLabel } from "@/lib/orders/source-labels";
import { useResourceNavigation } from "@/components/agent/resource-navigation-context";

const STATUS_LABELS: Record<string, string> = { DRAFT: "草稿", CONFIRMED: "已确认", DELIVERED: "已交付", CLOSED: "已关闭" };
const CATEGORY_LABELS: Record<string, string> = { SERVICE: "服务", PRODUCT: "商品", MIXED: "混合", UNKNOWN: "未分类" };
const TREATMENT_LABELS: Record<string, string> = { AUTO: "自动", STANDALONE: "独立计入", PROJECT_INCLUDED: "并入项目", EXCLUDED: "排除" };
const MATCH_LABELS: Record<string, string> = { UNMATCHED: "未匹配", AUTO_MATCHED: "自动匹配", MANUAL_MATCHED: "人工匹配", CONFLICT: "冲突" };
const RELATION_LABELS: Record<string, string> = { GENERATED: "生成", LINKED: "关联", SPLIT: "拆分", SUPPLEMENT: "补充" };

type Rec = Record<string, unknown>;
type TabKey = "overview" | "lines" | "projects" | "finance" | "supply" | "history" | "contracts";

/** Query payload of GET /api/orders/{id}: an order + its invoices list. */
interface OrderDetailPayload {
  order: Rec | null;
  invoices: Rec[];
}

export interface OrderDetailViewProps {
  orderId: string;
  isAdmin: boolean;
  userId?: string;
  role?: string | null;
  initialAction?: string;
  initialView?: string;
  /** "drawer" = legacy Sheet behaviour (next/link + router navigation). */
  mode: "drawer" | "panel" | "sheet";
  /** Drawer-only: deep-link return URL. Ignored in panel/sheet mode. */
  returnTo?: string | null;
  onChanged?: () => void;
}

export function OrderDetailView({
  orderId,
  isAdmin,
  userId,
  role,
  initialAction = "",
  initialView = "",
  mode,
  returnTo = null,
  onChanged,
}: OrderDetailViewProps) {
  const router = useRouter();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const queryClient = useQueryClient();
  const { onNavigateResource, onNavigateHref } = useResourceNavigation();

  // TanStack Query replaces the former useEffect + fetch.  Keyed at
  // ["order", orderId] so the drawer and the Agent resource view share the
  // same cache, and OrderRevisionDialog's existing invalidation covers us.
  const { data, isLoading, refetch } = useQuery<OrderDetailPayload>({
    queryKey: ["order", orderId],
    queryFn: async () => {
      const res = await fetch(`/api/orders/${orderId}`);
      if (!res.ok) throw new Error("加载订单失败");
      const d = await res.json();
      return {
        order: (d?.order as Rec) || null,
        invoices: (d?.invoices as Rec[]) || [],
      };
    },
    enabled: !!orderId,
    refetchOnMount: "always",
  });

  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("overview");

  // 合同列表：消费 GET /api/contracts?orderId=（API 已支持 orderId + scope 校验）。
  // 在合同 tab 打开时拉取，生成合同后（refresh 触发）自动刷新。
  const contractsQueryKey = ["order-contracts", orderId];
  const { data: contractsData, isLoading: contractsLoading } = useQuery<{
    contracts: Array<{
      id: string;
      documentNo: string | null;
      category: string | null;
      status: string | null;
      createdAt: string;
      createdBy?: { name: string | null } | null;
      attachments?: Array<{ id: string; fileName: string; fileUrl: string | null }>;
    }>;
    total: number;
  }>({
    queryKey: contractsQueryKey,
    queryFn: async () => {
      const res = await fetch(`/api/contracts?orderId=${orderId}`);
      if (!res.ok) throw new Error("加载合同失败");
      return res.json();
    },
    enabled: !!orderId && activeTab === "contracts",
  });

  // Dialog open states
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [customerMatchOpen, setCustomerMatchOpen] = useState(false);
  const [contractGenerateOpen, setContractGenerateOpen] = useState(false);
  const [invoiceDialogOpen, setInvoiceDialogOpen] = useState(false);
  const [costDialogOpen, setCostDialogOpen] = useState(false);
  const [revisionDialogOpen, setRevisionDialogOpen] = useState(false);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);

  const appliedRef = useRef(false);

  // 首次拿到数据后按 initialAction/initialView 自动展开对应弹窗/Tab。
  // 自动弹窗须与可见按钮一致：发票/成本按钮均 isAdmin-gated，非 ADMIN 深链不自动开（避免白填后 403）。
  // 同原抽屉：setState 全部放在 async IIFE 内部，规避 set-state-in-effect 级联渲染告警。
  useEffect(() => {
    if (!data || appliedRef.current) return;
    let active = true;
    (async () => {
      await Promise.resolve();
      if (!active) return;
      appliedRef.current = true;
      if (isAdmin && initialAction === "invoice") setInvoiceDialogOpen(true);
      else if (isAdmin && initialAction === "cost") setCostDialogOpen(true);
      if (initialView === "history") setActiveTab("history");
    })();
    return () => { active = false; };
  }, [data, isAdmin, initialAction, initialView]);

  // orderId 切换（drawer 复用同一组件实例）时重置自动动作标记与 Tab。
  useEffect(() => {
    let active = true;
    (async () => {
      await Promise.resolve();
      if (!active) return;
      appliedRef.current = false;
      setActiveTab("overview");
    })();
    return () => { active = false; };
  }, [orderId]);

  // 写操作成功后：刷新本视图（invalidation + 通知父级）。drawer 模式下父级是
  // /orders 列表页（fetchOrders/fetchStats）；panel/sheet 模式下父级是
  // OrderResourceView（会 invalidate 订单列表相关 query）。
  const refresh = useCallback(() => {
    void refetch();
    onChanged?.();
  }, [refetch, onChanged]);

  const saveField = async (field: string, value: unknown) => {
    if (!orderId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/orders/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (res.ok) {
        // 保持与原实现一致：用 PATCH 返回值直接更新本地缓存，并通知父级。
        const d = await res.json();
        queryClient.setQueryData<OrderDetailPayload>(["order", orderId], (prev) =>
          prev ? { ...prev, order: (d.order as Rec) ?? prev.order } : prev,
        );
        onChanged?.();
      }
    } finally {
      setSaving(false);
    }
  };
  // saveField 当前未在主体内被调用（保留以便后续 inline-edit 复用，与原抽屉一致）。
  void saveField;

  const order = data?.order ?? null;
  const invoices = data?.invoices ?? [];

  // ── 派生数据 ──────────────────────────────────────────────
  const cust = (order?.customer as Rec | null) || null;
  const custOrgName = cust
    ? getCustomerOrganizationName({
        organization: cust.organization as string | null,
        org: cust.org as { canonicalName: string } | null | undefined,
      })
    : null;
  const rep = (order?.representative as Rec | null) || null;
  const lines = (order?.lines as Rec[]) || [];
  const projectLinks = (order?.projectLinks as Rec[]) || [];
  const statusHistory = (order?.statusHistory as Rec[]) || [];
  const counts = (order?._count as Record<string, number> | null) || null;
  const effectiveAmount = (order?.financeAmountOverride as number) ?? (order?.totalAmount as number) ?? 0;
  const crmProfile = cust?.crmProfile as Rec | null | undefined;
  const accrualReversalOf = order?.accrualReversalOf as Rec | null | undefined;
  const accrualReversals = order?.accrualReversals as Rec[] | undefined;

  const crmHref = crmProfile?.id
    ? `/crm/customers/${crmProfile.id}`
    : order?.profileId
    ? `/crm/customers/${order.profileId}`
    : cust?.name
    ? `/crm/customers?search=${encodeURIComponent(cust.name as string)}`
    : null;

  const canGenerateContract = !!role && !isSalesRole(role);

  // OrderRevisionDialog 需要：已开票额 / 已回款额（与原详情页同口径，金额已为元）
  const issuedInvoiceAmount = invoices.reduce((sum, inv) => {
    const st = inv.status as string;
    if (st === "CANCELLED") return sum;
    const adjustments = inv.adjustments as Rec[] | undefined;
    if (adjustments?.some((a) => a.kind === "RED")) return sum;
    return sum + ((inv.totalAmount as number) || 0);
  }, 0);
  const receivedAmount = ((order?.receipts as Rec[]) || []).reduce(
    (sum, r) => sum + ((r.amount as number) || 0),
    0,
  );

  const firstProject = projectLinks[0]?.project as Rec | undefined;
  const firstProjectId = firstProject?.id as string | undefined;
  const aiDraftUrl = firstProjectId ? `/api/projects/${firstProjectId}/invoice-draft` : null;

  // ── 内部链接处理 ──────────────────────────────────────────────
  // drawer 模式：保持原 next/link + router 行为。
  // panel/sheet 模式：走 useResourceNavigation，把目标压入 Agent 资源历史。
  const navigateProject = useCallback(
    (projectId: string) => {
      if (mode !== "drawer" && onNavigateResource) {
        onNavigateResource("project", projectId);
      } else {
        router.push(`/projects/${projectId}`);
      }
    },
    [mode, onNavigateResource, router],
  );

  const navigateHref = useCallback(
    (href: string) => {
      if (mode !== "drawer" && onNavigateHref) {
        onNavigateHref(href);
      } else {
        router.push(href);
      }
    },
    [mode, onNavigateHref, router],
  );

  if (isLoading || !order) {
    return (
      <div className="p-4 space-y-3">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const tabItems: { key: TabKey; label: string; icon: React.ElementType }[] = [
    { key: "overview", label: "概览", icon: ClipboardList },
    { key: "lines", label: `明细${counts?.lines ? ` (${counts.lines})` : ""}`, icon: Package },
    { key: "projects", label: `项目${projectLinks.length ? ` (${projectLinks.length})` : ""}`, icon: FolderTree },
    { key: "finance", label: "财务", icon: Banknote },
    { key: "supply", label: "供应/成本", icon: ShoppingCart },
    { key: "contracts", label: "合同", icon: FileText },
    { key: "history", label: "日志", icon: History },
  ];

  // 移动端概览字段：单行「标签-值」列表（双列 grid 在窄屏过挤）；桌面保持多列 grid。
  const renderInfoItem = (label: string, children: React.ReactNode, className?: string) =>
    isMobile ? (
      <div key={label} className={cn("flex items-center justify-between gap-3 border-b border-border/40 px-3.5 py-2.5 last:border-0", className)}>
        <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
        <span className="min-w-0 break-words text-right">{children}</span>
      </div>
    ) : (
      <div key={label} className={className}><span className="text-muted-foreground">{label}</span><div>{children}</div></div>
    );

  // 渲染客户档案入口（抽屉模式：next/link；嵌入模式：按钮触发资源导航）。
  // 文案与原抽屉一致：有具体档案时显示「客户档案」，否则跳档案库「客户档案库」。
  const renderCustomerArchiveEntry = (wrapInDropdownItem = false) => {
    const label = crmHref ? "客户档案" : "客户档案库";
    const icon = <UserRound className="h-3.5 w-3.5 mr-2" />;
    const onActivate = () => {
      const profileId = (crmProfile?.id as string | undefined) || (order?.profileId as string | undefined);
      if (mode !== "drawer" && profileId && onNavigateResource) {
        onNavigateResource("customer", profileId);
      } else if (crmHref) {
        navigateHref(crmHref);
      } else {
        navigateHref("/crm/customers");
      }
    };
    if (mode === "drawer") {
      // 抽屉模式：保留原 next/link + DropdownMenuItem render 用法。
      if (wrapInDropdownItem) {
        return (
          <DropdownMenuItem render={<Link href={crmHref || "/crm/customers"} />}>
            {icon}
            {label}
          </DropdownMenuItem>
        );
      }
      return (
        <Link href={crmHref || "/crm/customers"} className="text-primary hover:underline">
          {crmHref && !crmHref.includes("search=") ? "查看客户档案" : "搜索客户档案库"}
        </Link>
      );
    }
    if (wrapInDropdownItem) {
      return (
        <DropdownMenuItem onClick={onActivate}>
          {icon}
          {label}
        </DropdownMenuItem>
      );
    }
    return (
      <button type="button" className="text-primary hover:underline" onClick={onActivate}>
        {crmHref && !crmHref.includes("search=") ? "查看客户档案" : "搜索客户档案库"}
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-0 p-3 md:p-4">
      {mode === "drawer" && returnTo && (
        <button
          type="button"
          className="self-start text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-2"
          onClick={() => router.push(returnTo)}
        >
          <ArrowLeft className="h-3.5 w-3.5" />返回上一页
        </button>
      )}
      {mode === "drawer" ? (
        <SheetHeader className="p-0 mb-3">
          <SheetTitle className={cn("pr-8 break-words", isMobile && "text-base leading-snug")}>{order.title as string}</SheetTitle>
          <SheetDescription className="break-words">
            {order.orderNo as string}
            {(order.externalOrderNo as string) ? ` · 外部: ${order.externalOrderNo as string}` : ""}
            <Badge variant="outline" className="ml-2 text-xs align-middle">
              {STATUS_LABELS[order.status as string] || (order.status as string)}
            </Badge>
          </SheetDescription>
        </SheetHeader>
      ) : (
        <div className="mb-3 pr-8">
          <h2 className={cn("font-semibold break-words leading-tight", isMobile ? "text-base" : "text-lg")}>{order.title as string}</h2>
          <p className="text-sm text-muted-foreground break-words mt-0.5">
            {order.orderNo as string}
            {(order.externalOrderNo as string) ? ` · 外部: ${order.externalOrderNo as string}` : ""}
            <Badge variant="outline" className="ml-2 text-xs align-middle">
              {STATUS_LABELS[order.status as string] || (order.status as string)}
            </Badge>
          </p>
        </div>
      )}

      {/* ── Sticky action bar ── */}
      <div
        className={cn(
          "sticky top-0 z-10 -mx-3 px-3 md:-mx-4 md:px-4 py-2 mb-3 flex items-center gap-2 border-b bg-background/95 backdrop-blur",
          isMobile ? "justify-between" : "flex-wrap",
        )}
      >
        <OrderStatusButtons
          orderId={order.id as string}
          status={order.status as string}
          isAdmin={isAdmin}
          onChanged={refresh}
        />
        {isMobile ? (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="touch" variant="outline"><MoreHorizontal className="h-4 w-4 mr-1" />操作</Button>} />
            <DropdownMenuContent align="end" className="max-h-[70dvh] overflow-y-auto">
              {isAdmin && (
                <>
                  <DropdownMenuItem onClick={() => setEditDialogOpen(true)}><Pencil className="h-3.5 w-3.5 mr-2" />编辑订单</DropdownMenuItem>
                  {projectLinks.length > 0 ? (
                    <DropdownMenuItem onClick={() => firstProjectId && navigateProject(firstProjectId)}><FolderTree className="h-3.5 w-3.5 mr-2" />打开项目</DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onClick={() => setProjectDialogOpen(true)}><FolderTree className="h-3.5 w-3.5 mr-2" />关联项目</DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => setInvoiceDialogOpen(true)}><Receipt className="h-3.5 w-3.5 mr-2" />新建发票</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setCostDialogOpen(true)}><Banknote className="h-3.5 w-3.5 mr-2" />新增成本</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setRevisionDialogOpen(true)}><RefreshCw className="h-3.5 w-3.5 mr-2" />修订金额</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setCustomerMatchOpen(true)}><Link2 className="h-3.5 w-3.5 mr-2" />{cust ? "重绑客户" : "绑定客户"}</DropdownMenuItem>
                  <OrderStatusMenuItems
                    orderId={order.id as string}
                    status={order.status as string}
                    onChanged={refresh}
                    onRequestClose={() => setCloseDialogOpen(true)}
                    only={["CLOSED"]}
                  />
                  <DropdownMenuSeparator />
                </>
              )}
              {renderCustomerArchiveEntry(true)}
              {canGenerateContract && (
                <DropdownMenuItem onClick={() => setContractGenerateOpen(true)}><FileText className="h-3.5 w-3.5 mr-2" />生成合同</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <>
            {isAdmin && (
              <Button size="sm" variant="outline" onClick={() => setEditDialogOpen(true)}>
                <Pencil className="h-3 w-3 mr-1" />编辑订单
              </Button>
            )}
            {isAdmin && (
              <Button size="sm" variant="outline" onClick={() => setInvoiceDialogOpen(true)}>
                <Receipt className="h-3 w-3 mr-1" />新建发票
              </Button>
            )}
            {isAdmin && (
              <Button size="sm" variant="outline" onClick={() => setCostDialogOpen(true)}>
                <Banknote className="h-3 w-3 mr-1" />新增成本
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>
                <MoreHorizontal className="h-3 w-3 mr-1" />更多
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {isAdmin && (
                  <DropdownMenuItem onClick={() => setRevisionDialogOpen(true)}>
                    <RefreshCw className="h-3 w-3 mr-1" />修订金额
                  </DropdownMenuItem>
                )}
                {projectLinks.length > 0 ? (
                  <DropdownMenuItem onClick={() => firstProjectId && navigateProject(firstProjectId)}>
                    <FolderTree className="h-3 w-3 mr-1" />打开项目{projectLinks.length > 1 ? ` (+${projectLinks.length - 1})` : ""}
                  </DropdownMenuItem>
                ) : (
                  isAdmin && (
                    <DropdownMenuItem onClick={() => setProjectDialogOpen(true)}>
                      <FolderTree className="h-3 w-3 mr-1" />关联项目
                    </DropdownMenuItem>
                  )
                )}
                {isAdmin && (
                  <DropdownMenuItem onClick={() => setCustomerMatchOpen(true)}>
                    <Link2 className="h-3 w-3 mr-1" />{cust ? "重绑客户" : "绑定客户"}
                  </DropdownMenuItem>
                )}
                {isAdmin && (
                  <OrderStatusMenuItems
                    orderId={order.id as string}
                    status={order.status as string}
                    onChanged={refresh}
                    onRequestClose={() => setCloseDialogOpen(true)}
                    only={["CLOSED"]}
                  />
                )}
                {renderCustomerArchiveEntry(true)}
                {canGenerateContract && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setContractGenerateOpen(true)}>
                      <FileText className="h-3 w-3 mr-1" />生成合同
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>

      {/* ── Tabs ── */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabKey)} className="flex-1">
        {/* 移动端：7 个 tab 横滑会截断且难定位，改用下拉选择 */}
        <div className="md:hidden">
          <Select value={activeTab} onValueChange={(v) => setActiveTab(v as TabKey)}>
            <SelectTrigger className="w-full justify-between" size="default">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {tabItems.map((t) => (
                <SelectItem key={t.key} value={t.key}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <TabsList variant="line" className="w-full justify-start overflow-x-auto max-md:hidden [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden">
          {tabItems.map((t) => {
            const Icon = t.icon;
            return (
              <TabsTrigger key={t.key} value={t.key} className="flex-shrink-0">
                <Icon className="h-3.5 w-3.5" />
                {t.label}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {/* ── 概览 Tab ── */}
        <TabsContent value="overview" className="mt-4 space-y-4">
          {!!accrualReversalOf?.id && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                <span>此订单为计提冲回记录，原订单：{accrualReversalOf.orderNo as string}</span>
              </div>
            </div>
          )}
          {(accrualReversals?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                <span>本订单已计提冲回</span>
              </div>
            </div>
          )}

          <Card className={isMobile ? "py-1 text-sm" : "p-4 grid grid-cols-2 md:grid-cols-3 gap-3 text-sm"}>
            {renderInfoItem("导入渠道", getOrderSourcePublicLabel(order.source as string))}
            {renderInfoItem("分类", <Badge variant="outline">{CATEGORY_LABELS[order.category as string] || (order.category as string)}</Badge>)}
            {renderInfoItem("计入口径", <Badge variant="outline">{TREATMENT_LABELS[order.financeTreatment as string] || (order.financeTreatment as string)}</Badge>)}
            {renderInfoItem("订单金额", <span className="font-medium"><AnimatedMoney value={(order.totalAmount as number) || 0} /></span>)}
            {renderInfoItem("有效财务金额", <span className="font-medium"><AnimatedMoney value={effectiveAmount} /></span>)}
            {renderInfoItem("下单日期", (order.orderedAt as string)?.slice(0, 10) || "-")}
            {renderInfoItem("确认日期", (order.confirmedAt as string)?.slice(0, 10) || "-")}
            {renderInfoItem("交付日期", (order.deliveredAt as string)?.slice(0, 10) || "-")}
            {renderInfoItem("代表", (rep?.name as string) || "-")}
            <div className={isMobile ? "px-3.5 py-2 text-xs text-muted-foreground" : "col-span-2 md:col-span-3 text-xs text-muted-foreground"}>
              {counts?.lines || 0} 明细 · {counts?.receipts || 0} 回款
            </div>
          </Card>

          {/* 客户卡（自原「客户」tab 并入，消除 tab 与概览的信息重复） */}
          <Card variant="outlined" className="p-4 text-sm space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h3 className="text-sm font-medium">客户</h3>
              <Badge variant="outline">{MATCH_LABELS[order.customerMatchStatus as string] || (order.customerMatchStatus as string)}</Badge>
            </div>
            {cust ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-muted-foreground">客户主数据:</span>
                  {mode === "drawer" ? (
                    <Link href={`/crm/customers?search=${encodeURIComponent(cust.name as string)}`} className="text-primary hover:underline font-medium">
                      {cust.name as string} ({cust.customerCode as string})
                    </Link>
                  ) : (
                    <button
                      type="button"
                      className="text-primary hover:underline font-medium"
                      onClick={() => navigateHref(`/crm/customers?search=${encodeURIComponent(cust.name as string)}`)}
                    >
                      {cust.name as string} ({cust.customerCode as string})
                    </button>
                  )}
                </div>
                {crmHref && (
                  <div>
                    <span className="text-muted-foreground">客户档案: </span>
                    {renderCustomerArchiveEntry(false)}
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs text-muted-foreground">
                  <div className="break-words">收件人快照: {(order.buyerNameSnapshot as string) || "-"}</div>
                  <div className="break-words">电话快照: {(order.buyerPhoneSnapshot as string) || "-"}</div>
                  <div className="break-words">微信快照: {(order.buyerWechatSnapshot as string) || "-"}</div>
                  <div className="break-words">单位快照: {(order.buyerOrgNameSnapshot as string) || "-"}</div>
                </div>
                {isAdmin && (
                  <div className="pt-2 border-t flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => setCustomerMatchOpen(true)} disabled={saving}>重新绑定客户</Button>
                  </div>
                )}
              </>
            ) : (
              <div>
                <div className="text-sm text-muted-foreground mb-2">暂无绑定客户</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs text-muted-foreground mb-2">
                  <div className="break-words">收件人快照: {(order.buyerNameSnapshot as string) || "-"}</div>
                  <div className="break-words">电话快照: {(order.buyerPhoneSnapshot as string) || "-"}</div>
                  <div className="break-words">微信快照: {(order.buyerWechatSnapshot as string) || "-"}</div>
                  <div className="break-words">单位快照: {(order.buyerOrgNameSnapshot as string) || "-"}</div>
                </div>
                {isAdmin && (
                  <Button size="sm" onClick={() => setCustomerMatchOpen(true)} disabled={saving}>
                    <Link2 className="h-3 w-3 mr-1" />绑定 / 新增客户
                  </Button>
                )}
              </div>
            )}
          </Card>
        </TabsContent>

        {/* ── 明细 Tab ── */}
        <TabsContent value="lines" className="mt-4 space-y-4">
          <div className="space-y-2">
            <h3 className="text-sm font-medium">订单明细 ({lines.length})</h3>
            {lines.length === 0 ? (
              <div className="text-muted-foreground text-sm">暂无明细</div>
            ) : (
              <div className="space-y-2">
                {lines.map((l, i) => (
                  <Card key={i} variant="outlined" className="p-3 text-sm flex justify-between items-center">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate">{l.itemName as string}</div>
                      <div className="text-xs text-muted-foreground">
                        {(l.spec as string) ? `${l.spec as string} / ` : ""}×{(l.quantity as number) || 1} {(l.unit as string) || ""}
                      </div>
                    </div>
                    <div className="text-right font-medium ml-2"><AnimatedMoney value={(l.amount as number) || 0} /></div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        {/* ── 项目 Tab ── */}
        <TabsContent value="projects" className="mt-4 space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">关联项目 ({projectLinks.length})</h3>
              {isAdmin && (
                <Button size="sm" variant="outline" onClick={() => setProjectDialogOpen(true)}>
                  <FolderTree className="h-3 w-3 mr-1" />关联项目
                </Button>
              )}
            </div>
            {projectLinks.length === 0 ? (
              <div className="text-muted-foreground text-sm space-y-2">
                <div>暂无关联项目</div>
              </div>
            ) : (
              <div className="space-y-2">
                {projectLinks.map((l) => {
                  const prj = l.project as Rec | undefined;
                  const projectId = prj?.id as string | undefined;
                  const openProject = () => projectId && navigateProject(projectId);
                  return (
                    <Card key={l.id as string} variant="outlined" className="p-3 text-sm flex justify-between items-center gap-2">
                      <div className="min-w-0">
                        <div className="font-medium truncate">
                          {mode === "drawer" ? (
                            <Link href={`/projects/${prj?.id}`} className="text-primary hover:underline">{prj?.name as string}</Link>
                          ) : (
                            <button type="button" className="text-primary hover:underline" onClick={openProject}>{prj?.name as string}</button>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          <Badge variant="outline" className="text-xs mr-1">{RELATION_LABELS[l.relationType as string] || (l.relationType as string) || "关联"}</Badge>
                          <Badge variant="outline" className="text-xs">{TREATMENT_LABELS[l.treatment as string] || (l.treatment as string)}</Badge>
                          {l.allocatedAmount != null ? <span> 分摊: <AnimatedMoney value={l.allocatedAmount as number} /></span> : ""}
                          {l.isPrimary ? " ★主" : ""}
                        </div>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        {mode === "drawer" ? (
                          <Link href={`/projects/${prj?.id}`}><Button variant="outline" size="sm">打开</Button></Link>
                        ) : (
                          <Button variant="outline" size="sm" onClick={openProject}>打开</Button>
                        )}
                        {isAdmin && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={async () => {
                              await fetch(`/api/orders/${order.id}/project-links/${l.id}`, { method: "DELETE" });
                              refresh();
                            }}
                          >
                            解绑
                          </Button>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        </TabsContent>

        {/* ── 财务 Tab ── */}
        <TabsContent value="finance" className="mt-4 space-y-4">
          {/* 金额摘要条：数据来自订单载荷与发票列表，无新增请求 */}
          <Card variant="outlined" className="p-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <div>
              <span className="text-xs text-muted-foreground">有效财务金额</span>
              <div className="font-medium"><AnimatedMoney value={effectiveAmount} /></div>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">已开票</span>
              <div className="font-medium"><AnimatedMoney value={issuedInvoiceAmount} /></div>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">已回款</span>
              <div className="font-medium"><AnimatedMoney value={receivedAmount} /></div>
            </div>
          </Card>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(() => {
              const openInvoices = () => navigateHref(`/finance/invoices?orderId=${order.id}`);
              const openCosts = () => navigateHref(`/finance/costs?orderId=${order.id}`);
              const openCustomerFinance = cust?.id ? () => navigateHref(`/finance/customers/${cust.id}`) : null;
              const InvoiceCard = (
                <Card variant="interactive" className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">发票工作台</p>
                      <p className="text-xs text-muted-foreground">查看/申请发票</p>
                    </div>
                  </div>
                </Card>
              );
              const CostCard = (
                <Card variant="interactive" className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
                      <Banknote className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">成本管理</p>
                      <p className="text-xs text-muted-foreground">订单成本明细</p>
                    </div>
                  </div>
                </Card>
              );
              const CustomerFinanceCard = openCustomerFinance && (
                <Card variant="interactive" className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
                      <UserRound className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">客户财务总览</p>
                      <p className="text-xs text-muted-foreground">{cust?.name as string}</p>
                    </div>
                  </div>
                </Card>
              );
              return (
                <>
                  {mode === "drawer" ? (
                    <Link href={`/finance/invoices?orderId=${order.id}`}>{InvoiceCard}</Link>
                  ) : (
                    <button type="button" className="text-left" onClick={openInvoices}>{InvoiceCard}</button>
                  )}
                  {mode === "drawer" ? (
                    <Link href={`/finance/costs?orderId=${order.id}`}>{CostCard}</Link>
                  ) : (
                    <button type="button" className="text-left" onClick={openCosts}>{CostCard}</button>
                  )}
                  {CustomerFinanceCard &&
                    (mode === "drawer" ? (
                      <Link href={`/finance/customers/${cust?.id}`}>{CustomerFinanceCard}</Link>
                    ) : (
                      <button type="button" className="text-left" onClick={openCustomerFinance}>{CustomerFinanceCard}</button>
                    ))}
                </>
              );
            })()}
          </div>
        </TabsContent>

        {/* ── 日志 Tab ── */}
        <TabsContent value="history" className="mt-4 space-y-4">
          <div className="space-y-2">
            <h3 className="text-sm font-medium">操作日志 ({statusHistory.length})</h3>
            {statusHistory.length === 0 ? (
              <div className="text-muted-foreground text-sm">暂无操作记录</div>
            ) : (
              <div className="space-y-2">
                {statusHistory.map((h, i) => (
                  <Card key={i} variant="outlined" className="p-3 text-sm flex justify-between gap-2">
                    <div>
                      {h.oldStatus ? <Badge variant="outline" className="text-xs mr-1">{STATUS_LABELS[h.oldStatus as string] || (h.oldStatus as string)}</Badge> : null}
                      {h.oldStatus ? " → " : ""}
                      <Badge variant="outline" className="text-xs">{STATUS_LABELS[h.newStatus as string] || (h.newStatus as string)}</Badge>
                      {h.note ? <span className="text-xs text-muted-foreground ml-2">{h.note as string}</span> : null}
                    </div>
                    <div className="text-xs text-muted-foreground shrink-0">{(h.createdAt as string)?.slice(0, 16)}</div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        {/* ── 供应/成本 Tab ── */}
        <TabsContent value="supply" className="mt-4 space-y-4">
          <OrderSupplyCostTab
            orderId={order.id as string}
            role={role}
          />
        </TabsContent>

        {/* ── 合同 Tab：消费 GET /api/contracts?orderId=，行内下载 ── */}
        <TabsContent value="contracts" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
              <div className="space-y-0.5">
                <CardTitle className="text-base">合同文档</CardTitle>
                <p className="text-xs text-muted-foreground">
                  本订单关联的合同，生成后可在此查看与下载
                </p>
              </div>
              {canGenerateContract && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setContractGenerateOpen(true)}
                >
                  <FileText className="h-3.5 w-3.5 mr-1" />生成合同
                </Button>
              )}
            </CardHeader>
            <CardContent className="pt-0">
              {contractsLoading ? (
                <div className="flex justify-center py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : !contractsData || contractsData.contracts.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  暂无合同，点击右上角「生成合同」创建
                </p>
              ) : (
                <div className="divide-y rounded-lg border">
                  {contractsData.contracts.map((c) => {
                    const att = c.attachments?.[0];
                    const downloadHref = att?.fileUrl
                      ? att.fileUrl
                      : `/api/contracts/${c.id}/download`;
                    return (
                      <div
                        key={c.id}
                        className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-3 py-2.5 text-sm"
                      >
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="font-medium truncate flex items-center gap-2">
                            <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            {c.documentNo || "合同文档"}
                            {c.status && (
                              <Badge variant="secondary" className="text-[10px] px-1.5">
                                {c.status}
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
                            {c.category && <span>{c.category}</span>}
                            {c.createdBy?.name && <span>生成人 {c.createdBy.name}</span>}
                            <span>{new Date(c.createdAt).toLocaleDateString("zh-CN")}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            render={<a href={downloadHref} download />}
                          >
                            <Download className="h-3 w-3 mr-1" />
                            下载
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── Dialogs ── */}
      <ContractGenerateDialog
        open={contractGenerateOpen}
        onOpenChange={setContractGenerateOpen}
        orderId={order.id as string}
        order={order}
        onGenerated={() => {
          refresh();
          queryClient.invalidateQueries({ queryKey: contractsQueryKey });
        }}
      />
      {projectDialogOpen && (
        <ProjectBindDialog
          open={projectDialogOpen}
          onOpenChange={setProjectDialogOpen}
          orderId={order.id as string}
          onBound={() => { refresh(); setProjectDialogOpen(false); }}
        />
      )}
      <OrderEditDialog
        orderId={order.id as string}
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        onUpdated={refresh}
      />
      {customerMatchOpen && (
        <CustomerMatchDialog
          open={customerMatchOpen}
          onOpenChange={setCustomerMatchOpen}
          orderId={order.id as string}
          userId={userId}
          orderPrefill={{
            receiverName: (order.buyerNameSnapshot as string) || null,
            receiverPhone: (order.buyerPhoneSnapshot as string) || null,
            orderUser: (order.buyerWechatSnapshot as string) || null,
            receiverAddress: (order.buyerAddressSnapshot as string) || null,
            storeName: (order.buyerOrgNameSnapshot as string) || null,
          }}
          onBound={refresh}
        />
      )}

      {/* 新建订单发票（create 模式，预填该订单 + 行明细） */}
      <InvoiceFormDialog
        open={invoiceDialogOpen}
        onOpenChange={setInvoiceDialogOpen}
        editingInvoice={null}
        createUrl="/api/finance/order-invoices"
        patchUrlPrefix="/api/finance/order-invoices"
        extraPayload={{ orderId: order.id as string }}
        showProjectCode={false}
        aiDraftUrl={aiDraftUrl}
        defaultValues={{
          contactName: ((order.buyerNameSnapshot || cust?.name) as string) || undefined,
          buyerOrgName: ((order.buyerOrgNameSnapshot || custOrgName) as string) || undefined,
          buyerOrgId: (cust?.organizationId as string) || undefined,
          contentSummary: (order.title as string) || undefined,
          invoiceType: "NORMAL",
          items: lines.length > 0
            ? lines.map((l) => ({
                itemName: String(l.itemName || ""),
                spec: String(l.spec || ""),
                unit: String(l.unit || ""),
                quantity: String(l.quantity || ""),
                amount: String(l.amount || 0),
              }))
            : [{ itemName: (order.title as string) || "订单服务", spec: "", unit: "项", quantity: "1", amount: String(order.totalAmount || 0) }],
        }}
        onSuccess={refresh}
      />

      {/* 新增订单成本 */}
      <CostFormDialog
        open={costDialogOpen}
        onOpenChange={setCostDialogOpen}
        defaultOrderId={order.id as string}
        defaultProfileId={((order.profileId as string) || (crmProfile?.id as string) || undefined)}
        defaultProjectId={projectLinks.length === 1 ? (firstProjectId as string) : undefined}
        defaultAmount={(order.financeAmountOverride ?? order.totalAmount) as number | undefined}
        onCreated={refresh}
      />

      {revisionDialogOpen && (
        <OrderRevisionDialog
          open={revisionDialogOpen}
          onOpenChange={setRevisionDialogOpen}
          onSuccess={refresh}
          orderId={order.id as string}
          currentTotalAmount={(order.totalAmount as number) || 0}
          financeAmountOverride={(order.financeAmountOverride as number) ?? null}
          category={(order.category as string) || "UNKNOWN"}
          financeTreatment={(order.financeTreatment as string) || "AUTO"}
          issuedInvoiceAmount={issuedInvoiceAmount}
          receivedAmount={receivedAmount}
          projectLinks={projectLinks.map((l) => ({
            projectId: (l.project as Rec)?.id as string,
            projectName: ((l.project as Rec)?.name as string) || "",
            allocatedAmount: l.allocatedAmount as number | null,
            isPrimary: (l.isPrimary as boolean) || false,
          }))}
        />
      )}

      <OrderCloseReasonDialog
        orderId={closeDialogOpen ? (order.id as string) : null}
        open={closeDialogOpen}
        onOpenChange={setCloseDialogOpen}
        onChanged={refresh}
        showAccrualOption={shouldShowAccrualOption({
          status: order.status as string,
          confirmedAt: order.confirmedAt as string | null,
          orderedAt: order.orderedAt as string | null,
        })}
      />
    </div>
  );
}
