"use client";

import { useState, useEffect, useMemo, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, X, Plus, Search, Eye, Upload, RotateCcw, Ban, Pencil } from "lucide-react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable } from "@/components/ui/data-table";
import { MobileCard } from "@/components/ui/mobile-card";
import { AnimatedMoney } from "@/components/ui/animated-money";
import { FinanceEmptyState } from "@/components/finance/finance-empty-state";
import { Badge } from "@/components/ui/badge";
import { InvoiceStatusBadge } from "@/components/finance/finance-status-badge";
import { InvoiceFormDialog } from "@/components/invoice-form-dialog";
import type { InvoiceRecord } from "@/components/invoice-form-dialog";
import { UploadIssuedInvoiceDialog } from "@/components/finance/upload-issued-invoice-dialog";
import { InvoiceDetailDialog } from "@/components/finance/invoice-detail-dialog";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { PageShell } from "@/components/ui/page-shell";
import { getCustomerOrganizationName } from "@/lib/customer-organization";

interface InvoiceItem {
  id: string;
  status: string;
  buyerOrganizationName: string | null;
  orderId: string | null;
  order: { orderNo: string } | null;
  totalAmount: number;
  invoiceType: string;
  actualInvoiceNo: string | null;
  actualIssuedAt: string | null;
  createdAt: string;
  updatedAt: string;
  documents: Array<{ id: string }>;
  orderCoverage: Array<{ order: { id: string; orderNo: string } | null }>;
  adjustmentsAsOriginal: Array<{ id: string; kind: string }>;
}

type InvoiceTab = "all" | "draft" | "requested" | "issued" | "red" | "cancelled";

const TAB_LABELS: Record<InvoiceTab, string> = {
  all: "全部",
  draft: "草稿",
  requested: "待登记",
  issued: "已开票",
  red: "已冲红",
  cancelled: "已取消",
};

const VALID_TABS: InvoiceTab[] = ["all", "draft", "requested", "issued", "red", "cancelled"];

interface InvoiceAction {
  key: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  variant?: "destructive" | "default";
  isPending?: boolean;
}

function daysBetween(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

function isHistoricalInvoice(inv: InvoiceItem): boolean {
  const hasOrder = inv.orderId || inv.orderCoverage.length > 0;
  return !hasOrder;
}

function statusCell(inv: InvoiceItem) {
  return (
    <div className="flex items-center justify-center gap-1">
      <InvoiceStatusBadge status={inv.status} />
      {inv.adjustmentsAsOriginal?.some((a) => a.kind === "RED") && (
        <Badge variant="outline" className="text-danger border-danger/40">已冲红</Badge>
      )}
      {isHistoricalInvoice(inv) && (
        <Badge variant="outline" className="text-muted-foreground">历史</Badge>
      )}
    </div>
  );
}

export default function InvoicesPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      }
    >
      <InvoicesContent />
    </Suspense>
  );
}

