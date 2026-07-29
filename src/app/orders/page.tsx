"use client";

import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectDisplay, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ProjectBindDialog } from "@/components/finance/project-bind-dialog";
import { InvoiceFormDialog } from "@/components/invoice-form-dialog";
import { InvoiceCartBar } from "@/components/invoice-cart-bar";
import { useInvoiceCart, type CartItem } from "@/hooks/use-invoice-cart";
import { centsToYuan } from "@/lib/finance/money";
import { DataTable, DataTableColumn } from "@/components/ui/data-table";
import { KpiCard } from "@/components/ui/kpi-card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FolderTree, Filter, X, FileText, Trash2, Merge, Tags, Play, ScanSearch, Plus, MoreHorizontal, SlidersHorizontal, ListChecks, ShoppingCart, BadgeCheck, Wallet, CalendarClock, Building2, Headphones, ChevronDown, ExternalLink, Link2, HeartHandshake, Search, ArrowUp, ArrowDown } from "lucide-react";
import { canAccessOrders } from "@/lib/role-guards";
import { cn } from "@/lib/utils";
import { getOrderSourcePublicLabel, getOrderSourceDisplay } from "@/lib/orders/source-labels";
import { OrderStatusMenuItems, OrderCloseReasonDialog, shouldShowAccrualOption } from "@/components/orders/order-transition-controls";
import { OrderAmountSummary } from "@/components/orders/order-display";
import { OrderStatusBadge } from "@/components/orders/order-status-badge";
import { OrderAmountCell, type OrderFinanceTotals } from "@/components/orders/order-amount-cell";
import { OrderRowDrawer } from "@/components/orders/order-row-drawer";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useMediaQuery } from "@/hooks/use-media-query";

const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
const PAGE_SIZE_STORAGE_KEY = "orders.pageSize";

const STATUS_LABELS: Record<string, string> = { DRAFT: "草稿", CONFIRMED: "已确认", DELIVERED: "已交付", CLOSED: "已关闭" };

const CATEGORY_LABELS: Record<string, string> = { SERVICE: "服务", PRODUCT: "商品", MIXED: "混合", UNKNOWN: "未分类" };
const TREATMENT_LABELS: Record<string, string> = { AUTO: "自动", STANDALONE: "独立计入", PROJECT_INCLUDED: "并入项目", EXCLUDED: "排除" };
const MATCH_LABELS: Record<string, string> = { UNMATCHED: "未匹配", AUTO_MATCHED: "自动匹配", MANUAL_MATCHED: "人工匹配", CONFLICT: "冲突" };
const BATCH_CATEGORY_OPTIONS = [
  { value: "SERVICE", label: "服务" },
  { value: "PRODUCT", label: "商品" },
];

const FILTER_OPTIONS: Record<string, { value: string; label: string }[]> = {
  source: [{ value: "", label: "全部来源" }, { value: "MANUAL", label: "手动" }, { value: "PINGOODMICE", label: "平台导入" }, { value: "OTHER_IMPORT", label: "外部导入" }, { value: "CONTRACT_LEDGER", label: "合同台账" }],
  status: [{ value: "", label: "全部状态" }, { value: "DRAFT", label: "草稿" }, { value: "CONFIRMED", label: "已确认" }, { value: "DELIVERED", label: "已交付" }, { value: "CLOSED", label: "已关闭" }],
  category: [{ value: "", label: "全部分类" }, { value: "SERVICE", label: "服务" }, { value: "PRODUCT", label: "商品" }, { value: "UNKNOWN", label: "未分类" }],
  customerMatchStatus: [{ value: "", label: "全部匹配" }, { value: "UNMATCHED", label: "未匹配" }, { value: "AUTO_MATCHED", label: "自动匹配" }, { value: "MANUAL_MATCHED", label: "人工匹配" }, { value: "CONFLICT", label: "冲突" }],
  financeTreatment: [{ value: "", label: "全部口径" }, { value: "AUTO", label: "自动" }, { value: "STANDALONE", label: "独立计入" }, { value: "PROJECT_INCLUDED", label: "并入项目" }, { value: "EXCLUDED", label: "排除" }],
};

const SORT_OPTIONS = [
  { value: "", label: "默认" },
  { value: "orderedAt", label: "下单时间" },
  { value: "createdAt", label: "创建时间" },
  { value: "amount", label: "金额" },
  { value: "orderNo", label: "订单号" },
];

// ── 月/季度区间筛选 ──────────────────────────────────────────────
// periodType：按"新建"(orderedAt) 还是"交付"(deliveredAt) 维度筛选
const PERIOD_TYPE_OPTIONS = [
  { value: "", label: "不限时间" },
  { value: "created", label: "按新建" },
  { value: "delivered", label: "按交付" },
];
const PERIOD_PRESET_OPTIONS = [
  { value: "thisMonth", label: "本月" },
  { value: "thisQuarter", label: "本季度" },
  { value: "lastMonth", label: "上月" },
  { value: "lastQuarter", label: "上季度" },
  { value: "custom", label: "自定义" },
];

/** returnTo 安全校验：仅允许站内绝对路径，挡掉协议相对 URL（//evil.com）。 */
function isSafeReturnTo(url: string | null): url is string {
  return !!url && url.startsWith("/") && !url.startsWith("//");
}

/** Date → "YYYY-MM-DD"（本地时区）。 */
function fmtYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 预设区间 → { from, to }（YYYY-MM-DD，本地时区，含端点）。自然季 Q1=1-3月。 */
function computePeriodRange(preset: string): { from: string; to: string } | null {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (preset) {
    case "thisMonth":
      return { from: fmtYmd(new Date(y, m, 1)), to: fmtYmd(new Date(y, m + 1, 0)) };
    case "lastMonth":
      return { from: fmtYmd(new Date(y, m - 1, 1)), to: fmtYmd(new Date(y, m, 0)) };
    case "thisQuarter": {
      const q = Math.floor(m / 3);
      return { from: fmtYmd(new Date(y, q * 3, 1)), to: fmtYmd(new Date(y, q * 3 + 3, 0)) };
    }
    case "lastQuarter": {
      const q = Math.floor(m / 3);
      return { from: fmtYmd(new Date(y, (q - 1) * 3, 1)), to: fmtYmd(new Date(y, (q - 1) * 3 + 3, 0)) };
    }
    default:
      return null;
  }
}

