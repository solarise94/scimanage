"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
  FileText,
  Banknote,
  Loader2,
  Users,
  Calendar,
  Building2,
  Store,
  AlertCircle,
  CreditCard,
  FileSpreadsheet,
  Wallet,
  Upload,
  ChevronRight,
  ClipboardList,
  Timer,
  Landmark,
  Truck,
  Calculator,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { ActionCard } from "@/components/ui/action-card";
import { KpiCard } from "@/components/ui/kpi-card";
import { MoneyText } from "@/components/ui/money-text";
import type { FinanceSummary } from "@/lib/finance/types";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { UploadIssuedInvoiceDialog } from "@/components/finance/upload-issued-invoice-dialog";

interface RequestedInvoiceItem {
  id: string;
  status: string;
  buyerOrganizationName: string | null;
  totalAmount: number;
  invoiceType: string;
  createdAt: string;
  order: { orderNo: string } | null;
  orderCoverage: Array<{ order: { orderNo: string } | null }>;
}

function invoiceOrderNo(inv: RequestedInvoiceItem): string {
  return inv.order?.orderNo || inv.orderCoverage[0]?.order?.orderNo || "—";
}

export default function FinancePage() {
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

  return <FinanceDashboard />;
}

function FinanceDashboard() {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const isAdmin = session?.user?.role === "ADMIN";
  const [includeArchived, setIncludeArchived] = useState(false);
  const [issueInvoiceId, setIssueInvoiceId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<FinanceSummary>({
    queryKey: ["finance", "summary", includeArchived],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (includeArchived) params.set("includeArchived", "true");
      const res = await fetch(`/api/finance/summary?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });

  const { data: requestedData, isLoading: requestedLoading } = useQuery<{
    invoices: RequestedInvoiceItem[];
    total: number;
  }>({
    queryKey: ["finance", "requested-invoices-queue"],
    queryFn: async () => {
      const params = new URLSearchParams({
        status: "REQUESTED",
        hasRedAdjustment: "false",
        pageSize: "5",
        page: "1",
      });
      const res = await fetch(`/api/finance/order-invoices?${params.toString()}`);
      if (!res.ok) return { invoices: [], total: 0 };
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <PageShell>
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </PageShell>
    );
  }

  const summary = data;
  const totalReceipt = summary?.totalReceiptAmount ?? 0;
  const requestedInvoices = requestedData?.invoices ?? [];
  const requestedTotal = requestedData?.total ?? 0;

  return (
    <PageShell>
      <PageHeader
        title="财务工作台"
        description="催开票、催回款、看回款健康度"
      />

      {isAdmin && (
        <div className="flex items-center gap-2">
          <input
            id="finance-include-archived"
            type="checkbox"
            className="h-4 w-4 rounded border-input"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          <label htmlFor="finance-include-archived" className="text-sm text-muted-foreground cursor-pointer">含归档客户/项目</label>
        </div>
      )}

      {/* 6 卡：运营队列 + 回款健康度（业务额/利润在仪表盘） */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-3">
        <KpiCard
          title="可开票"
          value={summary?.invoiceableOrderAmount ?? summary?.uninvoicedOrderAmount ?? 0}
          icon={ClipboardList}
          description={`${summary?.invoiceableOrderCount ?? summary?.uninvoicedOrderCount ?? 0} 笔订单剩余可开（分摊额）`}
          variant="warning"
          href="/finance/order-receivables?view=invoiceable"
        />
        <KpiCard
          title="待提交"
          value={summary?.draftInvoiceAmount ?? 0}
          icon={FileText}
          description={`${summary?.draftInvoiceCount ?? 0} 张草稿 · 发票整张金额`}
          variant="warning"
          href="/finance/invoices?tab=draft"
        />
        <KpiCard
          title="待登记"
          value={summary?.requestedInvoiceAmount ?? 0}
          icon={Upload}
          description={`${summary?.requestedInvoiceCount ?? 0} 张待登记 · 发票整张金额`}
          variant="warning"
          href="/finance/invoices?tab=requested"
        />
        <KpiCard
          title="待回款"
          value={summary?.invoicedUnpaidOrderAmount ?? 0}
          icon={AlertCircle}
          description={`${summary?.invoicedUnpaidOrderCount ?? 0} 笔订单 · 相对已登记票`}
          variant={(summary?.invoicedUnpaidOrderAmount ?? 0) > 0 ? "warning" : "default"}
          href="/finance/order-receivables?view=invoiced_unpaid"
        />
        <KpiCard
          title="已结清"
          value={summary?.settledOrderAmount ?? 0}
          icon={Banknote}
          description={
            `${summary?.settledOrderCount ?? 0} 笔结清` +
            (totalReceipt > 0
              ? ` · 累计回款 ¥${(totalReceipt / 10000).toFixed(1)} 万`
              : "")
          }
          variant="success"
          href="/finance/order-receivables?view=paid&expand=first&dimension=receipts"
        />
        <KpiCard
          title="回款健康度"
          value={
            summary?.rollingReceiptRate != null
              ? `${(summary.rollingReceiptRate * 100).toFixed(1)}%`
              : "—"
          }
          icon={Timer}
          description={
            [
              summary?.avgCollectionCycleDays != null
                ? `平均周期 ${summary.avgCollectionCycleDays} 天`
                : "周期样本不足",
              `${summary?.collectionPairCount ?? 0} 笔配对`,
              "按可见客户与独立订单",
            ].join(" · ")
          }
          variant={
            summary?.rollingReceiptRate == null
              ? "muted"
              : summary.rollingReceiptRate < 0.5
                ? "warning"
                : "success"
          }
          href={isAdmin ? "/finance/organizations" : "/finance/order-receivables"}
        />
      </div>

      <p className="text-xs text-muted-foreground -mt-2">
        流程队列可重叠：订单队列按分摊额，发票队列按整张票金额；合票时两轴数字不必守恒。
      </p>

      {/* 待登记开票工作框 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
          <div className="space-y-0.5">
            <CardTitle className="text-base">待登记</CardTitle>
            <p className="text-xs text-muted-foreground">
              已提交申请、等待上传真实发票并登记（按发票整张金额）
            </p>
          </div>
          <Link
            href="/finance/invoices?tab=requested"
            className="inline-flex items-center justify-center gap-1 rounded-md border border-input bg-background px-3 h-8 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
          >
            查看全部
            {requestedTotal > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5">
                {requestedTotal}
              </Badge>
            )}
            <ChevronRight className="h-3.5 w-3.5 ml-0.5" />
          </Link>
        </CardHeader>
        <CardContent className="pt-0">
          {requestedLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : requestedInvoices.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">暂无待登记申请</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {requestedInvoices.map((inv) => (
                <div
                  key={inv.id}
                  className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-3 py-2.5 text-sm"
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="font-medium truncate">
                      {inv.buyerOrganizationName || "未填写购方单位"}
                    </div>
                    <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
                      <span>订单 {invoiceOrderNo(inv)}</span>
                      <span>
                        {inv.invoiceType === "SPECIAL" ? "专票" : "普票"}
                      </span>
                      <span>
                        {new Date(inv.createdAt).toLocaleDateString("zh-CN")} 申请
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <MoneyText value={inv.totalAmount} compact className="font-medium" />
                    {isAdmin && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => setIssueInvoiceId(inv.id)}
                      >
                        <Upload className="h-3 w-3 mr-1" />
                        登记已开票
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Main entries */}
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">功能入口</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <ActionCard
            action={{
              label: "应收与回款",
              href: "/finance/order-receivables",
              icon: CreditCard,
              description: "订单维度全景：金额、开票、回款、应收",
            }}
          />
          <ActionCard
            action={{
              label: "客户看板",
              href: "/finance/customers",
              icon: Users,
              description: `${summary?.customerCount ?? 0} 个客户 · 按客户聚合应收`,
            }}
          />
          <ActionCard
            action={{
              label: "应付款",
              href: "/finance/payables",
              icon: Landmark,
              description: "供应商应付明细与付款跟踪",
            }}
          />
          <ActionCard
            action={{
              label: "供应商付款",
              href: "/finance/supplier-payments",
              icon: Truck,
              description: "付款单登记、核销与流水匹配",
            }}
          />
          <ActionCard
            action={{
              label: "银行流水导入",
              href: "/finance/bank-flow-import",
              icon: Upload,
              description: "导入银行流水并匹配回款",
            }}
          />
          <ActionCard
            action={{
              label: "成本",
              href: "/finance/costs",
              icon: Calculator,
              description: "订单成本录入与利润核算",
            }}
          />
        </div>
      </div>

      {/* Query & analysis */}
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">查询与分析</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <ActionCard
            action={{
              label: "进度款明细",
              href: "/finance/progress-receivables",
              icon: Calendar,
              description: (
                <>
                  本周 <MoneyText value={summary?.weekProgressReceivable ?? 0} compact /> · 本月{" "}
                  <MoneyText value={summary?.monthProgressReceivable ?? 0} compact />
                </>
              ),
            }}
          />
          <ActionCard
            action={{
              label: "发票台账",
              href: "/finance/invoices",
              icon: FileSpreadsheet,
              description: "跨订单全局发票视图与状态跟踪",
            }}
          />
          {isAdmin && (
            <ActionCard
              action={{
                label: "机构回款看板",
                href: "/finance/organizations",
                icon: Building2,
                description: "按买方机构聚合回款周期与回款率",
              }}
            />
          )}
          <ActionCard
            action={{
              label: "预存款",
              href: "/finance/advances",
              icon: Wallet,
              description: "客户预存款充值与消费抵扣记录",
            }}
          />
        </div>
      </div>

      {/* Admin config */}
      {isAdmin && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">配置</h2>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <ActionCard
              action={{
                label: "开票主体",
                href: "/admin/billing-profiles",
                icon: Building2,
                description: "管理开票主体信息",
              }}
            />
            <ActionCard
              action={{
                label: "采购渠道",
                href: "/admin/procurement-channels",
                icon: Store,
                description: "管理采购渠道配置",
              }}
            />
          </div>
        </div>
      )}

      {isAdmin && (
        <UploadIssuedInvoiceDialog
          open={!!issueInvoiceId}
          onOpenChange={(v) => { if (!v) setIssueInvoiceId(null); }}
          invoiceId={issueInvoiceId || ""}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ["finance", "requested-invoices-queue"] });
            queryClient.invalidateQueries({ queryKey: ["finance", "summary"] });
            queryClient.invalidateQueries({ queryKey: ["finance", "all-invoices"] });
            setIssueInvoiceId(null);
          }}
        />
      )}
    </PageShell>
  );
}
