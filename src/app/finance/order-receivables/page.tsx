"use client";

import { useState, Suspense, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import {
  Loader2,
  Search,
  ShoppingBag,
  FileText,
  AlertCircle,
  Eye,
  Receipt,
  FileSpreadsheet,
  Pencil,
  Download,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Pin,
  UserX,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { KpiCard } from "@/components/ui/kpi-card";
import { DataTable } from "@/components/ui/data-table";
import { MobileCard } from "@/components/ui/mobile-card";
import { MoneyText } from "@/components/ui/money-text";
import { FinanceEmptyState } from "@/components/finance/finance-empty-state";
import { PaymentStatusBadge, InvoiceStatusBadge } from "@/components/finance/finance-status-badge";
import { Badge } from "@/components/ui/badge";
import { getOrderCategoryLabel } from "@/lib/order-labels";
import { useMediaQuery } from "@/hooks/use-media-query";
import { PaymentVoucherWizard } from "@/components/finance/payment-voucher-wizard";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import Link from "next/link";
import { PageShell } from "@/components/ui/page-shell";

interface OrderReceivable {
  id: string;
  orderNo: string;
  title: string;
  profile: { id: string; name: string | null } | null;
  totalAmount: number;
  invoiceCapacityAmount?: number;
  invoicedAmount: number;
  invoiceDraftAmount?: number;
  invoiceRequestedAmount?: number;
  invoiceRemainingAmount?: number;
  receivedAmount: number;
  unpaidAmount?: number;
  status: string;
  orderedAt: string | null;
}

interface ReceiptItem {
  id: string;
  amount: number;
  orderAmount?: number | null;
  receivedAt: string;
  source: string;
  remark: string | null;
  profile: { id: string; name: string | null } | null;
  order: { id: string; orderNo: string } | null;
  createdBy: { id: string; name: string } | null;
  allocationCount: number;
  allocations?: Array<{
    id: string;
    invoiceId: string;
    amount: number;
    invoice?: { actualInvoiceNo: string | null } | null;
    order?: { orderNo: string | null } | null;
  }>;
}

type ViewFilter = "all" | "invoiceable" | "invoiced_unpaid" | "paid" | "no_customer";
type InvoiceSubFilter = "all" | "none" | "partial";
type ReceiptSubFilter = "all" | "zero" | "partial";

type ExpandedDimension = "receipts" | "order" | "customer" | "invoices";

interface OrderDetail {
  id: string;
  orderNo: string;
  category: string | null;
  financeTreatment: string | null;
  customerMatchStatus: string | null;
  orderedAt: string | null;
  buyerNameSnapshot: string | null;
  buyerPhoneSnapshot: string | null;
  buyerOrgNameSnapshot: string | null;
}

interface CustomerDetail {
  customer: {
    id: string;
    name: string;
    customerCode: string;
  };
  summary: {
    receivableAmount: number;
    projectInvoicedAmount: number;
    orderInvoicedAmount: number;
    totalReceiptAmount: number;
  };
  receipts: Array<{
    id: string;
    amount: number;
    receivedAt: string;
    source: string;
    remark: string | null;
  }>;
}

interface OrderInvoiceItem {
  id: string;
  status: string;
  totalAmount: number;
  allocatedAmount: number;
  invoiceType: string;
  sellerName: string | null;
  actualInvoiceNo: string | null;
  actualIssuedAt: string | null;
  adjustments?: Array<{ id: string; kind: string }>;
}

const VIEW_LABELS: Record<ViewFilter, string> = {
  all: "全部",
  invoiceable: "可开票",
  invoiced_unpaid: "待回款",
  paid: "已结清",
  no_customer: "无客户",
};

const VIEW_EMPTY: Record<ViewFilter, { title: string; description: string }> = {
  all: { title: "暂无订单记录", description: "没有符合条件的订单。全部为订单台账，可含并入项目/排除财务的订单。" },
  invoiceable: { title: "暂无可开票订单", description: "没有剩余可开票额度的订单。" },
  invoiced_unpaid: { title: "暂无待回款订单", description: "已登记开票的订单均已回款，或暂无订单。" },
  paid: { title: "暂无已结清订单", description: "尚无票齐且款齐、无在途申请的订单。" },
  no_customer: { title: "暂无无客户订单", description: "所有已确认订单均已绑定客户。" },
};

const INVOICE_SUB_LABELS: Record<InvoiceSubFilter, string> = {
  all: "全部可开",
  none: "无已登记票",
  partial: "部分可开",
};

const RECEIPT_SUB_LABELS: Record<ReceiptSubFilter, string> = {
  all: "全部待回",
  zero: "零回款",
  partial: "部分回款",
};

const SOURCE_LABELS: Record<string, string> = {
  MANUAL: "人工录入",
  PINGOODMICE_ORDER: "平台订单",
  BANK: "银行转账",
  OTHER: "其他",
};

const TREATMENT_LABELS: Record<string, string> = {
  AUTO: "自动",
  STANDALONE: "独立计入",
  PROJECT_INCLUDED: "并入项目",
  EXCLUDED: "排除",
};

const MATCH_LABELS: Record<string, string> = {
  UNMATCHED: "未匹配",
  AUTO_MATCHED: "自动匹配",
  MANUAL_MATCHED: "人工绑定",
  CONFLICT: "冲突",
};

const DIMENSION_TITLES: Record<ExpandedDimension, string> = {
  order: "订单简要",
  customer: "客户回款",
  invoices: "开票详情",
  receipts: "回款记录",
};

const VALID_VIEWS: ViewFilter[] = ["all", "invoiceable", "invoiced_unpaid", "paid", "no_customer"];

function normalizeView(raw: string | null): ViewFilter {
  if (raw === "uninvoiced") return "invoiceable";
  if (raw && VALID_VIEWS.includes(raw as ViewFilter)) return raw as ViewFilter;
  return "all";
}

function receivableProfileName(o: OrderReceivable): string {
  return o.profile?.name ?? "";
}

function receiptProfileName(r: ReceiptItem): string {
  return r.profile?.name ?? "";
}

function InvoiceableBadges({ o }: { o: OrderReceivable }) {
  const remaining = o.invoiceRemainingAmount ?? Math.max(o.totalAmount - o.invoicedAmount, 0);
  const draft = o.invoiceDraftAmount ?? 0;
  const requested = o.invoiceRequestedAmount ?? 0;
  if (remaining <= 0 && draft <= 0 && requested <= 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-0.5">
      {remaining > 0 && (
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
          {o.invoicedAmount > 0 ? "可开部分" : "可开全额"}
        </Badge>
      )}
      {draft > 0 && (
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground">
          有草稿
        </Badge>
      )}
      {requested > 0 && (
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-amber-700 border-amber-300">
          待登记占用
        </Badge>
      )}
    </div>
  );
}

const DIMENSION_ORDER: ExpandedDimension[] = ["order", "customer", "invoices", "receipts"];

const RETURN_TO = encodeURIComponent("/finance/order-receivables");

const cellButtonClass =
  "p-0 border-0 bg-transparent cursor-pointer font-inherit text-primary hover:underline";

export default function OrderReceivablesPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    }>
      <OrderReceivablesInner />
    </Suspense>
  );
}