function InvoicesContent() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { confirm, prompt } = useConfirm();
  const reduceMotion = useReducedMotion();
  const [search, setSearch] = useState("");
  const tabParam = searchParams.get("tab");
  const tab: InvoiceTab =
    tabParam && VALID_TABS.includes(tabParam as InvoiceTab) ? (tabParam as InvoiceTab) : "all";
  const missingInvoiceNo = searchParams.get("missingActualInvoiceNo") === "true";
  const [page, setPage] = useState(1);
  const [issueInvoiceId, setIssueInvoiceId] = useState<string | null>(null);
  const [pendingMap, setPendingMap] = useState<Record<string, boolean>>({});
  const pageSize = 50;
  const orderId = searchParams.get("orderId");
  const editInvoiceId = searchParams.get("edit");
  const detailInvoiceId = searchParams.get("invoiceId");
  const actionParam = searchParams.get("action");
  const isMobile = useMediaQuery("(max-width: 767px)");
  const isAdmin = session?.user?.role === "ADMIN";
  // 新建发票深链：?orderId=X&action=invoice（订单上下文里直接开票，取代已删除的订单详情页财务 tab）。
  // 仅 ADMIN：发票创建是 ADMIN-only（POST /api/finance/order-invoices），非 ADMIN 不弹窗，避免白填后被 403。
  const createInvoiceOpen = actionParam === "invoice" && !editInvoiceId && isAdmin;

  const setPending = (key: string, value: boolean) => {
    setPendingMap((prev) => ({ ...prev, [key]: value }));
  };
  const isPending = (key: string) => !!pendingMap[key];

  const { data: editingInvoice, error: editError } = useQuery<InvoiceRecord>({
    queryKey: ["finance", "order-invoice", editInvoiceId],
    queryFn: async () => {
      const res = await fetch(`/api/finance/order-invoices/${editInvoiceId}`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `加载失败 (${res.status})`);
      }
      const d = await res.json();
      return d.invoice;
    },
    enabled: !!editInvoiceId,
    retry: false,
  });

  // 发票详情加载失败时回退并 toast 提示
  useEffect(() => {
    if (!editError || !editInvoiceId) return;
    toast.error(editError.message || "发票详情加载失败");
    const params = new URLSearchParams(searchParams.toString());
    params.delete("edit");
    router.push(`/finance/invoices?${params.toString()}`);
  }, [editError, editInvoiceId, router, searchParams]);

  const handleTabChange = (v: string) => {
    const newTab = v as InvoiceTab;
    setPage(1);
    const params = new URLSearchParams(searchParams.toString());
    if (newTab === "all") {
      params.delete("tab");
    } else {
      params.set("tab", newTab);
    }
    if (newTab !== "issued") {
      params.delete("missingActualInvoiceNo");
    }
    router.replace(`/finance/invoices?${params.toString()}`);
  };

  const handleMissingInvoiceNoToggle = () => {
    const next = !missingInvoiceNo;
    setPage(1);
    const params = new URLSearchParams(searchParams.toString());
    if (next) {
      params.set("missingActualInvoiceNo", "true");
      params.set("tab", "issued");
    } else {
      params.delete("missingActualInvoiceNo");
    }
    router.replace(`/finance/invoices?${params.toString()}`);
  };

  // 订单详情（含发票列表），用于按 orderId 筛选时计算剩余可开票额与预填。
  const { data: orderDetail } = useQuery<{ order: Record<string, unknown>; invoices: Record<string, unknown>[] } | null>({
    queryKey: ["finance", "invoice-order-detail", orderId],
    queryFn: async () => {
      const res = await fetch(`/api/orders/${orderId}`);
      if (!res.ok) return null;
      const d = await res.json();
      return { order: (d.order as Record<string, unknown>) ?? null, invoices: (d.invoices as Record<string, unknown>[]) ?? [] };
    },
    enabled: !!orderId,
    retry: false,
  });

  const createOrder = orderDetail?.order ?? null;

  // 新建发票预填来源（仅 create 深链 + 订单加载完成时有值）
  const createOrderCustomer = (createOrder?.customer as Record<string, unknown> | null) || null;
  const createOrgName = createOrderCustomer
    ? getCustomerOrganizationName({
        organization: createOrderCustomer.organization as string | null,
        org: createOrderCustomer.org as { canonicalName: string } | null | undefined,
      })
    : null;
  const createLines = (createOrder?.lines as Array<Record<string, unknown>>) || [];
  const createProjectLinks = (createOrder?.projectLinks as Array<Record<string, unknown>>) || [];
  const createFirstProjectId = (createProjectLinks[0]?.project as Record<string, unknown> | undefined)?.id as
    | string
    | undefined;

  // A5：按 orderId 筛选时，基于订单详情计算剩余可开票额，控制「新建发票」按钮。
  const orderRemainingYuan = useMemo(() => {
    if (!createOrder) return null;
    const invoices = orderDetail?.invoices ?? [];
    const capacity = ((createOrder.financeAmountOverride as number | null) ?? (createOrder.totalAmount as number) ?? 0);
    const occupied = invoices.reduce((sum, inv) => {
      const status = inv.status as string;
      if (!["DRAFT", "REQUESTED", "ISSUED"].includes(status)) return sum;
      const adjustments = (inv.adjustments as Array<{ kind: string }> | undefined) || [];
      if (adjustments.some((a) => a.kind === "RED" || a.kind === "REISSUE")) return sum;
      return sum + ((inv.allocatedAmount as number) || 0);
    }, 0);
    return Math.max(0, capacity - occupied);
  }, [createOrder, orderDetail?.invoices]);

  const p = new URLSearchParams();
  if (search) p.set("search", search);
  if (tab === "red") {
    p.set("hasRedAdjustment", "true");
  } else if (tab === "issued") {
    p.set("status", "ISSUED");
    p.set("hasRedAdjustment", "false");
  } else if (tab !== "all") {
    p.set("status", tab.toUpperCase());
  }
  if (missingInvoiceNo) {
    p.set("missingActualInvoiceNo", "true");
  }
  p.set("pageSize", String(pageSize));
  p.set("page", String(page));
  if (orderId) p.set("orderId", orderId);

  const { data: orderData, isLoading } = useQuery<{
    invoices: InvoiceItem[];
    total: number;
  }>({
    queryKey: ["finance", "all-invoices", search, tab, orderId, page, missingInvoiceNo],
    queryFn: () =>
      fetch(`/api/finance/order-invoices?${p.toString()}`).then((r) =>
        r.ok ? r.json() : { invoices: [], total: 0 }
      ),
  });

  if (status === "loading")
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  if (!session) {
    router.push("/login");
    return null;
  }
  if (session.user.role === "REPRESENTATIVE") {
    router.push("/dashboard");
    return null;
  }

  const invoices = orderData?.invoices || [];

  const handleCancelInvoice = async (invoiceId: string) => {
    const ok = await confirm({
      title: "取消发票",
      description: "确定要取消这张发票申请吗？",
      variant: "destructive",
    });
    if (!ok) return;
    const key = `${invoiceId}:cancel`;
    setPending(key, true);
    try {
      const res = await fetch(`/api/finance/order-invoices/${invoiceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "CANCELLED" }),
      });
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ["finance", "all-invoices"] });
        if (orderId) queryClient.invalidateQueries({ queryKey: ["order", orderId] });
      } else {
        const d = await res.json();
        toast.error(d.error || "取消失败");
      }
    } finally {
      setPending(key, false);
    }
  };

  const handleSubmitInvoice = async (invoiceId: string) => {
    const ok = await confirm({
      title: "提交发票",
      description: "确定要提交这张发票申请吗？",
    });
    if (!ok) return;
    const key = `${invoiceId}:submit`;
    setPending(key, true);
    try {
      const res = await fetch(`/api/finance/order-invoices/${invoiceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "REQUESTED" }),
      });
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ["finance", "all-invoices"] });
        if (orderId) queryClient.invalidateQueries({ queryKey: ["order", orderId] });
      } else {
        const d = await res.json();
        toast.error(d.error || "提交失败");
      }
    } finally {
      setPending(key, false);
    }
  };

  const handleRedInvoice = async (invoiceId: string) => {
    const reason = await prompt({
      title: "冲红发票",
      description: "请输入冲红原因",
      variant: "destructive",
      placeholder: "冲红原因",
    });
    if (!reason) return;
    const key = `${invoiceId}:red`;
    setPending(key, true);
    try {
      const res = await fetch(`/api/finance/order-invoices/${invoiceId}/red`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ["finance", "all-invoices"] });
        if (orderId) queryClient.invalidateQueries({ queryKey: ["order", orderId] });
      } else {
        const d = await res.json();
        toast.error(d.error || "冲红失败");
      }
    } finally {
      setPending(key, false);
    }
  };

  const getActions = (inv: InvoiceItem): InvoiceAction[] => {
    const actions: InvoiceAction[] = [];
    const hasRed = inv.adjustmentsAsOriginal?.some((a) => a.kind === "RED");
    if (!isAdmin) return actions;
    if (inv.status === "DRAFT") {
      // 草稿只允许提交/编辑/取消，禁止直接「登记已开票」
      actions.push({
        key: "submit",
        label: "提交申请",
        icon: <Upload className="h-3 w-3" />,
        onClick: () => handleSubmitInvoice(inv.id),
        isPending: isPending(`${inv.id}:submit`),
      });
      actions.push({
        key: "edit",
        label: "编辑",
        icon: <Pencil className="h-3 w-3" />,
        onClick: () => {
          const params = new URLSearchParams(searchParams.toString());
          params.set("edit", inv.id);
          params.delete("action");
          router.push(`/finance/invoices?${params.toString()}`);
        },
      });
      actions.push({
        key: "cancel",
        label: "取消",
        icon: <Ban className="h-3 w-3" />,
        onClick: () => handleCancelInvoice(inv.id),
        variant: "destructive",
        isPending: isPending(`${inv.id}:cancel`),
      });
    } else if (inv.status === "REQUESTED") {
      actions.push({
        key: "issue",
        label: "登记已开票",
        icon: <Upload className="h-3 w-3" />,
        onClick: () => setIssueInvoiceId(inv.id),
      });
      actions.push({
        key: "cancel",
        label: "取消",
        icon: <Ban className="h-3 w-3" />,
        onClick: () => handleCancelInvoice(inv.id),
        variant: "destructive",
        isPending: isPending(`${inv.id}:cancel`),
      });
    } else if (inv.status === "ISSUED" && !hasRed) {
      if ((inv.documents?.length || 0) === 0) {
        actions.push({
          key: "upload",
          label: "补传附件",
          icon: <Upload className="h-3 w-3" />,
          onClick: () => setIssueInvoiceId(inv.id),
        });
      }
      actions.push({
        key: "red",
        label: "冲红",
        icon: <RotateCcw className="h-3 w-3" />,
        onClick: () => handleRedInvoice(inv.id),
        variant: "destructive",
        isPending: isPending(`${inv.id}:red`),
      });
    }
    return actions;
  };

  const getPrimaryAction = (inv: InvoiceItem): InvoiceAction | undefined => getActions(inv)[0];

  const getInvoiceColumns = (currentTab: InvoiceTab) => {
    const statusCol = {
      key: "status",
      header: "状态",
      align: "center" as const,
      render: (inv: InvoiceItem) => statusCell(inv),
    };
    const buyerCol = {
      key: "buyerOrganizationName",
      header: "购方单位",
      sortable: true,
      sortValue: (inv: InvoiceItem) => inv.buyerOrganizationName || "",
      render: (inv: InvoiceItem) => inv.buyerOrganizationName || "-",
    };
    const orderCol = {
      key: "orderNo",
      header: "订单号",
      sortable: true,
      sortValue: (inv: InvoiceItem) => inv.order?.orderNo || "",
      render: (inv: InvoiceItem) => inv.order?.orderNo || "-",
    };
    const amountCol = {
      key: "totalAmount",
      header: "金额",
      align: "right" as const,
      sortable: true,
      sortValue: (inv: InvoiceItem) => inv.totalAmount,
      render: (inv: InvoiceItem) => (
        <AnimatedMoney value={inv.totalAmount} className="justify-end" />
      ),
    };
    const typeCol = {
      key: "invoiceType",
      header: "发票类型",
      align: "center" as const,
      sortable: true,
      sortValue: (inv: InvoiceItem) => inv.invoiceType,
      render: (inv: InvoiceItem) => (inv.invoiceType === "SPECIAL" ? "专票" : "普票"),
    };
    const actionsCol = {
      key: "actions",
      header: "操作",
      align: "center" as const,
      render: (inv: InvoiceItem) => {
        const actions = getActions(inv);
        return (
          <div className="flex items-center gap-1 justify-center">
            {inv.orderId && (
              <Link
                href={`/orders?focus=${inv.orderId}`}
                className="text-primary hover:underline text-xs"
              >
                查看
              </Link>
            )}
            {actions.map((a) => (
              <Button
                key={a.key}
                size="sm"
                variant="ghost"
                className={cn(
                  "h-7 text-xs",
                  a.variant === "destructive" && "text-destructive hover:text-destructive"
                )}
                disabled={a.isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  a.onClick();
                }}
              >
                {a.isPending ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  a.icon
                )}
                {a.label}
              </Button>
            ))}
          </div>
        );
      },
    };

    if (currentTab === "draft") {
      return [
        statusCol,
        {
          key: "dwellDays",
          header: "停留天数",
          align: "center" as const,
          sortable: true,
          sortValue: (inv: InvoiceItem) => daysBetween(inv.createdAt),
          render: (inv: InvoiceItem) => `${daysBetween(inv.createdAt)} 天`,
        },
        buyerCol,
        orderCol,
        amountCol,
        actionsCol,
      ];
    }
    if (currentTab === "requested") {
      return [
        statusCol,
        {
          key: "waitDays",
          header: "等待登记",
          align: "center" as const,
          sortable: true,
          sortValue: (inv: InvoiceItem) => daysBetween(inv.updatedAt || inv.createdAt),
          render: (inv: InvoiceItem) => `${daysBetween(inv.updatedAt || inv.createdAt)} 天`,
        },
        buyerCol,
        orderCol,
        amountCol,
        typeCol,
        actionsCol,
      ];
    }
    if (currentTab === "issued") {
      return [
        statusCol,
        buyerCol,
        orderCol,
        amountCol,
        {
          key: "actualInvoiceNo",
          header: "实际发票号",
          sortable: true,
          sortValue: (inv: InvoiceItem) => inv.actualInvoiceNo || "",
          render: (inv: InvoiceItem) => inv.actualInvoiceNo || "-",
        },
        {
          key: "attachments",
          header: "附件",
          align: "center" as const,
          render: (inv: InvoiceItem) => inv.documents?.length || 0,
        },
        {
          key: "actualIssuedAt",
          header: "开票日",
          sortable: true,
          sortValue: (inv: InvoiceItem) => inv.actualIssuedAt || "",
          render: (inv: InvoiceItem) =>
            inv.actualIssuedAt
              ? new Date(inv.actualIssuedAt).toLocaleDateString("zh-CN")
              : "-",
        },
        actionsCol,
      ];
    }

    return [
      statusCol,
      buyerCol,
      orderCol,
      amountCol,
      typeCol,
      {
        key: "actualInvoiceNo",
        header: "实际发票号",
        sortable: true,
        sortValue: (inv: InvoiceItem) => inv.actualInvoiceNo || "",
        render: (inv: InvoiceItem) => inv.actualInvoiceNo || "-",
      },
      {
        key: "createdAt",
        header: "创建时间",
        sortable: true,
        sortValue: (inv: InvoiceItem) => inv.createdAt,
        render: (inv: InvoiceItem) =>
          new Date(inv.createdAt).toLocaleDateString("zh-CN"),
      },
      {
        key: "attachments",
        header: "附件",
        align: "center" as const,
        render: (inv: InvoiceItem) => inv.documents?.length || 0,
      },
      actionsCol,
    ];
  };

  // 移动端卡片列表错峰进场
  const listContainerVariants = {
    hidden: {},
    visible: {
      transition: { staggerChildren: reduceMotion ? 0 : 0.04 },
    },
  };
  const listItemVariants = {
    hidden: reduceMotion ? {} : { opacity: 0, y: 8 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.25 } },
  };

  return (
    <PageShell className="space-y-4">
      <PageHeader
        title="发票工作台"
        description="发票队列与状态台账 — 查看发票申请、开票状态、真实发票与附件"
        backHref="/finance"
        backLabel="返回财务"
      />

      {orderId && (
        <div className="flex items-center gap-2 p-2 bg-info-bg border border-info-border rounded text-sm text-info">
          <span>当前仅查看该订单的发票</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-xs"
            onClick={() => router.push("/finance/invoices")}
          >
            <X className="h-3 w-3 mr-1" />
            清除筛选
          </Button>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative max-w-sm min-w-0 w-full">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="搜索购方/订单号/发票号..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="pl-8"
          />
        </div>
        <Tabs value={tab} onValueChange={handleTabChange}>
          <TabsList className="flex-wrap h-auto">
            {VALID_TABS.map((t) => (
              <TabsTrigger key={t} value={t}>
                {TAB_LABELS[t]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Button
          type="button"
          size="sm"
          variant={missingInvoiceNo ? "default" : "outline"}
          className="shrink-0"
          onClick={handleMissingInvoiceNoToggle}
        >
          缺发票号
        </Button>
        {orderId && isAdmin && (
          <div
            className="ml-auto"
            title={
              orderRemainingYuan == null
                ? "无法确定剩余可开票额"
                : orderRemainingYuan <= 0
                  ? "已无剩余可开票额"
                  : undefined
            }
          >
            <Button
              size="sm"
              disabled={orderRemainingYuan == null || orderRemainingYuan <= 0}
              onClick={() => router.push(`/finance/invoices?orderId=${orderId}&action=invoice`)}
            >
              <Plus className="h-3 w-3 mr-1" />
              为该订单新建发票
            </Button>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="space-y-4"
          >
            {invoices.length === 0 ? (
              <FinanceEmptyState
                title={orderId ? "该订单暂无发票" : "暂无发票记录"}
                description={orderId && isAdmin ? "可直接为该订单新建发票。" : "暂无发票记录。"}
                action={
                  orderId && isAdmin ? (
                    <Button
                      size="sm"
                      onClick={() => router.push(`/finance/invoices?orderId=${orderId}&action=invoice`)}
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      为该订单新建发票
                    </Button>
                  ) : undefined
                }
              />
            ) : isMobile ? (
              <motion.div
                className="md:hidden space-y-3"
                variants={listContainerVariants}
                initial="hidden"
                animate="visible"
              >
                {invoices.map((inv) => {
                  const actions = getActions(inv);
                  const primary = getPrimaryAction(inv);
                  const dwellLabel =
                    inv.status === "DRAFT"
                      ? `停留 ${daysBetween(inv.createdAt)} 天`
                      : inv.status === "REQUESTED"
                        ? `等待登记 ${daysBetween(inv.updatedAt || inv.createdAt)} 天`
                        : null;
                  return (
                    <motion.div key={inv.id} variants={listItemVariants} layout>
                      <MobileCard
                        title={
                          inv.buyerOrganizationName ||
                          inv.order?.orderNo ||
                          "未命名"
                        }
                        badge={statusCell(inv)}
                        metrics={[
                          {
                            label: "金额",
                            value: <AnimatedMoney value={inv.totalAmount} />,
                          },
                          {
                            label: "类型",
                            value: inv.invoiceType === "SPECIAL" ? "专票" : "普票",
                          },
                          ...(dwellLabel
                            ? [{ label: "时长", value: dwellLabel }]
                            : [
                                {
                                  label: "附件",
                                  value: `${inv.documents?.length || 0} 个`,
                                },
                              ]),
                        ]}
                        subtitle={
                          <div className="space-y-0.5">
                            {inv.order?.orderNo && <p>订单：{inv.order.orderNo}</p>}
                            <p>{new Date(inv.createdAt).toLocaleDateString("zh-CN")}</p>
                          </div>
                        }
                        primaryAction={
                          primary
                            ? {
                                label: primary.isPending ? `${primary.label}中...` : primary.label,
                                onClick: primary.isPending ? () => {} : primary.onClick,
                                icon: primary.icon,
                              }
                            : inv.orderId
                              ? {
                                  label: "查看订单",
                                  onClick: () =>
                                    router.push(`/orders?focus=${inv.orderId}`),
                                  icon: <Eye className="h-3.5 w-3.5 mr-1" />,
                                }
                              : undefined
                        }
                        moreActions={actions.slice(1, 4).map((a) => ({
                          label: a.isPending ? `${a.label}中...` : a.label,
                          onClick: a.isPending ? () => {} : a.onClick,
                          destructive: a.variant === "destructive",
                        }))}
                      />
                    </motion.div>
                  );
                })}
              </motion.div>
            ) : (
              <DataTable
                columns={getInvoiceColumns(tab)}
                data={invoices}
                keyExtractor={(inv) => inv.id}
              />
            )}

            {(orderData?.total ?? 0) > pageSize && (
              <div className="flex items-center justify-between pt-2">
                <span className="text-sm text-muted-foreground">共 {orderData?.total} 条</span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</Button>
                  <Button variant="outline" size="sm" disabled={page >= Math.ceil((orderData?.total ?? 0) / pageSize)} onClick={() => setPage((p) => p + 1)}>下一页</Button>
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      )}

      <InvoiceFormDialog
        open={!!editInvoiceId || createInvoiceOpen}
        onOpenChange={(open) => {
          if (!open) {
            const params = new URLSearchParams(searchParams.toString());
            params.delete("edit");
            params.delete("action");
            router.push(`/finance/invoices?${params.toString()}`);
          }
        }}
        editingInvoice={editingInvoice || null}
        editingInvoiceId={editInvoiceId}
        mode={editInvoiceId ? "edit" : "create"}
        createUrl="/api/finance/order-invoices"
        patchUrlPrefix="/api/finance/order-invoices"
        extraPayload={createInvoiceOpen && orderId ? { orderId } : undefined}
        aiDraftUrl={
          createInvoiceOpen && createFirstProjectId
            ? `/api/projects/${createFirstProjectId}/invoice-draft`
            : undefined
        }
        defaultValues={
          createInvoiceOpen && createOrder
            ? {
                contactName: ((createOrder.buyerNameSnapshot || createOrderCustomer?.name) as string) || undefined,
                buyerOrgName: ((createOrder.buyerOrgNameSnapshot || createOrgName) as string) || undefined,
                buyerOrgId: (createOrderCustomer?.organizationId as string) || undefined,
                contentSummary: (createOrder.title as string) || undefined,
                invoiceType: "NORMAL",
                items:
                  createLines.length > 0
                    ? createLines.map((l) => ({
                        itemName: String(l.itemName || ""),
                        spec: String(l.spec || ""),
                        unit: String(l.unit || ""),
                        quantity: String(l.quantity || ""),
                        amount: String(l.amount || ""),
                      }))
                    : [
                        {
                          itemName: (createOrder.title as string) || "订单服务",
                          spec: "",
                          unit: "项",
                          quantity: "1",
                          amount: String(createOrder.totalAmount || 0),
                        },
                      ],
              }
            : undefined
        }
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ["finance", "all-invoices"] });
          if (orderId) queryClient.invalidateQueries({ queryKey: ["order", orderId] });
        }}
      />
      <UploadIssuedInvoiceDialog
        open={!!issueInvoiceId}
        onOpenChange={(v) => { if (!v) setIssueInvoiceId(null); }}
        invoiceId={issueInvoiceId || ""}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ["finance", "all-invoices"] });
          if (orderId) queryClient.invalidateQueries({ queryKey: ["order", orderId] });
          setIssueInvoiceId(null);
        }}
      />
      <InvoiceDetailDialog
        invoiceId={detailInvoiceId}
        open={!!detailInvoiceId}
        onOpenChange={(open) => {
          if (!open) {
            const params = new URLSearchParams(searchParams.toString());
            params.delete("invoiceId");
            router.replace(`/finance/invoices?${params.toString()}`);
          }
        }}
      />
    </PageShell>
  );
}