function FilterSelect({ value, onChange, opts, className }: { value: string; onChange: (v: string) => void; opts: { value: string; label: string }[]; className?: string }) {
  return (
    <Select value={value} onValueChange={(v) => { if (v != null) onChange(v); }}>
      <SelectTrigger className={`h-9 text-xs ${className || ""}`}>
        <SelectDisplay label={opts[0].label} valueLabel={opts.find(o => o.value === value)?.label} />
      </SelectTrigger>
      <SelectContent>
        {opts.map((o) => (<SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>))}
      </SelectContent>
    </Select>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function getOrderCrmLink(order: Record<string, any>): { href: string | null; label: string } {
  const profileId = (order.profileId as string | null | undefined)
    ?? (order.profile as { id?: string } | null | undefined)?.id
    ?? (order.customer as { id?: string } | null | undefined)?.id
    ?? null;
  if (profileId) {
    return { href: `/crm/customers/${profileId}`, label: "CRM" };
  }
  const cust = order.customer as Record<string, any> | null;
  if (cust?.name) {
    return { href: `/crm/customers?search=${encodeURIComponent(cust.name)}`, label: "CRM" };
  }
  return { href: null, label: "未绑定" };
}

interface OrderRow {
  id: string;
  orderNo: string;
  externalOrderNo?: string;
  title: string;
  buyerNameSnapshot?: string | null;
  buyerOrgNameSnapshot?: string | null;
  financeAmountOverride?: number | null;
  totalAmount?: number | null;
  deleted?: boolean;
  _count?: { lines?: number; receipts?: number };
  invoiceRequests?: Array<{ status: string }>;
  invoiceCoverage?: Array<{ invoiceRequest?: { status?: string } }>;
  invoiceSummary?: {
    invoiceCount: number;
    invoiceStatusSummary: Record<string, number>;
    invoicedAmount: number;
    invoiceRequestedAmount: number;
    invoiceDraftAmount: number;
    invoiceOccupiedAmount: number;
    invoiceRemainingAmount: number;
  };
  mergeSources?: Array<{ targetOrderId: string }>;
  mergedIntoId?: string | null;
}

function getCartDisabledReason(o: Record<string, unknown>): string {
  if (o.deleted === true) return "已删除订单";
  if (typeof o.buyerOrganizationId !== "string" || (o.buyerOrganizationId as string).length === 0) {
    return "需先绑定购买方机构才能加入开票篮";
  }
  const summary = o.invoiceSummary as OrderRow["invoiceSummary"];
  if (!summary || summary.invoiceRemainingAmount == null) {
    return "无法确定剩余可开票额";
  }
  if (summary.invoiceRemainingAmount <= 0) {
    return summary.invoiceCount > 0
      ? "该订单已有部分发票，请使用单订单开票入口"
      : "已无剩余可开票额";
  }
  return "";
}

/** 订单技术支持是订单业务事实源，不从关联项目回推。 */
function getOrderTechSupport(order: Record<string, unknown>): string {
  const ts = order.techSupport;
  return typeof ts === "string" && ts.trim() ? ts.trim() : "";
}

/** 主行客户单位：优先用快照，回退到关联客户的组织名或买方机构。 */
function getOrderOrgName(order: Record<string, unknown>): string {
  const snap = order.buyerOrgNameSnapshot;
  if (typeof snap === "string" && snap.trim()) return snap.trim();
  const custOrg = (order.customer as Record<string, unknown> | undefined)?.organization as string | undefined;
  if (typeof custOrg === "string" && custOrg.trim()) return custOrg.trim();
  const buyerOrg = order.buyerOrganization as Record<string, unknown> | undefined;
  const canonical = buyerOrg?.canonicalName;
  return typeof canonical === "string" && canonical.trim() ? canonical.trim() : "";
}

/** 主行代表名：取 representative.name 快照。 */
function getOrderRepName(order: Record<string, unknown>): string {
  const rep = order.representative as Record<string, unknown> | undefined;
  const name = rep?.name;
  return typeof name === "string" && name.trim() ? name.trim() : "";
}

/**
 * 开票任务：一次开票弹窗对应的一组订单 + 默认抬头 + 是否跨购买方机构合单。
 * 动作 A 每个购买方机构组生成一个 job（allowCrossOrg=false）；动作 B 生成单个合并 job（allowCrossOrg=true）。
 */
type CartInvoiceJob = { items: CartItem[]; headerOrgName: string; allowCrossOrg: boolean };

/**
 * 由篮内订单快照构造开票弹窗默认值与提交契约（§5.5）。
 * - coverageAllocations.amountCents 直接取该订单剩余可开票金额（篮内快照 amount，分），
 *   不按机构比例重分摊（§0.1 金额不推断）。后端仍会按剩余可开票金额复核。
 * - items 金额用元字符串（弹窗内单位），与后端 yuanToCents 往返一致（整数分往返稳定）。
 */
function buildInvoiceFromCartJob(job: CartInvoiceJob) {
  const { items } = job;
  const products = [...new Set(items.map((i) => i.title).filter(Boolean))];
  // B7：多订单合票时必须显式提供 coverageAllocations；单订单可省略，由后端按发票总额自动归属。
  const coverageAllocations = items.length > 1
    ? items.map((i) => ({ orderId: i.orderId, amountCents: i.amount }))
    : undefined;
  return {
    defaults: {
      contactName: "",
      buyerOrgName: job.headerOrgName,
      contentSummary: products.join("、"),
      remark: `合并开票订单：${items.map((i) => i.orderNo).join("、")}`,
      items: items.map((i) => ({
        itemName: i.title || i.customerName || i.orderNo,
        spec: "",
        unit: "",
        quantity: "1",
        amount: String(centsToYuan(i.amount)),
      })),
    },
    extraPayload: {
      orderId: items[0].orderId,
      ...(coverageAllocations ? { coverageAllocations } : {}),
      allowCrossOrgInvoice: job.allowCrossOrg,
    } as Record<string, unknown>,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * 订单展开区：呈现主行收起后的次要信息。
 * 来源 / 分类 / 口径 / 交付 / 关联项目（全部）/ 下单日期 / 客户匹配 / 发票回款计数 / 查看详情链接。
 * 数据全部来自列表 API 已返回的字段，无需额外请求。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function OrderExpandedRow({ order, isAdmin, onBindProject, onOpenDetail }: { order: Record<string, any>; isAdmin: boolean; onBindProject: (orderId: string) => void; onOpenDetail: (orderId: string) => void }) {
  const plinks = (order.projectLinks as Array<Record<string, any>>) || [];
  const summary = order.invoiceSummary as OrderRow["invoiceSummary"];
  const receiptCount = (order._count as { receipts?: number } | undefined)?.receipts ?? 0;
  const orderedAt = order.orderedAt as string | null;
  const confirmedAt = order.confirmedAt as string | null;
  const matchStatus = order.customerMatchStatus as string | null;
  const matchReason = order.customerMatchReason as string | null;
  const isDeleted = order.deleted === true;
  const sourceDisplay = getOrderSourceDisplay(
    order.source as string,
    order.sourcePlatform as string | null,
    order.sourceRemark as string | null,
  );
  const sourceRemark = order.sourceRemark as string | null;
  const isDebugRemark = sourceRemark && /^file=.*;sheet=.*;tag=.*$/.test(sourceRemark.trim());
  const crmLink = getOrderCrmLink(order);

  const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString("zh-CN") : "-");

  // A6：基于发票摘要渲染开票状态
  const invoiceCount = summary?.invoiceCount ?? 0;
  const invoicedAmount = summary?.invoicedAmount ?? 0;
  const occupiedAmount = summary?.invoiceOccupiedAmount ?? 0;
  const remainingAmount = summary?.invoiceRemainingAmount ?? 0;
  const draftCount = summary?.invoiceStatusSummary?.DRAFT ?? 0;
  const requestedCount = summary?.invoiceStatusSummary?.REQUESTED ?? 0;

  return (
    <div className="px-2 py-1 space-y-3 text-sm">
      {/* 第一行：来源 / 分类 / 口径 / 交付 / 日期 */}
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <div>
          <span className="text-muted-foreground text-xs">来源</span>
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className="text-xs">{sourceDisplay}</Badge>
            {sourceRemark && !isDebugRemark && sourceRemark.trim() !== sourceDisplay && (
              <span className="text-xs text-muted-foreground truncate max-w-[200px]" title={sourceRemark}>{sourceRemark}</span>
            )}
          </div>
        </div>
        <div>
          <span className="text-muted-foreground text-xs">分类</span>
          <div><Badge variant="outline" className="text-xs">{CATEGORY_LABELS[order.category as string] || (order.category as string)}</Badge></div>
        </div>
        <div>
          <span className="text-muted-foreground text-xs">计入口径</span>
          <div><Badge variant="outline" className="text-xs">{TREATMENT_LABELS[order.financeTreatment as string] || (order.financeTreatment as string) || "-"}</Badge></div>
        </div>
        <div>
          <span className="text-muted-foreground text-xs">下单日期</span>
          <div>{fmtDate(orderedAt)}</div>
        </div>
        <div>
          <span className="text-muted-foreground text-xs">确认日期</span>
          <div>{fmtDate(confirmedAt)}</div>
        </div>
      </div>

      {/* 第二行：金额明细 + 发票/回款 */}
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <div>
          <span className="text-muted-foreground text-xs">金额</span>
          <OrderAmountSummary totalAmount={order.totalAmount} financeAmountOverride={order.financeAmountOverride} />
        </div>
        <div>
          <span className="text-muted-foreground text-xs">发票</span>
          <div className="flex items-center gap-1.5">
            <FileText className="h-3 w-3 text-muted-foreground" />
            {invoiceCount === 0 ? (
              <span>未开票 / 剩余 ¥{remainingAmount.toLocaleString()}</span>
            ) : occupiedAmount >= (order.financeAmountOverride ?? order.totalAmount ?? 0) ? (
              <span>已满额 / {invoiceCount} 张</span>
            ) : (
              <span>已开 ¥{invoicedAmount.toLocaleString()} / 占用 ¥{occupiedAmount.toLocaleString()} / {invoiceCount} 张</span>
            )}
            {draftCount > 0 && <Badge variant="secondary" className="text-[10px]">草稿 {draftCount}</Badge>}
            {requestedCount > 0 && <Badge variant="default" className="text-[10px]">待开 {requestedCount}</Badge>}
          </div>
        </div>
        <div>
          <span className="text-muted-foreground text-xs">回款笔数</span>
          <div>{receiptCount}</div>
        </div>
      </div>

      {/* 客户匹配状态 */}
      {matchStatus && matchStatus !== "AUTO_MATCHED" && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">客户匹配:</span>
          <Badge variant={matchStatus === "CONFLICT" ? "destructive" : "outline"} className="text-xs">
            {MATCH_LABELS[matchStatus] || matchStatus}
          </Badge>
          {matchReason && <span className="text-muted-foreground truncate max-w-[320px]" title={matchReason}>{matchReason}</span>}
        </div>
      )}

      {/* 关联项目（全部） */}
      <div>
        <span className="text-muted-foreground text-xs">关联项目 ({plinks.length})</span>
        {plinks.length === 0 ? (
          <div className="text-xs text-muted-foreground">未关联项目</div>
        ) : (
          <div className="mt-1 space-y-1">
            {plinks.map((l, i) => {
              const proj = l.project as Record<string, any> | undefined;
              const treatment = l.treatment as string;
              const isPrimary = l.isPrimary;
              const alloc = l.allocatedAmount as number | null;
              return (
                <div key={l.id as string ?? i} className="flex items-center gap-2 text-xs flex-wrap">
                  <Link href={`/projects/${proj?.id}`} className="text-primary hover:underline truncate max-w-[220px]" onClick={(e) => e.stopPropagation()}>
                    {proj?.name || "(未命名项目)"}
                  </Link>
                  {isPrimary && <Badge variant="default" className="text-xs">主关联</Badge>}
                  {treatment && <Badge variant="outline" className="text-xs">{TREATMENT_LABELS[treatment] || treatment}</Badge>}
                  {alloc != null && <span className="text-muted-foreground tabular-nums">分摊 ¥{alloc.toLocaleString()}</span>}
                  {proj?.techSupport && (
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <Headphones className="h-3 w-3" />{proj.techSupport as string}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 状态流转已移至列表 ··· 菜单（收起态可直接流转）；展开区只保留信息与快捷链接 */}

      {/* 快捷链接（outline 按钮） */}
      <div className="flex flex-wrap gap-2 pt-2 border-t" onClick={(e) => e.stopPropagation()}>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={(e) => { e.stopPropagation(); onOpenDetail(order.id as string); }}
        >
          <ExternalLink className="h-3 w-3 mr-1" />查看完整详情
        </Button>
        {isAdmin && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={isDeleted}
            onClick={(e) => { e.stopPropagation(); onBindProject(order.id as string); }}
          >
            <FolderTree className="h-3 w-3 mr-1" />{plinks.length > 0 ? "绑定/解绑项目" : "关联项目"}
          </Button>
        )}
        <Button
          render={<Link href={`/finance/invoices?orderId=${order.id as string}`} />}
          variant="outline"
          size="sm"
          className="h-7 text-xs"
        >
          <FileText className="h-3 w-3 mr-1" />查看发票
        </Button>
        {isAdmin && (
          <Button
            render={<Link href={`/finance/invoices?orderId=${order.id as string}&action=invoice`} />}
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={isDeleted}
          >
            <Plus className="h-3 w-3 mr-1" />新建发票
          </Button>
        )}
        {crmLink.href && (
          <Button
            render={<Link href={crmLink.href} />}
            variant="outline"
            size="sm"
            className="h-7 text-xs"
          >
            <HeartHandshake className="h-3 w-3 mr-1" />{crmLink.label}
          </Button>
        )}
      </div>
    </div>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 激活筛选 chip 区，桌面/移动共用；showClearAll 仅桌面展示「清除全部」。 */
function ActiveFilterChips({
  filters,
  onRemove,
  onClearAll,
  showClearAll,
  className,
}: {
  filters: { key: string; value: string; label: string }[];
  onRemove: (key: string) => void;
  onClearAll?: () => void;
  showClearAll?: boolean;
  className?: string;
}) {
  if (filters.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-1.5 ${className || ""}`}>
      {filters.map((f) => (
        <Badge key={f.key} variant="secondary" className="cursor-pointer text-xs gap-1" onClick={() => onRemove(f.key)}>
          {f.label}
          <X className="h-3 w-3" />
        </Badge>
      ))}
      {showClearAll && onClearAll && (
        <Button variant="ghost" size="sm" className="h-6 text-xs px-1" onClick={onClearAll}>清除全部</Button>
      )}
    </div>
  );
}

function OrdersContent() {
  const router = useRouter();
  const sp = useSearchParams();
  const { data: session, status: authStatus } = useSession();
  const { confirm } = useConfirm();
  const role = session?.user?.role;
  const isAdmin = role === "ADMIN";
  const isMobile = useMediaQuery("(max-width: 767px)");

  const [search, setSearch] = useState(sp.get("search") || "");
  const [debouncedSearch, setDebouncedSearch] = useState(sp.get("search") || "");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const [source, setSource] = useState(sp.get("source") || "");
  const [status, setStatus] = useState(sp.get("status") || "");
  const [category, setCategory] = useState(sp.get("category") || "");
  const [matchStatus, setMatchStatus] = useState(sp.get("customerMatchStatus") || "");
  const [treatment, setTreatment] = useState(sp.get("financeTreatment") || "");
  // 月/季度区间筛选：URL 带 created*/delivered* 时还原为 custom 区间
  const initialDeliveredRange = sp.get("deliveredFrom") || sp.get("deliveredTo");
  const initialCreatedRange = sp.get("createdFrom") || sp.get("createdTo");
  const [periodType, setPeriodType] = useState<string>(
    initialDeliveredRange ? "delivered" : initialCreatedRange ? "created" : "",
  );
  const [periodPreset, setPeriodPreset] = useState<string>(
    initialDeliveredRange || initialCreatedRange ? "custom" : "",
  );
  const [customFrom, setCustomFrom] = useState<string>(
    sp.get("deliveredFrom") || sp.get("createdFrom") || "",
  );
  const [customTo, setCustomTo] = useState<string>(
    sp.get("deliveredTo") || sp.get("createdTo") || "",
  );
  const initialPage = Number(sp.get("page")) || 1;
  const [page, setPage] = useState(initialPage);
  // pageSize：URL query 优先 → localStorage → 默认 20
  const [pageSize, setPageSize] = useState<number>(() => {
    const fromUrl = Number(sp.get("pageSize"));
    if (PAGE_SIZE_OPTIONS.includes(fromUrl as 20 | 50 | 100)) return fromUrl;
    try {
      const stored = localStorage.getItem(PAGE_SIZE_STORAGE_KEY);
      const parsed = stored ? Number(stored) : NaN;
      if (PAGE_SIZE_OPTIONS.includes(parsed as 20 | 50 | 100)) return parsed;
    } catch { /* ignore */ }
    return 20;
  });
  // 服务端排序：受控（传给 API），不在前端做内存排序
  const [sortKey, setSortKey] = useState<string>(sp.get("sort") || "");
  const [sortDir, setSortDir] = useState<"asc" | "desc">((sp.get("order") as "asc" | "desc") || "desc");
  // 行展开（范式 B：整行点击展开/收起）
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [orders, setOrders] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // 金额下拉用：批量懒加载的发票/回款/成本汇总，键为 orderId
  const [financeTotals, setFinanceTotals] = useState<Record<string, OrderFinanceTotals>>({});
  const [stats, setStats] = useState<{ total: number; draftCount: number; confirmedAmount: number; pendingReceivable: number; periodCount: number; periodType?: string } | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [projectDialogOrderId, setProjectDialogOrderId] = useState<string | null>(null);
  const [closeDialogOrder, setCloseDialogOrder] = useState<{ id: string; status: string; confirmedAt?: string | null; orderedAt?: string | null } | null>(null);

  // 行内详情抽屉（取代已删除的 /orders/[id] 路由）。深链参数 focus/action/view/returnTo
  // 仅在挂载时消费一次（下方 URL-sync effect 随后会把它们从地址栏清掉，state 已捕获）。
  const [drawerOrderId, setDrawerOrderId] = useState<string | null>(() => sp.get("focus"));
  const [drawerInitialAction, setDrawerInitialAction] = useState<string>(() => (sp.get("focus") ? sp.get("action") || "" : ""));
  const [drawerInitialView, setDrawerInitialView] = useState<string>(() => (sp.get("focus") ? sp.get("view") || "" : ""));
  const [drawerReturnTo, setDrawerReturnTo] = useState<string | null>(() => {
    const rt = sp.get("returnTo");
    return sp.get("focus") && isSafeReturnTo(rt) ? rt : null;
  });
  // 列表内打开抽屉：手动打开无 returnTo，且清掉上一次的初始 action/view（避免误触发弹窗）。
  const openDrawer = useCallback((orderId: string, action = "", view = "") => {
    setDrawerInitialAction(action);
    setDrawerInitialView(view);
    setDrawerReturnTo(null);
    setDrawerOrderId(orderId);
  }, []);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [includeAccrual, setIncludeAccrual] = useState(false);
  const [includeDeleted, setIncludeDeleted] = useState(sp.get("includeDeleted") === "true");
  // 深链带「更多筛选」字段时（分类/匹配/口径/时间区间）默认展开，避免 chip 显示但 select 被折叠
  const [showMoreFilters, setShowMoreFilters] = useState(
    !!(sp.get("category") || sp.get("customerMatchStatus") || sp.get("financeTreatment")
      || sp.get("createdFrom") || sp.get("createdTo") || sp.get("deliveredFrom") || sp.get("deliveredTo") || sp.get("includeDeleted")),
  );

  // 区间筛选派生参数：根据 periodType + preset/custom 映射成 created*/delivered* query。
  // 非自定义时前端按本地时区计算 from/to；自定义时直接用输入框。空区间返回 {}。
  const dateParams = useMemo<Record<string, string>>(() => {
    if (!periodType) return {};
    let from = "";
    let to = "";
    if (periodPreset === "custom") {
      from = customFrom;
      to = customTo;
    } else if (periodPreset) {
      const r = computePeriodRange(periodPreset);
      if (r) { from = r.from; to = r.to; }
    }
    if (!from && !to) return {};
    const prefix = periodType === "delivered" ? "delivered" : "created";
    const out: Record<string, string> = {};
    if (from) out[`${prefix}From`] = from;
    if (to) out[`${prefix}To`] = to;
    return out;
  }, [periodType, periodPreset, customFrom, customTo]);
  const dateParamsKey = JSON.stringify(dateParams);

  // Selection state
  // 开票篮：跨页持久化的选择模型（§5.1/§5.2），取代原按页 selectedIds state。
  const cart = useInvoiceCart(session?.user?.id);
  const selectedIds = cart.selectedIds;
  // 开票任务队列：动作 A 逐机构组入队顺序开票；动作 B 单条合并任务。空 = 无开票弹窗。
  const [invoiceQueue, setInvoiceQueue] = useState<CartInvoiceJob[]>([]);
  const [batchCategoryOpen, setBatchCategoryOpen] = useState(false);
  const [batchCategory, setBatchCategory] = useState("SERVICE");
  const [deleteRunning, setDeleteRunning] = useState(false);
  const [mergeRunning, setMergeRunning] = useState(false);
  const [categoryRunning, setCategoryRunning] = useState(false);
  const [scanRunning, setScanRunning] = useState(false);
  const [treatmentRunning, setTreatmentRunning] = useState(false);

  // 订单行 → CartItem 快照（§5.1）。buyerOrgId 取结构化 Order.buyerOrganizationId（订单购买方机构）；
  // buyerOrgName 仅作购买方机构显示。最终发票抬头可在开票时调整。amount 存分。
  // B7：篮内金额使用剩余可开票额（invoiceRemainingAmount），不再是订单总额。
  const toCartItem = useCallback((o: Record<string, unknown>): CartItem => {
    const cust = o.customer as Record<string, unknown> | null;
    const summary = o.invoiceSummary as OrderRow["invoiceSummary"];
    const remainingYuan = summary?.invoiceRemainingAmount;
    const amountYuan = remainingYuan != null ? remainingYuan : (((o.financeAmountOverride as number | null) ?? (o.totalAmount as number | null)) || 0);
    return {
      orderId: o.id as string,
      orderNo: (o.externalOrderNo as string) || (o.orderNo as string) || "",
      title: (o.title as string) || "",
      profileId: (o.profileId as string) || (cust?.id as string) || null,
      customerName: (cust?.name as string) || (o.buyerNameSnapshot as string) || "",
      buyerOrgId: (o.buyerOrganizationId as string) || "",
      buyerOrgName: getOrderOrgName(o),
      amount: Math.round(amountYuan * 100),
      addedAt: Date.now(),
    };
  }, []);

  // 可入篮：未删除、有结构化购买方机构，且剩余可开票额已知并大于 0（§5.1/§0.1/B7）。
  const eligibleForCart = useCallback(
    (o: Record<string, unknown>) => {
      if (o.deleted === true) return false;
      if (typeof o.buyerOrganizationId !== "string" || (o.buyerOrganizationId as string).length === 0) return false;
      const summary = o.invoiceSummary as OrderRow["invoiceSummary"];
      if (!summary || summary.invoiceRemainingAmount == null || summary.invoiceRemainingAmount <= 0) return false;
      return true;
    },
    [],
  );

  const toggleSelect = (o: Record<string, unknown>) => cart.toggle(toCartItem(o));

  const selectAllPage = () => cart.addMany(orders.filter(eligibleForCart).map(toCartItem));

  const clearSelection = cart.clear;

  const handlePageSizeChange = (next: number) => {
    setPageSize(next);
    setPage(1);
    try { localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(next)); } catch { /* ignore */ }
  };

  const handleSortChange = (key: string, dir: "asc" | "desc") => {
    setSortKey(key);
    setSortDir(dir);
    setPage(1);
  };

  const handleToolbarSortFieldChange = (value: string) => {
    setSortKey(value);
    setPage(1);
  };

  const toggleSortDir = () => {
    setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    setPage(1);
  };

  const toggleOrderExpand = (o: Record<string, unknown>) => {
    const id = o.id as string;
    setExpandedOrderId((prev) => (prev === id ? null : id));
  };

  // §5.2：翻页 / 筛选 / 排序变化后不再清空选择——开票篮跨页持久化（useInvoiceCart）。
  // 原「filters/page change → clearSelection」effect 及其 ref 记账已移除。

  // Sync filters to URL
  useEffect(() => {
    if (!canAccessOrders(role)) return;
    const p = new URLSearchParams();
    if (debouncedSearch) p.set("search", debouncedSearch);
    if (source) p.set("source", source);
    if (status) p.set("status", status);
    if (category) p.set("category", category);
    if (matchStatus) p.set("customerMatchStatus", matchStatus);
    if (treatment) p.set("financeTreatment", treatment);
    for (const [k, v] of Object.entries(dateParams)) p.set(k, v);
    if (page > 1) p.set("page", String(page));
    if (pageSize !== 20) p.set("pageSize", String(pageSize));
    if (sortKey) { p.set("sort", sortKey); p.set("order", sortDir); }
    if (includeDeleted) p.set("includeDeleted", "true");
    const qs = p.toString();
    router.replace(qs ? `/orders?${qs}` : "/orders", { scroll: false });
  }, [debouncedSearch, source, status, category, matchStatus, treatment, dateParamsKey, dateParams, page, pageSize, sortKey, sortDir, router, role, includeDeleted]);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (debouncedSearch) p.set("search", debouncedSearch);
      if (source) p.set("source", source);
      if (status) p.set("status", status);
      if (category) p.set("category", category);
      if (matchStatus) p.set("customerMatchStatus", matchStatus);
      if (treatment) p.set("financeTreatment", treatment);
      if (includeAccrual) p.set("includeAccrual", "true");
      if (includeDeleted) p.set("includeDeleted", "true");
      for (const [k, v] of Object.entries(dateParams)) p.set(k, v);
      p.set("page", String(page));
      p.set("pageSize", String(pageSize));
      if (sortKey) { p.set("sort", sortKey); p.set("order", sortDir); }
      const res = await fetch(`/api/orders?${p.toString()}`);
      if (res.ok) {
        const d = await res.json();
        setOrders(d.orders);
        setTotal(d.total);
      }
    } finally { setLoading(false); }
  }, [debouncedSearch, source, status, category, matchStatus, treatment, dateParams, page, pageSize, sortKey, sortDir, includeAccrual, includeDeleted]);

  const buildFilterParams = useCallback(() => {
    const p = new URLSearchParams();
    if (debouncedSearch) p.set("search", debouncedSearch);
    if (source) p.set("source", source);
    if (status) p.set("status", status);
    if (category) p.set("category", category);
    if (matchStatus) p.set("customerMatchStatus", matchStatus);
    if (treatment) p.set("financeTreatment", treatment);
    if (includeAccrual) p.set("includeAccrual", "true");
    if (includeDeleted) p.set("includeDeleted", "true");
    for (const [k, v] of Object.entries(dateParams)) p.set(k, v);
    return p;
  }, [debouncedSearch, source, status, category, matchStatus, treatment, dateParams, includeAccrual, includeDeleted]);

  const fetchStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const res = await fetch(`/api/orders/stats?${buildFilterParams().toString()}`);
      if (res.ok) setStats(await res.json());
    } catch { /* KPI 失败不阻塞列表 */ }
    finally { setStatsLoading(false); }
  }, [buildFilterParams]);

  useEffect(() => {
    if (authStatus !== "authenticated" || !canAccessOrders(role)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchStats();
  }, [authStatus, fetchStats, role]);

  useEffect(() => {
    if (authStatus !== "authenticated" || !canAccessOrders(role)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchOrders();
  }, [authStatus, fetchOrders, role]);

  // 金额下拉数据：列表加载后批量懒取本页订单的发票/回款/成本汇总（一次请求，避免 N+1）
  const orderIdsKey = useMemo(() => orders.map((o) => o.id as string).join(","), [orders]);
  useEffect(() => {
    if (!orderIdsKey) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFinanceTotals({});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/orders/finance-totals?orderIds=${encodeURIComponent(orderIdsKey)}`);
        if (res.ok && !cancelled) {
          const d = await res.json();
          setFinanceTotals(d.totals || {});
        }
      } catch { /* 金额下拉为增强信息，失败不阻塞列表 */ }
    })();
    return () => { cancelled = true; };
  }, [orderIdsKey]);

  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    setPage(1);
  }, [debouncedSearch, source, status, category, matchStatus, treatment, dateParamsKey]);

  if (authStatus === "loading") return <PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>;
  if (authStatus === "unauthenticated") { router.push("/login"); return null; }
  if (!canAccessOrders(role)) { router.push("/dashboard"); return null; }

  const totalPages = Math.ceil(total / pageSize);


  const hasPeriodFilter = Object.keys(dateParams).length > 0;
  const periodChipLabel = (() => {
    if (!hasPeriodFilter) return "";
    const typeLabel = periodType === "delivered" ? "交付" : "新建";
    const presetLabel = periodPreset === "custom"
      ? `${customFrom || "…"}~${customTo || "…"}`
      : (PERIOD_PRESET_OPTIONS.find((o) => o.value === periodPreset)?.label || "");
    return `${typeLabel}: ${presetLabel}`;
  })();

  const activeFilters = [
    { key: "source", value: source, label: getOrderSourcePublicLabel(source) },
    { key: "status", value: status, label: STATUS_LABELS[status] || status },
    { key: "category", value: category, label: CATEGORY_LABELS[category] || category },
    { key: "customerMatchStatus", value: matchStatus, label: MATCH_LABELS[matchStatus] || matchStatus },
    { key: "financeTreatment", value: treatment, label: TREATMENT_LABELS[treatment] || treatment },
    { key: "period", value: hasPeriodFilter ? "1" : "", label: periodChipLabel },
  ].filter(f => !!f.value);
  const hasAnyFilter = !!debouncedSearch || activeFilters.length > 0;
  // 更多筛选区内的字段数（分类/匹配/口径/时间区间）
  const moreFilterCount = [category, matchStatus, treatment].filter(Boolean).length + (hasPeriodFilter ? 1 : 0);

  function clearPeriod() {
    setPeriodType("");
    setPeriodPreset("");
    setCustomFrom("");
    setCustomTo("");
  }

  function clearFilters() {
    setSearch("");
    setSource("");
    setStatus("");
    setCategory("");
    setMatchStatus("");
    setTreatment("");
    setIncludeAccrual(false);
    setIncludeDeleted(false);
    setSortKey("");
    setSortDir("desc");
    clearPeriod();
  }

  function removeFilter(key: string) {
    if (key === "period") { clearPeriod(); return; }
    const setters: Record<string, (v: string) => void> = {
      source: setSource, status: setStatus,
      category: setCategory, customerMatchStatus: setMatchStatus, financeTreatment: setTreatment,
    };
    setters[key]?.("");
  }

  // 时间区间筛选控件（来源/状态/分类/匹配/口径之后，与"更多筛选"同处折叠区）。
  // periodType 决定筛 orderedAt(新建) 还是 deliveredAt(交付)；preset 给常用区间，custom 放开起止日期。
  const periodControls = (
    <div className="space-y-2 rounded-md border border-dashed border-input p-2">
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">时间区间</label>
        <FilterSelect value={periodType} onChange={(v) => { setPeriodType(v); if (!v) clearPeriod(); else if (!periodPreset) setPeriodPreset("thisMonth"); }} opts={PERIOD_TYPE_OPTIONS} className="w-full" />
      </div>
      {periodType && (
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">区间预设</label>
          <FilterSelect value={periodPreset} onChange={setPeriodPreset} opts={PERIOD_PRESET_OPTIONS} className="w-full" />
        </div>
      )}
      {periodType && periodPreset === "custom" && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">起</label>
            <Input type="date" value={customFrom} max={customTo || undefined} onChange={(e) => setCustomFrom(e.target.value)} className="h-9 text-xs" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">止</label>
            <Input type="date" value={customTo} min={customFrom || undefined} onChange={(e) => setCustomTo(e.target.value)} className="h-9 text-xs" />
          </div>
        </div>
      )}
    </div>
  );

  // Shared filter controls for both desktop and mobile
  const FilterControls = (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">来源</label>
        <FilterSelect value={source} onChange={setSource} opts={FILTER_OPTIONS.source} className="w-full" />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">状态</label>
        <FilterSelect value={status} onChange={setStatus} opts={FILTER_OPTIONS.status} className="w-full" />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">分类</label>
        <FilterSelect value={category} onChange={setCategory} opts={FILTER_OPTIONS.category} className="w-full" />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">匹配</label>
        <FilterSelect value={matchStatus} onChange={setMatchStatus} opts={FILTER_OPTIONS.customerMatchStatus} className="w-full" />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">口径</label>
        <FilterSelect value={treatment} onChange={setTreatment} opts={FILTER_OPTIONS.financeTreatment} className="w-full" />
      </div>
      {periodControls}
      <div className="flex items-center gap-2 pt-1">
        <Checkbox
          id="include-accrual"
          checked={includeAccrual}
          onCheckedChange={(checked) => setIncludeAccrual(Boolean(checked))}
        />
        <Label htmlFor="include-accrual" className="text-xs text-muted-foreground cursor-pointer">显示计提记录</Label>
      </div>
      {isAdmin && (
        <div className="flex items-center gap-2 pt-1">
          <Checkbox
            id="include-deleted"
            checked={includeDeleted}
            onCheckedChange={(checked) => setIncludeDeleted(Boolean(checked))}
          />
          <Label htmlFor="include-deleted" className="text-xs text-muted-foreground cursor-pointer">显示已删除</Label>
        </div>
      )}
      {hasAnyFilter && (
        <Button variant="outline" size="sm" className="w-full mt-2" onClick={() => { clearFilters(); setFilterSheetOpen(false); }}>
          <X className="h-3 w-3 mr-1" />清除全部筛选
        </Button>
      )}
    </div>
  );

  // ── Batch action helpers ────────────────────────────────────────────────

  // ── 开票篮动作（§5.5）────────────────────────────────────────────
  // 每个动作只把购买方机构组转成 CartInvoiceJob 入队；开票弹窗按队列逐个弹出。
  // 金额、购买方机构一致性、剩余可开票金额、跨购买方机构合单校验全部由后端复核（§5.6），
  // 这里不做任何财务判断，也不按名称/比例推断（§0.1）。

  // 动作 A：按购买方机构分组开票——每个购买方机构组一个 job，安全（allowCrossOrg=false）。
  function handleInvoiceGrouped() {
    const groups = cart.groupedByOrg;
    if (groups.length === 0) {
      toast.error("开票篮为空");
      return;
    }
    setInvoiceQueue(groups.map((g) => ({ items: g.items, headerOrgName: g.orgName, allowCrossOrg: false })));
  }

  // 展开明细中的「开此组」：仅把单个购买方机构组入队。
  function handleInvoiceOrg(orgId: string) {
    const g = cart.groupedByOrg.find((x) => x.orgId === orgId);
    if (!g || g.items.length === 0) return;
    setInvoiceQueue([{ items: g.items, headerOrgName: g.orgName, allowCrossOrg: false }]);
  }

  // 动作 B：跨机构合并成一张——仅 crossOrgCount>1，需强确认，allowCrossOrg=true。
  async function handleMergeInvoice() {
    const groups = cart.groupedByOrg;
    if (cart.crossOrgCount <= 1) {
      // 只有一个购买方机构组，直接走分组开票，不触发跨购买方机构合单。
      handleInvoiceGrouped();
      return;
    }
    // 抬头选条目最多的机构组（金额最大兜底），仅作显示；后端按 allowCrossOrgInvoice 放行。
    const header = [...groups].sort((a, b) => b.items.length - a.items.length || b.subtotal - a.subtotal)[0];
    const orgNames = groups.map((g) => g.orgName || "（未命名机构）");
    const ok = await confirm({
      title: "跨购买方机构合并开票",
      description: `篮中订单分属 ${cart.crossOrgCount} 个购买方机构组（${orgNames.join("、")}），合并后默认抬头为「${header.orgName || "（未命名机构）"}」。请确认这是第三方代付 / 合单场景，最终发票抬头可在开票表单中调整。`,
      variant: "destructive",
    });
    if (!ok) return;
    setInvoiceQueue([{ items: cart.items, headerOrgName: header.orgName, allowCrossOrg: true }]);
  }

  async function handleBatchDelete() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const selected = orders.filter((o) => selectedIds.has(o.id as string)) as unknown as OrderRow[];
    if (selected.some((o) => o.deleted)) {
      toast.error("已删除订单不可再次删除");
      return;
    }
    const ok = await confirm({
      title: "批量删除订单",
      description: `确认删除 ${ids.length} 条订单？已有开票/回款/成本记录的订单不会被删除。`,
      variant: "destructive",
    });
    if (!ok) return;

    setDeleteRunning(true);
    try {
      const res = await fetch("/api/orders/batch-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds: ids }),
      });
      const data = await res.json();
      if (res.ok) {
        const skipped = data.skipped as Array<{ orderId: string; orderNo: string; reason: string }> || [];
        if (skipped.length > 0) {
          toast.warning(`已删除 ${data.deletedCount} 条，${skipped.length} 条未删除`, {
            description: skipped.map((s) => `${s.orderNo}: ${s.reason}`).join("；"),
            duration: 8000,
          });
        } else {
          toast.success(`已删除 ${data.deletedCount} 条订单`);
        }
        clearSelection();
        fetchOrders();
      } else {
        toast.error(data.error || "批量删除失败");
      }
    } catch {
      toast.error("批量删除请求失败");
    } finally {
      setDeleteRunning(false);
    }
  }

  async function handleBatchMerge() {
    const ids = [...selectedIds];
    if (ids.length < 2) {
      toast.error("请至少选择 2 条订单进行合并");
      return;
    }
    const selected = orders.filter((o) => selectedIds.has(o.id as string)) as unknown as OrderRow[];
    if (selected.some((o) => o.deleted)) {
      toast.error("已删除订单不可进行批量合并");
      return;
    }
    const target = selected[0];
    const sources = selected.slice(1);

    // Pre-flight: reject merged orders
    const merged = selected.filter((o) => o.mergeSources && o.mergeSources.length > 0);
    if (merged.length > 0) {
      toast.error(`以下订单已合并，无法再次合并：${merged.map((o) => o.externalOrderNo || o.orderNo).join("、")}`);
      return;
    }

    const ok = await confirm({
      title: "批量合并订单",
      description: `确认将 ${sources.length} 条订单合并到「${target.externalOrderNo || target.orderNo}」？此操作不可撤销。`,
      variant: "destructive",
    });
    if (!ok) return;

    setMergeRunning(true);
    try {
      const res = await fetch("/api/orders/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetOrderId: target.id,
          sourceOrderIds: sources.map((source) => source.id),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "批量合并失败");
      }

      const mergedCount = typeof data.merged === "number" ? data.merged : 0;
      const rawErrors: unknown[] = Array.isArray(data.errors) ? data.errors : [];
      const failMessages = rawErrors.filter((msg): msg is string => typeof msg === "string");
      if (failMessages.length === 0) {
        toast.success(`已成功合并 ${mergedCount} 条订单`);
      } else {
        toast.warning(`合并完成：${mergedCount} 条成功，${failMessages.length} 条失败`, {
          description: failMessages.join("；"),
          duration: 8000,
        });
      }
      clearSelection();
      fetchOrders();
    } catch {
      toast.error("批量合并请求失败");
    } finally {
      setMergeRunning(false);
    }
  }

  async function handleBatchUpdateCategory() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const selected = orders.filter((o) => selectedIds.has(o.id as string)) as unknown as OrderRow[];
    if (selected.some((o) => o.deleted)) {
      toast.error("已删除订单不可修改类型");
      return;
    }

    setCategoryRunning(true);
    try {
      const res = await fetch("/api/orders/batch-update-category", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds: ids, category: batchCategory }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "批量更改订单类型失败");
        return;
      }

      toast.success(`已更新 ${data.updatedCount || ids.length} 条订单类型`);
      setBatchCategoryOpen(false);
      clearSelection();
      fetchOrders();
    } catch {
      toast.error("批量更改订单类型请求失败");
    } finally {
      setCategoryRunning(false);
    }
  }

  async function handleBatchMatchScan() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const selected = orders.filter((o) => selectedIds.has(o.id as string)) as unknown as OrderRow[];
    if (selected.some((o) => o.deleted)) {
      toast.error("已删除订单不可进行匹配扫描");
      return;
    }
    const selectedSources = [...new Set(orders
      .filter((order) => selectedIds.has(order.id as string))
      .map((order) => order.source as string)
      .filter(Boolean))];
    const scanSource = selectedSources.length === 1 ? selectedSources[0] : "ALL";

    setScanRunning(true);
    try {
      const params = new URLSearchParams();
      if (scanSource) params.set("source", scanSource);
      const res = await fetch(`/api/finance/pingoodmice/match-scan?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds: ids }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "匹配扫描失败");
        return;
      }

      toast.success(`扫描 ${data.scanned ?? ids.length} 条，自动匹配 ${data.matched ?? 0} 条，冲突 ${data.conflicted ?? 0} 条`);
      clearSelection();
      fetchOrders();
    } catch {
      toast.error("匹配扫描请求失败");
    } finally {
      setScanRunning(false);
    }
  }

  async function handleBatchExclude() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const selected = orders.filter((o) => selectedIds.has(o.id as string)) as unknown as OrderRow[];
    if (selected.some((o) => o.deleted)) {
      toast.error("已删除订单不可进行批量排除");
      return;
    }

    setTreatmentRunning(true);
    try {
      const res = await fetch("/api/orders/batch-update-finance-treatment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds: ids, financeTreatment: "EXCLUDED" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "批量排除失败");
        return;
      }

      toast.success(`已排除 ${data.updatedCount || ids.length} 条订单`);
      clearSelection();
      fetchOrders();
    } catch {
      toast.error("批量排除请求失败");
    } finally {
      setTreatmentRunning(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  const showBatchBar = selectedIds.size > 0 && isAdmin;

  // 队首开票任务：驱动开票弹窗；关闭时出队（slice(1)）逐个处理机构组。
  const currentJob = invoiceQueue[0] ?? null;
  const currentJobArtifacts = currentJob ? buildInvoiceFromCartJob(currentJob) : null;
  const currentJobKey = currentJob
    ? currentJob.items.map((i) => i.orderId).join(",") + (currentJob.allowCrossOrg ? ":merge" : "")
    : "idle";

  const columns: DataTableColumn<Record<string, unknown>>[] = [];
  if (isAdmin) {
    columns.push({
      key: "select",
      header: "",
      width: "40px",
      align: "center",
      render: (o) => {
        const canCart = eligibleForCart(o);
        return (
          <div onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={selectedIds.has(o.id as string)}
              disabled={!canCart}
              title={o.deleted === true ? "已删除订单" : !canCart ? getCartDisabledReason(o) : undefined}
              onCheckedChange={() => toggleSelect(o)}
            />
          </div>
        );
      },
    });
  }
  columns.push(
    {
      key: "orderNo",
      header: "订单号",
      width: "150px",
      sortable: true,
      render: (o) => {
        const extNo = (o.externalOrderNo || o.orderNo) as string;
        const orderId = o.id as string;
        const isExpanded = expandedOrderId === orderId;
        return (
          <div className="flex items-center gap-1">
            <ChevronDown
              className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${isExpanded ? "" : "-rotate-90"}`}
            />
            {/* 点订单号打开详情抽屉（不触发行展开）；点其余位置展开看摘要 */}
            <button
              type="button"
              className="font-mono text-xs truncate text-primary hover:underline text-left"
              title={extNo}
              onClick={(e) => { e.stopPropagation(); openDrawer(orderId); }}
            >
              {extNo}
            </button>
          </div>
        );
      },
    },
    {
      key: "title",
      header: "项目内容",
      width: "min-w-[160px]",
      render: (o) => {
        const t = (o.title as string) || "-";
        return <span className="font-medium truncate block max-w-[260px]" title={t}>{t}</span>;
      },
    },
    {
      key: "customer",
      header: "客户",
      width: "min-w-[120px]",
      render: (o) => {
        const cust = o.customer as Record<string, unknown> | null;
        const name = ((cust?.name as string) || (o.buyerNameSnapshot as string) || "-");
        const noCustomer = !cust?.id && o.status === "CONFIRMED";
        return (
          <div className="flex items-center gap-1.5">
            <span className="truncate block max-w-[160px]" title={name}>{name}</span>
            {noCustomer && (
              <Badge variant="destructive" className="text-[10px] px-1 py-0 h-4">未绑客户</Badge>
            )}
          </div>
        );
      },
    },
    {
      key: "buyerOrg",
      header: "客户单位",
      width: "min-w-[120px]",
      render: (o) => {
        const org = getOrderOrgName(o);
        return (
          <span className="text-xs truncate block max-w-[160px]" title={org}>
            {org ? <span className="inline-flex items-center gap-1"><Building2 className="h-3 w-3 text-muted-foreground shrink-0" />{org}</span> : "-"}
          </span>
        );
      },
    },
    {
      key: "representative",
      header: "代表",
      width: "90px",
      render: (o) => {
        const name = getOrderRepName(o);
        return <span className="text-xs truncate block" title={name}>{name || "-"}</span>;
      },
    },
    {
      key: "techSupport",
      header: "技术支持",
      width: "100px",
      render: (o) => {
        const ts = getOrderTechSupport(o);
        return (
          <span className="text-xs truncate block" title={ts}>
            {ts ? <span className="inline-flex items-center gap-1"><Headphones className="h-3 w-3 text-muted-foreground shrink-0" />{ts}</span> : "-"}
          </span>
        );
      },
    },
    {
      key: "amount",
      header: "金额",
      headerTitle: "按合同金额（totalAmount）排序；财务覆盖金额（含覆盖）不参与排序",
      align: "right",
      width: "110px",
      sortable: true,
      sortValue: (o) => ((o.financeAmountOverride || o.totalAmount) as number) || 0,
      render: (o) => {
        const amt = ((o.financeAmountOverride || o.totalAmount) as number) || 0;
        const hasOverride = o.financeAmountOverride != null;
        return (
          <OrderAmountCell
            orderId={o.id as string}
            amount={amt}
            hasOverride={hasOverride}
            totals={financeTotals[o.id as string]}
          />
        );
      },
    },
    {
      key: "status",
      header: "状态",
      width: "76px",
      render: (o) => (
        <OrderStatusBadge
          order={{
            id: o.id as string,
            status: o.status as string,
            orderedAt: o.orderedAt as string | null,
            confirmedAt: o.confirmedAt as string | null,
            deliveredAt: o.deliveredAt as string | null,
            createdAt: o.createdAt as string | null,
          }}
          className="text-xs"
        />
      ),
    },
    {
      key: "actions",
      header: "操作",
      width: "72px",
      align: "center",
      render: (o) => {
        const orderId = o.id as string;
        if (o.deleted === true) {
          return (
            <div className="flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
              <Badge variant="outline" className="text-[10px]">已删除</Badge>
            </div>
          );
        }
        // 操作列瘦身为单菜单：仅状态流转；绑定/解绑项目移至展开区
        if (!isAdmin) {
          return (
            <div className="flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                onClick={() => openDrawer(orderId)}
              >
                <ExternalLink className="h-3 w-3" />详情
              </button>
            </div>
          );
        }
        return (
          <div className="flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="sm" variant="ghost" className="h-7 w-7 p-0" />}>
                <MoreHorizontal className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <OrderStatusMenuItems
                  orderId={orderId}
                  status={o.status as string}
                  onChanged={fetchOrders}
                  onRequestClose={(oid) => setCloseDialogOrder({
                    id: oid,
                    status: o.status as string,
                    confirmedAt: o.confirmedAt as string | null,
                    orderedAt: o.orderedAt as string | null,
                  })}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    }
  );

  return (
    <PageShell className="space-y-4">
      <PageHeader
        title="订单管理"
        actions={
          isAdmin && (
            <div className="flex gap-2">
              <Link href="/orders/new"><Button><Plus className="mr-1 h-4 w-4" />新建订单</Button></Link>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" />}>
                  <MoreHorizontal className="mr-1 h-4 w-4" />更多
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem render={<Link href="/orders/import" />}>导入订单列表</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => window.open("/api/orders/export/contract-ledger?format=tsv", "_blank")}>
                    导出台账 TSV
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        }
      />

      {/* KPI 概览行（随筛选联动） */}
      <div className={cn("grid gap-3", isMobile ? "grid-cols-2" : "grid-cols-2 lg:grid-cols-5")}>
        {statsLoading && !stats ? (
          Array.from({ length: isMobile ? 4 : 5 }).map((_, i) => <Skeleton key={i} className="h-[104px] rounded-xl" />)
        ) : (
          <>
            <KpiCard title="订单总数" value={stats?.total ?? 0} icon={ListChecks} variant="primary" description="当前筛选范围" />
            <KpiCard title="待确认" value={stats?.draftCount ?? 0} icon={ShoppingCart} variant="warning" description="草稿订单" />
            <KpiCard title="已确认金额" value={stats?.confirmedAmount ?? 0} unit="yuan" icon={BadgeCheck} variant="success" description="已确认订单" />
            <KpiCard title="待回款金额" value={stats?.pendingReceivable ?? 0} unit="yuan" icon={Wallet} variant="danger" description="已确认 − 已到款" />
            {!isMobile && (
              <KpiCard
                title={stats?.periodType === "delivered" ? "区间交付" : stats?.periodType === "created" ? "区间新增" : "本月新增"}
                value={stats?.periodCount ?? 0}
                icon={CalendarClock}
                variant="default"
                description={stats?.periodType === "delivered" ? "按交付时间" : stats?.periodType === "created" ? "按新建时间" : "本月下单"}
              />
            )}
          </>
        )}
      </div>

      {/* Filters — Desktop */}
      <div className="hidden md:block space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex-1 min-w-[280px] max-w-[480px]">
            <Input placeholder="搜索订单号/客户/电话..." value={search} onChange={(e) => setSearch(e.target.value)} className="h-9" />
          </div>
          <FilterSelect value={source} onChange={setSource} opts={FILTER_OPTIONS.source} />
          <FilterSelect value={status} onChange={setStatus} opts={FILTER_OPTIONS.status} />
          <FilterSelect value={sortKey} onChange={handleToolbarSortFieldChange} opts={SORT_OPTIONS} />
          <Button variant="outline" size="sm" className="h-9 text-xs px-2" onClick={toggleSortDir} disabled={!sortKey}>
            {sortDir === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
            <span className="ml-1">{sortDir === "asc" ? "升序" : "降序"}</span>
          </Button>
          <Button variant="outline" size="sm" className="h-9 text-xs" onClick={() => setShowMoreFilters((v) => !v)}>
            <SlidersHorizontal className="h-3 w-3 mr-1" />更多筛选{moreFilterCount > 0 ? ` (${moreFilterCount})` : ""}
          </Button>
          {hasAnyFilter && (
            <Button variant="outline" size="sm" className="h-9 text-xs" onClick={clearFilters}>
              <X className="h-3 w-3 mr-1" />重置
            </Button>
          )}
        </div>
        {showMoreFilters && (
          <div className="flex flex-wrap items-start gap-2 rounded-lg border bg-muted/20 p-2.5">
            <FilterSelect value={category} onChange={setCategory} opts={FILTER_OPTIONS.category} />
            <FilterSelect value={matchStatus} onChange={setMatchStatus} opts={FILTER_OPTIONS.customerMatchStatus} />
            <FilterSelect value={treatment} onChange={setTreatment} opts={FILTER_OPTIONS.financeTreatment} />
            <div className="flex items-center gap-1.5">
              <FilterSelect value={periodType} onChange={(v) => { setPeriodType(v); if (!v) clearPeriod(); else if (!periodPreset) setPeriodPreset("thisMonth"); }} opts={PERIOD_TYPE_OPTIONS} />
              {periodType && (
                <FilterSelect value={periodPreset} onChange={setPeriodPreset} opts={PERIOD_PRESET_OPTIONS} />
              )}
              {periodType && periodPreset === "custom" && (
                <>
                  <Input type="date" value={customFrom} max={customTo || undefined} onChange={(e) => setCustomFrom(e.target.value)} className="h-9 w-[150px] text-xs" />
                  <span className="text-xs text-muted-foreground">~</span>
                  <Input type="date" value={customTo} min={customFrom || undefined} onChange={(e) => setCustomTo(e.target.value)} className="h-9 w-[150px] text-xs" />
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="include-accrual-desktop"
                checked={includeAccrual}
                onCheckedChange={(checked) => setIncludeAccrual(Boolean(checked))}
              />
              <Label htmlFor="include-accrual-desktop" className="text-xs text-muted-foreground cursor-pointer">显示计提记录</Label>
            </div>
            {isAdmin && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="include-deleted-desktop"
                  checked={includeDeleted}
                  onCheckedChange={(checked) => setIncludeDeleted(Boolean(checked))}
                />
                <Label htmlFor="include-deleted-desktop" className="text-xs text-muted-foreground cursor-pointer">显示已删除</Label>
              </div>
            )}
          </div>
        )}
        <ActiveFilterChips filters={activeFilters} onRemove={removeFilter} onClearAll={clearFilters} showClearAll />
      </div>

      {/* Filters — Mobile */}
      <div className="md:hidden flex items-center gap-2">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="搜索订单号/客户/电话..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 pl-9 pr-8"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-muted-foreground hover:text-foreground"
              aria-label="清空搜索"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Sheet open={filterSheetOpen} onOpenChange={setFilterSheetOpen}>
          <SheetTrigger
            render={
              <Button variant="outline" size="sm" className="h-9 shrink-0">
                <Filter className="h-4 w-4 mr-1" />
                筛选{activeFilters.length > 0 ? ` (${activeFilters.length})` : ""}
              </Button>
            }
          />
          <SheetContent
            side="bottom"
            className="max-h-[85dvh] overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]"
          >
            <SheetHeader>
              <SheetTitle>筛选条件</SheetTitle>
            </SheetHeader>
            <div className="mt-4 max-w-full overflow-x-hidden">
              {FilterControls}
            </div>
            <div className="mt-6 space-y-3">
              <label className="text-xs text-muted-foreground">排序</label>
              <div className="flex items-center gap-2">
                <FilterSelect value={sortKey} onChange={handleToolbarSortFieldChange} opts={SORT_OPTIONS} className="flex-1" />
                <Button variant="outline" size="sm" className="h-9 text-xs px-2 shrink-0" onClick={toggleSortDir} disabled={!sortKey}>
                  {sortDir === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
          </SheetContent>
        </Sheet>
      </div>

      {/* Active filter chips — Mobile */}
      <ActiveFilterChips className="md:hidden" filters={activeFilters} onRemove={removeFilter} />

      {/* Summary bar */}
      {!loading && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground bg-muted/30 rounded-lg px-4 py-2 flex-wrap">
          <span className="font-medium text-foreground">共 {total} 条</span>
          {source && <span>来源: {getOrderSourcePublicLabel(source)}</span>}
          {matchStatus === "UNMATCHED" && <span className="text-warning">待匹配</span>}
          {matchStatus === "CONFLICT" && <span className="text-danger">冲突待确认</span>}
          <div className="flex items-center gap-1.5 ml-auto">
            <span className="text-xs">每页</span>
            <Select value={String(pageSize)} onValueChange={(v) => { if (v) handlePageSizeChange(Number(v)); }}>
              <SelectTrigger className="h-7 w-[68px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((opt) => (
                  <SelectItem key={opt} value={String(opt)}>{opt} 条</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {hasAnyFilter && (
            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={clearFilters}>清除筛选</Button>
          )}
        </div>
      )}

      {/* Mobile: select-all row（开票篮跨页，仅切换本页可入篮订单） */}
      {isAdmin && !loading && orders.length > 0 && (() => {
        const eligible = orders.filter(eligibleForCart);
        const allPageSelected = eligible.length > 0 && eligible.every((o) => selectedIds.has(o.id as string));
        return (
          <div className="md:hidden flex items-center gap-2 text-xs">
            <Checkbox
              checked={allPageSelected}
              disabled={eligible.length === 0}
              onCheckedChange={() => allPageSelected ? cart.removeMany(eligible.map((o) => o.id as string)) : selectAllPage()}
            />
            <span>全选本页可开票订单</span>
            {cart.count > 0 && (
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={clearSelection}>清空开票篮（{cart.count}）</Button>
            )}
          </div>
        );
      })()}

      {/* 非开票批量操作工具栏（改类型/匹配/排除/合并/删除），与浮动开票篮分离避免语义混淆。
          仅在有选中订单且 ADMIN 时显示，行内排版不遮挡翻页。 */}
      {showBatchBar && (
        <div className="flex items-center gap-2 flex-wrap rounded-lg border bg-muted/30 px-3 py-2 mb-2">
          <span className="text-xs font-medium text-muted-foreground mr-1">批量操作（{selectedIds.size} 条）：</span>
          {isMobile ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="h-8 text-xs"><MoreHorizontal className="h-3.5 w-3.5 mr-1" />更多操作</Button>} />
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => setBatchCategoryOpen(true)}>
                  <Tags className="h-3.5 w-3.5 mr-2" />改类型
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleBatchMatchScan} disabled={scanRunning}>
                  {scanRunning ? <ScanSearch className="h-3.5 w-3.5 mr-2 animate-spin" /> : <Play className="h-3.5 w-3.5 mr-2" />}
                  匹配扫描
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleBatchExclude} disabled={treatmentRunning}>
                  <X className="h-3.5 w-3.5 mr-2" />排除
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleBatchMerge} disabled={mergeRunning}>
                  <Merge className="h-3.5 w-3.5 mr-2" />合并订单
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleBatchDelete} disabled={deleteRunning} className="text-destructive focus:text-destructive">
                  <Trash2 className="h-3.5 w-3.5 mr-2" />删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setBatchCategoryOpen(true)}>
                <Tags className="h-3 w-3 mr-1" />改类型
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleBatchMatchScan} disabled={scanRunning}>
                {scanRunning ? <ScanSearch className="h-3 w-3 animate-spin mr-1" /> : <Play className="h-3 w-3 mr-1" />}匹配扫描
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleBatchExclude} disabled={treatmentRunning}>
                <X className="h-3 w-3 mr-1" />排除
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleBatchMerge} disabled={mergeRunning}>
                <Merge className="h-3 w-3 mr-1" />合并订单
              </Button>
              <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={handleBatchDelete} disabled={deleteRunning}>
                <Trash2 className="h-3 w-3 mr-1" />删除
              </Button>
            </>
          )}
        </div>
      )}

      <DataTable
        isLoading={loading}
        data={orders}
        keyExtractor={(o, i) => (o.id as string) ?? String(i)}
        columns={columns}
        emptyTitle="暂无订单"
        emptyDescription={hasAnyFilter ? "尝试调整筛选条件" : "当前没有任何订单数据"}
        emptyAction={hasAnyFilter ? <Button variant="outline" size="sm" onClick={clearFilters}><X className="h-3 w-3 mr-1" />清除筛选</Button> : undefined}
        // 范式 B：整行点击展开/收起；进入详情走订单号列或操作菜单
        onRowToggleExpand={toggleOrderExpand}
        expandedRowKey={expandedOrderId}
        renderExpanded={(o) => (
          <div className="py-1">
            <OrderExpandedRow
              order={o}
              isAdmin={isAdmin}
              onBindProject={(orderId) => setProjectDialogOrderId(orderId)}
              onOpenDetail={(orderId) => openDrawer(orderId)}
            />
          </div>
        )}
        // 服务端排序：受控，不在前端做内存排序
        sortKey={sortKey || null}
        sortDir={sortDir}
        onSortChange={handleSortChange}
        renderMobileCard={(o) => {
          const plinks = (o.projectLinks as Array<Record<string, unknown>>) || [];
          const crmLink = getOrderCrmLink(o);
          const orderId = o.id as string;
          const firstProjectId = (plinks[0]?.project as Record<string, unknown>)?.id as string | undefined;
          const sel = selectedIds.has(orderId);
          return (
            <Card key={orderId} className={`p-3 cursor-pointer ${sel ? "ring-2 ring-primary bg-primary/5" : ""}`} onClick={() => openDrawer(orderId)}>
              <div className="flex items-center gap-2">
                {isAdmin && (
                  <Checkbox
                    checked={sel}
                    disabled={!eligibleForCart(o)}
                    title={o.deleted === true ? "已删除订单" : !eligibleForCart(o) ? getCartDisabledReason(o) : undefined}
                    className="shrink-0"
                    onClick={(e) => e.stopPropagation()}
                    onCheckedChange={() => toggleSelect(o)}
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs truncate">{(o.externalOrderNo || o.orderNo) as string}</span>
                    <div className="shrink-0 ml-2">
                      <OrderStatusBadge
                        order={{
                          id: orderId,
                          status: o.status as string,
                          orderedAt: o.orderedAt as string | null,
                          confirmedAt: o.confirmedAt as string | null,
                          deliveredAt: o.deliveredAt as string | null,
                          createdAt: o.createdAt as string | null,
                        }}
                        className="text-xs"
                      />
                    </div>
                  </div>
                  <div className="text-sm font-medium mt-1 truncate">{o.title as string}</div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className="text-xs text-muted-foreground truncate">{((o.customer as Record<string, unknown>)?.name as string) || (o.buyerNameSnapshot as string) || "无客户"}</span>
                    {!((o.customer as Record<string, unknown>)?.id as string | undefined) && o.status === "CONFIRMED" && (
                      <Badge variant="destructive" className="text-[10px] px-1 py-0 h-4 shrink-0">未绑客户</Badge>
                    )}
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="font-medium">¥{((o.financeAmountOverride || o.totalAmount) as number || 0).toLocaleString()}</span>
                    <div className="flex gap-1">
                      <Badge variant="outline" className="text-xs">{CATEGORY_LABELS[o.category as string] || (o.category as string)}</Badge>
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground truncate">
                    {getOrderOrgName(o) && <span className="inline-flex items-center gap-1 mr-2"><Building2 className="h-3 w-3" />{getOrderOrgName(o)}</span>}
                    {getOrderRepName(o) && <span className="mr-2">代表: {getOrderRepName(o)}</span>}
                    {getOrderTechSupport(o) && <span className="inline-flex items-center gap-1"><Headphones className="h-3 w-3" />{getOrderTechSupport(o)}</span>}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 mt-2 pt-2 border-t" onClick={(e) => e.stopPropagation()}>
                {/* 单菜单：首项动态（关联/绑定解绑），其余为导航（移动端无展开区，导航保留在菜单） */}
                {o.deleted === true ? (
                  <Badge variant="outline" className="h-7 text-xs">已删除</Badge>
                ) : (
                  <DropdownMenu>
                  <DropdownMenuTrigger render={<Button size="sm" variant="outline" className="flex-1 h-7 text-xs" />}>
                    <MoreHorizontal className="h-3.5 w-3.5 mr-0.5" />操作
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {isAdmin && (
                      <>
                        <OrderStatusMenuItems
                          orderId={orderId}
                          status={o.status as string}
                          onChanged={fetchOrders}
                          onRequestClose={(oid) => setCloseDialogOrder({
                    id: oid,
                    status: o.status as string,
                    confirmedAt: o.confirmedAt as string | null,
                    orderedAt: o.orderedAt as string | null,
                  })}
                        />
                        <DropdownMenuSeparator />
                      </>
                    )}
                    {isAdmin && (
                      <DropdownMenuItem onClick={() => setProjectDialogOrderId(orderId)}>
                        {plinks.length > 0 ? (
                          <><FolderTree className="h-3 w-3 mr-1" />绑定/解绑项目</>
                        ) : (
                          <><Link2 className="h-3 w-3 mr-1" />关联项目</>
                        )}
                      </DropdownMenuItem>
                    )}
                    {firstProjectId && (
                      <DropdownMenuItem render={<Link href={`/projects/${firstProjectId}`} />}>
                        项目详情{plinks.length > 1 ? ` (+${plinks.length - 1})` : ""}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem render={<Link href={`/finance/invoices?orderId=${orderId}`} />}>
                      <FileText className="h-3 w-3 mr-1" />查看发票
                    </DropdownMenuItem>
                    {isAdmin && (
                      <DropdownMenuItem render={<Link href={`/finance/invoices?orderId=${orderId}&action=invoice`} />}>
                        <Plus className="h-3 w-3 mr-1" />新建发票
                      </DropdownMenuItem>
                    )}
                    {crmLink.href && (
                      <DropdownMenuItem render={<Link href={crmLink.href} />}>{crmLink.label}</DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
                )}
              </div>
            </Card>
          );
        }}
        pagination={{
          page,
          pageSize,
          total,
          totalPages,
          onPageChange: (p) => setPage(p),
        }}
        showPageJumper
      />

      {/* Bottom spacer for floating cart bar（加高避免遮挡翻页） */}
      {showBatchBar && <div className="h-28 md:h-24" />}

      {/* Floating invoice cart bar — 跨页开票篮（§5.4/§5.5），桌面/移动各一套。
          只含开票动作；非开票批量操作在上方 OrderBatchToolbar 内，避免语义混淆。 */}
      {showBatchBar && (
        <>
          <InvoiceCartBar
            variant="desktop"
            count={cart.count}
            totalAmount={cart.totalAmount}
            crossOrgCount={cart.crossOrgCount}
            groups={cart.groupedByOrg}
            onInvoiceGrouped={handleInvoiceGrouped}
            onMergeInvoice={handleMergeInvoice}
            onInvoiceOrg={handleInvoiceOrg}
            onRemoveItem={cart.remove}
            onRemoveOrg={cart.removeOrg}
            onClear={clearSelection}
          />
          <InvoiceCartBar
            variant="mobile"
            count={cart.count}
            totalAmount={cart.totalAmount}
            crossOrgCount={cart.crossOrgCount}
            groups={cart.groupedByOrg}
            onInvoiceGrouped={handleInvoiceGrouped}
            onMergeInvoice={handleMergeInvoice}
            onInvoiceOrg={handleInvoiceOrg}
            onRemoveItem={cart.remove}
            onRemoveOrg={cart.removeOrg}
            onClear={clearSelection}
          />
        </>
      )}

      <Dialog open={batchCategoryOpen} onOpenChange={setBatchCategoryOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>批量更改订单类型</DialogTitle>
            <DialogDescription>
              已选择 {selectedIds.size} 条订单，统一修改为同一种类型。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium">订单类型</label>
            <Select value={batchCategory} onValueChange={(v) => setBatchCategory(v || "SERVICE")}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择类型" />
              </SelectTrigger>
              <SelectContent>
                {BATCH_CATEGORY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchCategoryOpen(false)} disabled={categoryRunning}>
              取消
            </Button>
            <Button onClick={handleBatchUpdateCategory} disabled={categoryRunning || selectedIds.size === 0}>
              {categoryRunning ? "提交中..." : "确认修改"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 开票弹窗：按队列逐个购买方机构组弹出（§5.5）。
          关闭（成功或取消）→ 出队处理下一组；成功额外清理篮子并刷新列表。
          per-job key 强制重挂载，避免上一组的表单状态残留到下一组。 */}
      <InvoiceFormDialog
        key={currentJobKey}
        open={!!currentJob}
        onOpenChange={(open) => {
          // 任何关闭都推进队列；取消时订单保留在篮子里（跳到下一组的 UX）。
          if (!open) setInvoiceQueue((q) => q.slice(1));
        }}
        editingInvoice={null}
        createUrl="/api/finance/order-invoices"
        patchUrlPrefix="/api/finance/order-invoices"
        onSuccess={() => {
          // 仅做篮子清理与列表刷新；队列推进交给 onOpenChange(false)（成功时弹窗会同时触发关闭）。
          if (currentJob) cart.removeMany(currentJob.items.map((i) => i.orderId));
          fetchOrders();
        }}
        defaultValues={currentJobArtifacts?.defaults ?? {}}
        extraPayload={currentJobArtifacts?.extraPayload ?? {}}
        showProjectCode={false}
        aiDraftUrl={null}
      />

      {projectDialogOrderId && (
        <ProjectBindDialog
          open={!!projectDialogOrderId}
          onOpenChange={(open) => { if (!open) setProjectDialogOrderId(null); }}
          orderId={projectDialogOrderId}
          onBound={() => { fetchOrders(); setProjectDialogOrderId(null); }}
        />
      )}
      <OrderCloseReasonDialog
        orderId={closeDialogOrder?.id ?? null}
        open={!!closeDialogOrder}
        onOpenChange={(open) => { if (!open) setCloseDialogOrder(null); }}
        onChanged={() => { fetchOrders(); setCloseDialogOrder(null); }}
        showAccrualOption={closeDialogOrder ? shouldShowAccrualOption(closeDialogOrder) : false}
      />
      <OrderRowDrawer
        orderId={drawerOrderId}
        open={!!drawerOrderId}
        onOpenChange={(open) => { if (!open) setDrawerOrderId(null); }}
        isAdmin={isAdmin}
        userId={session?.user?.id}
        role={role}
        initialAction={drawerInitialAction}
        initialView={drawerInitialView}
        returnTo={drawerReturnTo}
        onChanged={() => { fetchOrders(); fetchStats(); }}
      />
    </PageShell>
  );
}

export default function OrdersPage() {
  return (
    <Suspense fallback={<PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>}>
      <OrdersContent />
    </Suspense>
  );
}