function OrderReceivablesInner() {
  const { data: session, status } = useSession();
  const router = useRouter();

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }
  if (!session) {
    router.push("/login");
    return null;
  }
  if (session.user.role === "REPRESENTATIVE") {
    router.push("/dashboard");
    return null;
  }

  return <OrderReceivablesContent />;
}

function OrderReceivablesContent() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "ADMIN";
  const searchParams = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const reduceMotion = useReducedMotion();
  const unassignedSectionRef = useRef<HTMLDivElement>(null);

  const rawView = searchParams.get("view");
  const view = normalizeView(rawView);
  const rawInvoiceSub = searchParams.get("invoiceSub");
  const invoiceSub: InvoiceSubFilter =
    rawView === "uninvoiced"
      ? "none"
      : rawInvoiceSub === "none" || rawInvoiceSub === "partial"
        ? rawInvoiceSub
        : "all";
  const rawReceiptSub = searchParams.get("receiptSub");
  const receiptSub: ReceiptSubFilter =
    rawReceiptSub === "zero" || rawReceiptSub === "partial" ? rawReceiptSub : "all";

  const focusParam = searchParams.get("focus");
  const focusUnassigned = focusParam === "unassigned" || searchParams.get("mode") === "receipts";
  const expandParam = searchParams.get("expand");
  const dimensionParam = searchParams.get("dimension");

  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<{ orderId: string; dimension: ExpandedDimension } | null>(null);
  // 用户手动收起后记录当时的深链 key；key 变化（新深链）时自动重新展开
  const expandKey = `${expandParam}:${dimensionParam}`;
  const [dismissedExpandKey, setDismissedExpandKey] = useState<string | null>(null);
  const [voucherWizardOpen, setVoucherWizardOpen] = useState(false);
  const [editingRemarkReceipt, setEditingRemarkReceipt] = useState<ReceiptItem | null>(null);
  const [remarkDraft, setRemarkDraft] = useState("");
  const [viewingAllocations, setViewingAllocations] = useState<ReceiptItem | null>(null);

  const [unassignedExpandedOverride, setUnassignedExpandedOverride] = useState<boolean | null>(null);
  const unassignedExpanded = unassignedExpandedOverride ?? focusUnassigned;
  const [unassignedPage, setUnassignedPage] = useState(1);
  const [unassignedSearch, setUnassignedSearch] = useState("");

  const pageSizeOrders = 50;
  const pageSizeUnassigned = 20;

  const ordersQuery = useQuery<{
    orders: OrderReceivable[];
    total: number;
    totalPages: number;
    aggregate: {
      totalAmount: number;
      invoiceTotal: number;
      receiptTotal: number;
      unpaidTotal: number;
      uninvoicedTotal: number;
      remainingTotal?: number;
    };
  }>({
    queryKey: ["order-receivables", search, page, view, invoiceSub, receiptSub],
    queryFn: async () => {
      const params = new URLSearchParams({ pageSize: String(pageSizeOrders), page: String(page) });
      if (search) params.set("search", search);
      if (view !== "all") params.set("view", view);
      if (view === "invoiceable" && invoiceSub !== "all") params.set("invoiceSub", invoiceSub);
      if (view === "invoiced_unpaid" && receiptSub !== "all") params.set("receiptSub", receiptSub);
      const res = await fetch(`/api/finance/order-receivables?${params}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  const noCustomerQuery = useQuery<{
    orders: OrderReceivable[];
    total: number;
    aggregate: { totalAmount: number };
  }>({
    queryKey: ["order-receivables", "no_customer", "stats"],
    queryFn: async () => {
      const params = new URLSearchParams({ pageSize: "1", page: "1", view: "no_customer" });
      const res = await fetch(`/api/finance/order-receivables?${params}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    staleTime: 30_000,
  });

  const list = ordersQuery.data?.orders || [];
  const autoExpanded =
    expandParam === "first" && dismissedExpandKey !== expandKey && list[0]
      ? {
          orderId: list[0].id,
          dimension: (dimensionParam === "invoices" ? "invoices" : "receipts") as ExpandedDimension,
        }
      : null;
  const effectiveExpanded = expanded ?? autoExpanded;
  const expandedOrderId = effectiveExpanded?.orderId ?? null;
  const expandedDimension = effectiveExpanded?.dimension ?? "receipts";
  const expandedProfileId = list.find((o) => o.id === expandedOrderId)?.profile?.id ?? null;

  useEffect(() => {
    if (focusUnassigned && unassignedSectionRef.current) {
      const el = unassignedSectionRef.current;
      setTimeout(() => {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 100);
    }
  }, [focusUnassigned]);

  useEffect(() => {
    if (!effectiveExpanded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !editingRemarkReceipt && !viewingAllocations) {
        setExpanded(null);
        if (expandParam === "first") setDismissedExpandKey(expandKey);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [effectiveExpanded, editingRemarkReceipt, viewingAllocations, expandParam, expandKey]);

  const setView = (v: ViewFilter) => {
    const params = new URLSearchParams(searchParams.toString());
    if (v === "all") {
      params.delete("view");
    } else {
      params.set("view", v);
    }
    params.delete("invoiceSub");
    params.delete("receiptSub");
    params.delete("page");
    router.push(`/finance/order-receivables?${params.toString()}`);
    setPage(1);
  };

  const setInvoiceSub = (sub: InvoiceSubFilter) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", "invoiceable");
    if (sub === "all") params.delete("invoiceSub");
    else params.set("invoiceSub", sub);
    params.delete("page");
    router.replace(`/finance/order-receivables?${params.toString()}`);
    setPage(1);
  };

  const setReceiptSub = (sub: ReceiptSubFilter) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", "invoiced_unpaid");
    if (sub === "all") params.delete("receiptSub");
    else params.set("receiptSub", sub);
    params.delete("page");
    router.replace(`/finance/order-receivables?${params.toString()}`);
    setPage(1);
  };

  const orderReceiptsQuery = useQuery<{
    receipts: ReceiptItem[];
    total: number;
  }>({
    queryKey: ["finance", "receipts", "by-order", expandedOrderId],
    queryFn: async () => {
      const params = new URLSearchParams({
        orderId: expandedOrderId!,
        pageSize: "100",
        page: "1",
      });
      const res = await fetch(`/api/finance/receipts?${params}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    staleTime: 60_000,
    enabled: !!expandedOrderId && expandedDimension === "receipts",
  });

  const orderDetailQuery = useQuery<{ order: OrderDetail; invoices: OrderInvoiceItem[] }>({
    queryKey: ["order", "detail", expandedOrderId],
    queryFn: async () => {
      const res = await fetch(`/api/orders/${expandedOrderId}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    staleTime: 60_000,
    enabled: !!expandedOrderId && (expandedDimension === "order" || expandedDimension === "invoices"),
  });

  const customerDetailQuery = useQuery<CustomerDetail>({
    queryKey: ["finance", "profile", "detail", expandedProfileId],
    queryFn: async () => {
      const res = await fetch(`/api/finance/customers/${expandedProfileId}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    staleTime: 60_000,
    enabled: !!expandedProfileId && expandedDimension === "customer",
  });

  const unassignedCountQuery = useQuery<{
    receipts: ReceiptItem[];
    total: number;
  }>({
    queryKey: ["finance", "receipts", "unassigned", "count"],
    queryFn: async () => {
      const params = new URLSearchParams({
        unassignedOnly: "1",
        pageSize: "1",
        page: "1",
      });
      const res = await fetch(`/api/finance/receipts?${params}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    enabled: isAdmin,
  });

  const unassignedQuery = useQuery<{
    receipts: ReceiptItem[];
    total: number;
  }>({
    queryKey: ["finance", "receipts", "unassigned", unassignedSearch, unassignedPage],
    queryFn: async () => {
      const params = new URLSearchParams({
        unassignedOnly: "1",
        pageSize: String(pageSizeUnassigned),
        page: String(unassignedPage),
      });
      if (unassignedSearch) params.set("search", unassignedSearch);
      const res = await fetch(`/api/finance/receipts?${params}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    enabled: isAdmin && unassignedExpanded,
  });

  const remarkMutation = useMutation({
    mutationFn: async (payload: { id: string; remark: string }) => {
      const res = await fetch(`/api/finance/receipts/${payload.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remark: payload.remark }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "更新失败" }));
        throw new Error(err.error || "更新失败");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["finance", "receipts"] });
      queryClient.invalidateQueries({ queryKey: ["finance", "summary"] });
      setEditingRemarkReceipt(null);
      setRemarkDraft("");
      toast.success("备注已保存");
    },
    onError: (error: Error) => {
      toast.error(error.message || "备注保存失败");
    },
  });

  const startEditRemark = (r: ReceiptItem) => {
    setEditingRemarkReceipt(r);
    setRemarkDraft(r.remark || "");
  };

  const getPaymentStatus = (o: OrderReceivable) => {
    if (o.invoicedAmount <= 0) return "UNINVOICED";
    if (o.receivedAmount <= 0) return "UNPAID";
    if (o.receivedAmount < o.invoicedAmount) return "PARTIAL";
    return "PAID";
  };

  const openDetail = (order: OrderReceivable, dim: ExpandedDimension) => {
    if (effectiveExpanded?.orderId === order.id && effectiveExpanded.dimension === dim) {
      setExpanded(null);
      if (expandParam === "first") setDismissedExpandKey(expandKey);
      return;
    }
    setExpanded({ orderId: order.id, dimension: dim });
  };

  const toggleOrderExpand = (o: OrderReceivable) => {
    openDetail(o, "receipts");
  };

  const receiptColumns = (showOrderColumn = false) => [
    {
      key: "receivedAt",
      header: "到款日期",
      sortable: true,
      sortValue: (r: ReceiptItem) => r.receivedAt,
      render: (r: ReceiptItem) => new Date(r.receivedAt).toLocaleDateString("zh-CN"),
    },
    ...(showOrderColumn
      ? [{
          key: "orderNo",
          header: "订单号",
          sortable: true,
          sortValue: (r: ReceiptItem) => r.order?.orderNo || "",
          render: (r: ReceiptItem) => r.order?.orderNo || "-",
        }]
      : []),
    {
      key: "customer",
      header: "客户",
      sortable: true,
      sortValue: (r: ReceiptItem) => receiptProfileName(r),
      render: (r: ReceiptItem) => receiptProfileName(r) || "-",
    },
    {
      key: "amount",
      header: "金额",
      align: "right" as const,
      sortable: true,
      sortValue: (r: ReceiptItem) => r.orderAmount ?? r.amount,
      render: (r: ReceiptItem) => <MoneyText value={r.orderAmount ?? r.amount} tone="income" />,
    },
    {
      key: "source",
      header: "来源",
      align: "center" as const,
      render: (r: ReceiptItem) => (
        <Badge variant="outline">{SOURCE_LABELS[r.source] || r.source}</Badge>
      ),
    },
    {
      key: "allocationCount",
      header: "核销发票",
      align: "center" as const,
      render: (r: ReceiptItem) =>
        r.allocationCount > 0 ? (
          <button
            className="text-primary hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              setViewingAllocations(r);
            }}
          >
            <Badge variant="secondary">{r.allocationCount} 张</Badge>
          </button>
        ) : (
          "-"
        ),
    },
    {
      key: "createdBy",
      header: "创建人",
      align: "center" as const,
      render: (r: ReceiptItem) => r.createdBy?.name || "-",
    },
    {
      key: "remark",
      header: "备注",
      render: (r: ReceiptItem) => r.remark || "-",
    },
    {
      key: "actions",
      header: "操作",
      align: "center" as const,
      render: (r: ReceiptItem) => (
        <div className="flex items-center justify-center gap-1.5">
          {r.profile && (
            <Link
              href={`/finance/customers/${r.profile.id}?returnTo=${RETURN_TO}`}
              onClick={(e) => e.stopPropagation()}
            >
              <Button size="sm" variant="outline" className="h-7 text-xs">
                <Eye className="h-3 w-3 mr-1" />
                客户
              </Button>
            </Link>
          )}
          {r.allocationCount > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => setViewingAllocations(r)}
            >
              <Receipt className="h-3 w-3 mr-1" />
              核销
            </Button>
          )}
          {isAdmin && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => startEditRemark(r)}
            >
              <Pencil className="h-3 w-3 mr-1" />
              备注
            </Button>
          )}
        </div>
      ),
    },
  ];

  const renderReceiptRowMobile = (r: ReceiptItem, showOrder = false) => (
    <MobileCard
      key={r.id}
      title={<MoneyText value={r.orderAmount ?? r.amount} tone="income" />}
      badge={
        <Badge variant="outline">{SOURCE_LABELS[r.source] || r.source}</Badge>
      }
      subtitle={
        <div className="space-y-0.5">
          <p>到款日期：{new Date(r.receivedAt).toLocaleDateString("zh-CN")}</p>
          {showOrder && <p>订单：{r.order?.orderNo || "-"}</p>}
          <p>客户：{receiptProfileName(r) || "-"}</p>
          {r.remark && <p>备注：{r.remark}</p>}
        </div>
      }
      moreActions={[
        ...(r.profile
          ? [
              {
                label: "查看客户",
                onClick: () => router.push(`/finance/customers/${r.profile!.id}?returnTo=${RETURN_TO}`),
              },
            ]
          : []),
        ...(r.allocationCount > 0
          ? [
              {
                label: "核销明细",
                onClick: () => setViewingAllocations(r),
              },
            ]
          : []),
        ...(isAdmin
          ? [
              {
                label: "编辑备注",
                onClick: () => startEditRemark(r),
              },
            ]
          : []),
      ]}
      className="bg-muted/20"
    />
  );

  const renderOrderReceiptDetail = (order: OrderReceivable) => {
    const receipts = orderReceiptsQuery.data?.receipts || [];
    const isLoading = orderReceiptsQuery.isLoading && expandedOrderId === order.id;
    const total = receipts.reduce((s, r) => s + (r.orderAmount ?? r.amount), 0);

    return (
      <div className="py-2">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium">
            该订单的回款（{receipts.length} 笔 · <MoneyText value={total} tone="income" />）
          </p>
        </div>
        {isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : receipts.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无到款记录</p>
        ) : isMobile ? (
          <div className="space-y-2">
            {receipts.map((r) => renderReceiptRowMobile(r))}
          </div>
        ) : (
          <DataTable
            columns={receiptColumns(false)}
            data={receipts}
            keyExtractor={(r) => r.id}
          />
        )}
      </div>
    );
  };

  const renderOrderBrief = (order: OrderReceivable) => {
    const isLoading = orderDetailQuery.isLoading && expandedOrderId === order.id;
    const detail = orderDetailQuery.data?.order;

    if (isLoading) {
      return (
        <div className="flex justify-center py-6">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      );
    }
    if (!detail) {
      return <p className="text-sm text-muted-foreground">加载失败，请重试</p>;
    }

    const buyerParts = [
      detail.buyerNameSnapshot,
      detail.buyerPhoneSnapshot,
      detail.buyerOrgNameSnapshot,
    ].filter(Boolean);

    return (
      <div className="py-2 space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          <div>
            <span className="text-muted-foreground">分类</span>
            <div>
              <Badge variant="outline">{getOrderCategoryLabel(detail.category)}</Badge>
            </div>
          </div>
          <div>
            <span className="text-muted-foreground">计入口径</span>
            <div>
              <Badge variant="outline">{TREATMENT_LABELS[detail.financeTreatment || ""] || detail.financeTreatment || "-"}</Badge>
            </div>
          </div>
          <div>
            <span className="text-muted-foreground">下单日期</span>
            <div>{detail.orderedAt ? new Date(detail.orderedAt).toLocaleDateString("zh-CN") : "-"}</div>
          </div>
          <div>
            <span className="text-muted-foreground">客户匹配</span>
            <div>
              <Badge variant="outline">{MATCH_LABELS[detail.customerMatchStatus || ""] || detail.customerMatchStatus || "-"}</Badge>
            </div>
          </div>
          <div>
            <span className="text-muted-foreground">收件人</span>
            <div className="truncate" title={buyerParts.join(" / ")}>
              {buyerParts.length > 0 ? buyerParts.join(" / ") : "-"}
            </div>
          </div>
        </div>
        <div className="flex justify-end">
          <Link
            href={`/orders?focus=${order.id}&returnTo=${RETURN_TO}`}
            className="text-primary hover:underline text-xs"
          >
            查看完整详情 →
          </Link>
        </div>
      </div>
    );
  };

  const renderCustomerSummary = (order: OrderReceivable) => {
    const isLoading = customerDetailQuery.isLoading && expandedOrderId === order.id;
    const detail = customerDetailQuery.data;

    if (isLoading) {
      return (
        <div className="flex justify-center py-6">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      );
    }
    if (!detail) {
      return <p className="text-sm text-muted-foreground">加载失败，请重试</p>;
    }

    const recentReceipts = detail.receipts.slice(0, 5);
    const invoicedTotal = detail.summary.projectInvoicedAmount + detail.summary.orderInvoicedAmount;

    return (
      <div className="py-2 space-y-3">
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <span className="text-muted-foreground">应收</span>
            <div className="font-medium"><MoneyText value={detail.summary.receivableAmount} /></div>
          </div>
          <div>
            <span className="text-muted-foreground">已开票</span>
            <div className="font-medium"><MoneyText value={invoicedTotal} /></div>
          </div>
          <div>
            <span className="text-muted-foreground">已回款</span>
            <div className="font-medium"><MoneyText value={detail.summary.totalReceiptAmount} tone="income" /></div>
          </div>
        </div>
        <div>
          <p className="text-sm font-medium mb-2">近期流水</p>
          {recentReceipts.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无回款记录</p>
          ) : (
            <div className="space-y-2">
              {recentReceipts.map((r) => (
                <div key={r.id} className="flex items-center justify-between text-sm py-1 border-b last:border-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-muted-foreground shrink-0">{new Date(r.receivedAt).toLocaleDateString("zh-CN")}</span>
                    <Badge variant="outline" className="shrink-0">{SOURCE_LABELS[r.source] || r.source}</Badge>
                    {r.remark && <span className="truncate text-muted-foreground">{r.remark}</span>}
                  </div>
                  <MoneyText value={r.amount} tone="income" />
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex justify-end">
          <Link
            href={`/finance/customers/${detail.customer.id}?returnTo=${RETURN_TO}`}
            className="text-primary hover:underline text-xs"
          >
            查看客户完整财务 →
          </Link>
        </div>
      </div>
    );
  };

  const renderOrderInvoices = (order: OrderReceivable) => {
    const isLoading = orderDetailQuery.isLoading && expandedOrderId === order.id;
    const invoices = (orderDetailQuery.data?.invoices || []).filter((inv) => {
      if (inv.status !== "ISSUED") return false;
      const hasRed = inv.adjustments?.some((a) => a.kind === "RED");
      return !hasRed;
    });

    if (isLoading) {
      return (
        <div className="flex justify-center py-6">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      );
    }
    if (orderDetailQuery.isError) {
      return <p className="text-sm text-muted-foreground">加载失败，请重试</p>;
    }

    return (
      <div className="py-2">
        {invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无开票记录</p>
        ) : (
          <div className="space-y-2">
            {invoices.map((inv) => (
              <div key={inv.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-2 border-b last:border-0 text-sm">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{inv.actualInvoiceNo || "未编号"}</span>
                    <InvoiceStatusBadge status={inv.status} />
                    <Badge variant="outline">{inv.invoiceType}</Badge>
                  </div>
                  <div className="text-muted-foreground">
                    开票方：{inv.sellerName || "-"}
                    {inv.actualIssuedAt && (
                      <span className="ml-2">开具日期：{new Date(inv.actualIssuedAt).toLocaleDateString("zh-CN")}</span>
                    )}
                  </div>
                </div>
                <MoneyText value={inv.allocatedAmount} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderExpandedContent = (o: OrderReceivable) => (
    <>
      {expandedDimension === "order" && renderOrderBrief(o)}
      {expandedDimension === "customer" && renderCustomerSummary(o)}
      {expandedDimension === "invoices" && renderOrderInvoices(o)}
      {expandedDimension === "receipts" && renderOrderReceiptDetail(o)}
    </>
  );

  const stats = ordersQuery.data?.aggregate;

  return (
    <PageShell>
      <PageHeader
        title="应收与回款"
        description="流程队列可重叠：可开票 / 待回款 / 已结清按订单分摊额；「全部」为订单台账"
        backHref="/finance"
        backLabel="返回财务"
      />

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <KpiCard title="总金额" value={stats?.totalAmount || 0} icon={ShoppingBag} />
        <KpiCard
          title={view === "invoiceable" ? "剩余可开" : "未开票金额"}
          value={
            view === "invoiceable"
              ? (stats?.remainingTotal ?? stats?.uninvoicedTotal ?? 0)
              : (stats?.uninvoicedTotal || 0)
          }
          icon={FileText}
          variant="warning"
        />
        <KpiCard
          title="待回款金额"
          value={stats?.unpaidTotal || 0}
          icon={AlertCircle}
          variant={(stats?.unpaidTotal || 0) > 0 ? "warning" : "default"}
        />
        <KpiCard
          title="无客户订单金额"
          value={noCustomerQuery.data?.aggregate?.totalAmount || 0}
          icon={UserX}
          variant="warning"
          description={`${noCustomerQuery.data?.total ?? 0} 笔 · 去绑定`}
          href="/finance/order-receivables?view=no_customer"
        />
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative max-w-sm min-w-0 w-full">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="搜索订单号..."
              className="pl-8 w-full"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
          {(session?.user?.role === "ADMIN" || session?.user?.role === "USER") && (
            <>
              <Button variant="default" size="sm" onClick={() => setVoucherWizardOpen(true)}>
                <Receipt className="h-4 w-4 mr-1" />
                凭证匹配
              </Button>
              <Button variant="outline" size="sm" onClick={() => router.push("/finance/bank-flow-import")}>
                <FileSpreadsheet className="h-4 w-4 mr-1" />
                批量导入
              </Button>
            </>
          )}
        </div>

        <Tabs value={view} onValueChange={(v) => setView(v as ViewFilter)}>
          <TabsList>
            {(Object.keys(VIEW_LABELS) as ViewFilter[]).map((v) => (
              <TabsTrigger key={v} value={v}>
                {VIEW_LABELS[v]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {view === "invoiceable" && (
          <div className="flex flex-wrap gap-2">
            {(Object.keys(INVOICE_SUB_LABELS) as InvoiceSubFilter[]).map((sub) => (
              <Button
                key={sub}
                size="sm"
                variant={invoiceSub === sub ? "default" : "outline"}
                className="h-7 text-xs"
                onClick={() => setInvoiceSub(sub)}
              >
                {INVOICE_SUB_LABELS[sub]}
              </Button>
            ))}
          </div>
        )}
        {view === "invoiced_unpaid" && (
          <div className="flex flex-wrap gap-2">
            {(Object.keys(RECEIPT_SUB_LABELS) as ReceiptSubFilter[]).map((sub) => (
              <Button
                key={sub}
                size="sm"
                variant={receiptSub === sub ? "default" : "outline"}
                className="h-7 text-xs"
                onClick={() => setReceiptSub(sub)}
              >
                {RECEIPT_SUB_LABELS[sub]}
              </Button>
            ))}
          </div>
        )}
      </div>

      {ordersQuery.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`${view}:${invoiceSub}:${receiptSub}`}
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            {list.length === 0 ? (
              <FinanceEmptyState
                title={VIEW_EMPTY[view].title}
                description={VIEW_EMPTY[view].description}
              />
            ) : isMobile ? (
              <div className="md:hidden space-y-3">
                {list.map((o) => {
                  const remaining = o.invoiceRemainingAmount ?? Math.max(o.totalAmount - o.invoicedAmount, 0);
                  const receivable = o.unpaidAmount ?? Math.max(o.invoicedAmount - o.receivedAmount, 0);
                  const payStatus = getPaymentStatus(o);
                  const isExpanded = expandedOrderId === o.id;
                  return (
                    <Card
                      key={o.id}
                      className="cursor-pointer hover:bg-muted/30 transition-colors"
                      onClick={() => toggleOrderExpand(o)}
                    >
                      <CardContent className="p-4 space-y-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium truncate">{o.orderNo}</span>
                          <div className="flex items-center gap-2 shrink-0">
                            <PaymentStatusBadge status={payStatus} />
                            {isExpanded ? (
                              <ChevronUp className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            )}
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {o.profile ? (
                            <Link
                              href={`/finance/customers/${o.profile.id}?returnTo=${RETURN_TO}`}
                              onClick={(e) => e.stopPropagation()}
                              className="hover:underline text-primary"
                            >
                              {receivableProfileName(o) || "-"}
                            </Link>
                          ) : (
                            receivableProfileName(o) || "未绑定"
                          )}
                        </div>
                        <InvoiceableBadges o={o} />
                        <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-sm">
                          <div className="flex justify-between min-w-0">
                            <span className="text-muted-foreground text-xs shrink-0">金额</span>
                            <MoneyText value={o.totalAmount} />
                          </div>
                          <div className="flex justify-between min-w-0">
                            <span className="text-muted-foreground text-xs shrink-0">可开</span>
                            <MoneyText value={remaining} tone={remaining > 0 ? "warning" : "default"} />
                          </div>
                          <div className="flex justify-between min-w-0">
                            <span className="text-muted-foreground text-xs shrink-0">待回</span>
                            <MoneyText value={receivable} tone={receivable > 0 ? "warning" : "default"} />
                          </div>
                        </div>
                        <div
                          className="flex items-center gap-2 pt-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Button
                            size="sm"
                            variant="outline"
                            className="flex-1 h-9"
                            onClick={() => router.push(`/orders?focus=${o.id}&returnTo=${RETURN_TO}`)}
                          >
                            <Eye className="h-3.5 w-3.5 mr-1" />
                            查看订单
                          </Button>
                        </div>
                        {isExpanded && (
                          <div className="pt-2 border-t space-y-2 animate-[fadeIn_0.2s_ease-out]">
                            <div
                              className="flex flex-wrap gap-2"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {DIMENSION_ORDER.map((dim) => (
                                <Button
                                  key={dim}
                                  size="sm"
                                  variant={expandedDimension === dim ? "default" : "outline"}
                                  className="h-7 text-xs"
                                  disabled={dim === "customer" && !o.profile}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openDetail(o, dim);
                                  }}
                                >
                                  {DIMENSION_TITLES[dim]}
                                </Button>
                              ))}
                            </div>
                            {renderExpandedContent(o)}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            ) : (
              <DataTable
                columns={[
                  {
                    key: "orderNo",
                    header: "订单号",
                    sortable: true,
                    sortValue: (o) => o.orderNo,
                    render: (o) => {
                      const isOpen = expandedOrderId === o.id;
                      return (
                        <div>
                          <button
                            className={`${cellButtonClass} inline-flex items-center gap-1 text-left`}
                            onClick={(e) => { e.stopPropagation(); openDetail(o, "order"); }}
                          >
                            {isOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                            {o.orderNo}
                          </button>
                          <InvoiceableBadges o={o} />
                        </div>
                      );
                    },
                  },
                  {
                    key: "customer",
                    header: "客户",
                    sortable: true,
                    sortValue: (o) => receivableProfileName(o),
                    render: (o) => o.profile ? (
                      <button
                        className={`${cellButtonClass} text-left`}
                        onClick={(e) => { e.stopPropagation(); openDetail(o, "customer"); }}
                      >
                        {receivableProfileName(o) || "-"}
                      </button>
                    ) : <span className="text-muted-foreground">未绑定</span>,
                  },
                  { key: "totalAmount", header: "金额", align: "right", money: true },
                  {
                    key: "remaining",
                    header: "可开",
                    align: "right",
                    sortable: true,
                    sortValue: (o) => o.invoiceRemainingAmount ?? Math.max(o.totalAmount - o.invoicedAmount, 0),
                    render: (o) => {
                      const v = o.invoiceRemainingAmount ?? Math.max(o.totalAmount - o.invoicedAmount, 0);
                      return <MoneyText value={v} tone={v > 0 ? "warning" : "muted"} />;
                    },
                  },
                  {
                    key: "invoicedAmount",
                    header: "已开票",
                    align: "right",
                    sortable: true,
                    sortValue: (o) => o.invoicedAmount,
                    render: (o) => (
                      <button
                        className={`${cellButtonClass} hover:bg-muted/60 rounded px-2 -mx-2 transition-colors text-right w-full`}
                        onClick={(e) => { e.stopPropagation(); openDetail(o, "invoices"); }}
                      >
                        <MoneyText value={o.invoicedAmount} tone={o.invoicedAmount > 0 ? "default" : "muted"} />
                      </button>
                    ),
                  },
                  {
                    key: "receivedAmount",
                    header: "已回款",
                    align: "right",
                    sortable: true,
                    sortValue: (o) => o.receivedAmount,
                    render: (o) => (
                      <button
                        className={`${cellButtonClass} hover:bg-muted/60 rounded px-2 -mx-2 transition-colors text-right w-full`}
                        onClick={(e) => { e.stopPropagation(); openDetail(o, "receipts"); }}
                      >
                        <MoneyText value={o.receivedAmount} tone="income" />
                      </button>
                    ),
                  },
                  {
                    key: "unreceived",
                    header: "待回款",
                    align: "right",
                    sortable: true,
                    sortValue: (o) => o.unpaidAmount ?? Math.max(o.invoicedAmount - o.receivedAmount, 0),
                    render: (o) => {
                      const v = o.unpaidAmount ?? Math.max(o.invoicedAmount - o.receivedAmount, 0);
                      return <MoneyText value={v} tone={v > 0 ? "warning" : "default"} />;
                    },
                  },
                ]}
                data={list}
                keyExtractor={(o) => o.id}
                onRowToggleExpand={(o) => toggleOrderExpand(o)}
                expandedRowKey={expandedOrderId}
                renderExpanded={(o) => (
                  <div className="py-2">
                    <p className="text-sm font-medium mb-2">{DIMENSION_TITLES[expandedDimension]}</p>
                    <div key={expandedDimension} className="animate-[fadeIn_0.2s_ease-out]">
                      {renderExpandedContent(o)}
                    </div>
                  </div>
                )}
              />
            )}

            {(ordersQuery.data?.totalPages ?? 0) > 1 && (
              <div className="flex items-center justify-between pt-2">
                <span className="text-sm text-muted-foreground">共 {ordersQuery.data?.total ?? 0} 条</span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</Button>
                  <Button variant="outline" size="sm" disabled={page >= (ordersQuery.data?.totalPages ?? 1)} onClick={() => setPage((p) => p + 1)}>下一页</Button>
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      )}

      {isAdmin && (
        <div ref={unassignedSectionRef} className="space-y-3">
          <Card
            className="cursor-pointer hover:bg-muted/30 transition-colors"
            onClick={() => setUnassignedExpandedOverride((prev) => !(prev ?? focusUnassigned))}
          >
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Pin className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">未关联订单的回款</span>
                  <span className="text-sm text-muted-foreground">
                    {unassignedCountQuery.data?.total ?? 0} 笔
                  </span>
                </div>
                {unassignedExpanded ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
            </CardContent>
          </Card>

          {unassignedExpanded && (
            <div className="space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="relative max-w-sm min-w-0 w-full">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="搜索客户/订单号/外部订单号..."
                    className="pl-8 w-full"
                    value={unassignedSearch}
                    onChange={(e) => {
                      setUnassignedSearch(e.target.value);
                      setUnassignedPage(1);
                    }}
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const params = new URLSearchParams({ unassignedOnly: "1" });
                    if (unassignedSearch) params.set("search", unassignedSearch);
                    window.open(`/api/finance/receipts/export?${params.toString()}`, "_blank");
                  }}
                >
                  <Download className="h-3.5 w-3.5 mr-1" />
                  导出
                </Button>
              </div>

              {unassignedQuery.isLoading ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin" />
                </div>
              ) : (unassignedQuery.data?.receipts || []).length === 0 ? (
                <FinanceEmptyState title="暂无未关联订单的回款" description="暂无符合条件的回款流水。" />
              ) : isMobile ? (
                <div className="md:hidden space-y-3">
                  {(unassignedQuery.data?.receipts || []).map((r) => renderReceiptRowMobile(r, true))}
                </div>
              ) : (
                <DataTable
                  columns={receiptColumns(true)}
                  data={unassignedQuery.data?.receipts || []}
                  keyExtractor={(r) => r.id}
                />
              )}

              {unassignedQuery.data && unassignedQuery.data.total > pageSizeUnassigned && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">共 {unassignedQuery.data.total} 条</span>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={unassignedPage <= 1} onClick={() => setUnassignedPage((p) => p - 1)}>
                      上一页
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={unassignedPage >= Math.ceil(unassignedQuery.data.total / pageSizeUnassigned)}
                      onClick={() => setUnassignedPage((p) => p + 1)}
                    >
                      下一页
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <PaymentVoucherWizard
        open={voucherWizardOpen}
        onOpenChange={setVoucherWizardOpen}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ["order-receivables"] });
          queryClient.invalidateQueries({ queryKey: ["finance", "receipts"] });
          queryClient.invalidateQueries({ queryKey: ["finance", "receipts", "unassigned"] });
          queryClient.invalidateQueries({ queryKey: ["finance", "summary"] });
        }}
      />

      {/* Remark edit dialog */}
      <Dialog open={!!editingRemarkReceipt} onOpenChange={(open) => { if (!open) { setEditingRemarkReceipt(null); setRemarkDraft(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑备注</DialogTitle>
            <DialogDescription>回款编号 {editingRemarkReceipt?.id}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Textarea
              placeholder="请输入备注"
              value={remarkDraft}
              onChange={(e) => setRemarkDraft(e.target.value)}
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setEditingRemarkReceipt(null); setRemarkDraft(""); }}>
              取消
            </Button>
            <Button
              disabled={remarkMutation.isPending}
              onClick={() =>
                editingRemarkReceipt &&
                remarkMutation.mutate({ id: editingRemarkReceipt.id, remark: remarkDraft.trim() })
              }
            >
              {remarkMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {remarkMutation.isPending ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View allocations dialog */}
      <Dialog open={!!viewingAllocations} onOpenChange={(open) => { if (!open) setViewingAllocations(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>回款核销明细</DialogTitle>
            <DialogDescription>回款编号 {viewingAllocations?.id}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-[60vh] overflow-y-auto">
            {(viewingAllocations?.allocations || []).map((a) => (
              <div key={a.id} className="flex items-center justify-between py-2 border-b text-sm">
                <div>
                  <p className="font-medium">{a.invoice?.actualInvoiceNo || a.invoiceId}</p>
                  {a.order?.orderNo && (
                    <p className="text-xs text-muted-foreground">订单: {a.order.orderNo}</p>
                  )}
                </div>
                <MoneyText value={a.amount} tone="income" />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewingAllocations(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}