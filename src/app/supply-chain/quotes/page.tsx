"use client";

import { useState, Suspense } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { QuoteFormDialog } from "@/components/supply-chain/quote-form-dialog";
import {
  Select,
  SelectContent,
  SelectDisplay,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable } from "@/components/ui/data-table";
import { MobileCard } from "@/components/ui/mobile-card";
import { MoneyText } from "@/components/ui/money-text";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { useMediaQuery } from "@/hooks/use-media-query";
import { canAccessSupplyChain } from "@/lib/role-guards";

interface Quote {
  id: string;
  productSkuId: string | null;
  supplierSkuCode: string | null;
  productSku: {
    id: string; skuCode: string; name: string; status: string;
    product: { id: string; productCode: string; name: string };
  } | null;
  serviceKey: string | null;
  itemName: string;
  spec: string | null;
  unit: string | null;
  listPrice: number;
  quotedPrice: number;
  negotiatedPrice: number | null;
  floorPriceHint: number | null;
  discountRate: number | null;
  leadDays: number | null;
  validFrom: string | null;
  validTo: string | null;
  updateCycleDays: number | null;
  status: string;
  remark: string | null;
  supplier: { id: string; name: string; shortName: string | null; status: string } | null;
}

const STATUS_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "destructive" }> = {
  ACTIVE: { label: "有效", variant: "default" },
  EXPIRED: { label: "已过期", variant: "secondary" },
  ARCHIVED: { label: "已归档", variant: "destructive" },
};

const STATUS_OPTIONS = [
  { value: "ACTIVE", label: "有效" },
  { value: "EXPIRED", label: "已过期" },
  { value: "ARCHIVED", label: "已归档" },
];

export default function QuotesPage() {
  return (
    <Suspense
      fallback={
        <PageShell>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64" />
        </PageShell>
      }
    >
      <QuotesContent />
    </Suspense>
  );
}

function QuotesContent() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const isAdmin = session?.user?.role === "ADMIN";
  const [supplierId, setSupplierId] = useState("");
  const [serviceKey, setServiceKey] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [editingQuote, setEditingQuote] = useState<Quote | null>(null);

  const params = new URLSearchParams();
  if (supplierId) params.set("supplierId", supplierId);
  if (serviceKey) params.set("serviceKey", serviceKey);
  if (statusFilter) params.set("status", statusFilter);
  params.set("pageSize", "100");

  const { data, isLoading } = useQuery({
    queryKey: ["supply", "quotes", supplierId, serviceKey, statusFilter],
    queryFn: async () => {
      const res = await fetch(`/api/supply/quotes?${params}`);
      if (!res.ok) throw new Error("加载失败");
      return res.json();
    },
    enabled: status === "authenticated",
  });

  if (status === "loading") {
    return (
      <PageShell>
        <Skeleton className="h-8 w-48" />
      </PageShell>
    );
  }
  if (!session) {
    router.push("/login");
    return null;
  }
  if (!canAccessSupplyChain(session.user.role)) {
    router.push("/dashboard");
    return null;
  }

  const quotes: Quote[] = data?.quotes ?? [];

  return (
    <PageShell>
      <div className="flex items-center justify-between gap-2">
        <PageHeader
          title="报价表"
          description="供应商报价维护与导入"
          backHref="/supply-chain"
          backLabel="返回供应链"
        />
        {isAdmin && <QuoteFormDialog />}
      </div>

      {editingQuote && (
        <QuoteFormDialog
          startOpen
          onClose={() => setEditingQuote(null)}
          editing={{
            id: editingQuote.id,
            supplierId: editingQuote.supplier?.id || "",
            supplierName: editingQuote.supplier?.name,
            productSkuId: editingQuote.productSkuId,
            skuDisplay: editingQuote.productSku
              ? `${editingQuote.productSku.product.productCode} / ${editingQuote.productSku.skuCode} · ${editingQuote.productSku.name}`
              : editingQuote.serviceKey ?? null,
            serviceKey: editingQuote.serviceKey,
            itemName: editingQuote.itemName,
            spec: editingQuote.spec,
            unit: editingQuote.unit,
            listPrice: editingQuote.listPrice,
            quotedPrice: editingQuote.quotedPrice,
            negotiatedPrice: editingQuote.negotiatedPrice,
            floorPriceHint: editingQuote.floorPriceHint,
            leadDays: editingQuote.leadDays,
            validFrom: editingQuote.validFrom,
            validTo: editingQuote.validTo,
            updateCycleDays: editingQuote.updateCycleDays,
            status: editingQuote.status,
            remark: editingQuote.remark,
          }}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="供应商 ID"
          value={supplierId}
          onChange={(e) => setSupplierId(e.target.value)}
          className="h-9 w-[160px] rounded-md border border-input bg-background px-3 text-sm"
        />
        <input
          type="text"
          placeholder="服务项 Key"
          value={serviceKey}
          onChange={(e) => setServiceKey(e.target.value)}
          className="h-9 w-[160px] rounded-md border border-input bg-background px-3 text-sm"
        />
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v ?? ""); }}>
          <SelectTrigger className="w-[140px]">
            <SelectDisplay
              label="状态"
              valueLabel={statusFilter ? STATUS_LABELS[statusFilter]?.label : "全部"}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">全部</SelectItem>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : quotes.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          暂无报价数据
        </Card>
      ) : isDesktop ? (
        <DataTable
          data={quotes}
          keyExtractor={(q) => q.id}
          onRowClick={(q) => isAdmin && setEditingQuote(q)}
          columns={[
            {
              key: "supplier",
              header: "供应商",
              render: (q) => q.supplier?.name || "—",
            },
            {
              key: "productSku",
              header: "产品 SKU",
              render: (q) => q.productSku
                ? <span className="font-mono text-xs">{q.productSku.skuCode} · {q.productSku.name}</span>
                : <span className="text-muted-foreground text-xs">{q.serviceKey ?? "（未绑定）"}</span>,
            },
            { key: "itemName", header: "项目名", render: (q) => q.itemName },
            {
              key: "listPrice",
              header: "目录价",
              align: "right",
              render: (q) => <MoneyText value={q.listPrice} />,
            },
            {
              key: "quotedPrice",
              header: "报价",
              align: "right",
              render: (q) => <MoneyText value={q.quotedPrice} tone="expense" />,
            },
            {
              key: "status",
              header: "状态",
              render: (q) => {
                const st = STATUS_LABELS[q.status] ?? { label: q.status, variant: "secondary" as const };
                return <Badge variant={st.variant}>{st.label}</Badge>;
              },
            },
            {
              key: "validTo",
              header: "有效期至",
              render: (q) => q.validTo?.slice(0, 10) || "—",
            },
          ]}
        />
      ) : (
        <div className="space-y-2">
          {quotes.map((q) => {
            const st = STATUS_LABELS[q.status] ?? { label: q.status, variant: "secondary" as const };
            return (
              <MobileCard
                key={q.id}
                title={q.itemName}
                badge={<Badge variant={st.variant}>{st.label}</Badge>}
                subtitle={`${q.supplier?.name || "未知供应商"} · ${q.productSku ? q.productSku.skuCode : q.serviceKey ?? "（未绑定）"}`}
                metrics={[
                  { label: "目录价", value: <MoneyText value={q.listPrice} /> },
                  { label: "报价", value: <MoneyText value={q.quotedPrice} tone="expense" /> },
                ]}
                onClick={isAdmin ? () => setEditingQuote(q) : undefined}
              />
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
