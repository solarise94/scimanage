"use client";

import { useState, Suspense } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { InquiryFormDialog } from "@/components/supply-chain/inquiry-form-dialog";
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

interface Inquiry {
  id: string;
  occurredAt: string | null;
  requestedItem: string;
  requestedSpec: string | null;
  quantity: number | null;
  targetPrice: number | null;
  responsePrice: number | null;
  finalPrice: number | null;
  respondedLeadDays: number | null;
  responseLeadDays: number | null;
  note: string | null;
  contactMethod: string | null;
  status: string;
  supplier: { id: string; name: string } | null;
  supplierId: string | null;
}

const STATUS_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "destructive" }> = {
  OPEN: { label: "待回复", variant: "default" },
  RESPONDED: { label: "已回复", variant: "default" },
  CLOSED: { label: "已关闭", variant: "secondary" },
  LOST: { label: "已流失", variant: "destructive" },
};

const STATUS_OPTIONS = [
  { value: "OPEN", label: "待回复" },
  { value: "RESPONDED", label: "已回复" },
  { value: "CLOSED", label: "已关闭" },
  { value: "LOST", label: "已流失" },
];

export default function InquiriesPage() {
  return (
    <Suspense
      fallback={
        <PageShell>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64" />
        </PageShell>
      }
    >
      <InquiriesContent />
    </Suspense>
  );
}

function InquiriesContent() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const canEdit = session?.user?.role === "ADMIN" || session?.user?.role === "USER";
  const [supplierId, setSupplierId] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [editingInquiry, setEditingInquiry] = useState<Inquiry | null>(null);

  const params = new URLSearchParams();
  if (supplierId) params.set("supplierId", supplierId);
  if (statusFilter) params.set("status", statusFilter);
  params.set("pageSize", "100");

  const { data, isLoading } = useQuery({
    queryKey: ["supply", "inquiries", supplierId, statusFilter],
    queryFn: async () => {
      const res = await fetch(`/api/supply/inquiries?${params}`);
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

  const inquiries: Inquiry[] = data?.inquiries ?? [];

  return (
    <PageShell>
      <div className="flex items-center justify-between gap-2">
        <PageHeader
          title="询价记录"
          description="供应商询价与价格反馈记录"
          backHref="/supply-chain"
          backLabel="返回供应链"
        />
        {canEdit && <InquiryFormDialog />}
      </div>

      {editingInquiry && (
        <InquiryFormDialog
          startOpen
          onClose={() => setEditingInquiry(null)}
          editing={{
            id: editingInquiry.id,
            supplierId: editingInquiry.supplierId || "",
            supplierName: editingInquiry.supplier?.name,
            requestedItem: editingInquiry.requestedItem,
            status: editingInquiry.status,
            finalPrice: editingInquiry.finalPrice,
            respondedLeadDays: editingInquiry.responseLeadDays,
            note: editingInquiry.note,
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
      ) : inquiries.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          暂无询价记录
        </Card>
      ) : isDesktop ? (
        <DataTable
          data={inquiries}
          keyExtractor={(i) => i.id}
          onRowClick={(i) => canEdit && setEditingInquiry(i)}
          columns={[
            {
              key: "occurredAt",
              header: "询价时间",
              render: (i) => i.occurredAt?.slice(0, 10) || "—",
            },
            {
              key: "supplier",
              header: "供应商",
              render: (i) => i.supplier?.name || "—",
            },
            { key: "requestedItem", header: "询价项目", render: (i) => i.requestedItem },
            {
              key: "targetPrice",
              header: "目标价",
              align: "right",
              render: (i) => (i.targetPrice != null ? <MoneyText value={i.targetPrice} /> : "—"),
            },
            {
              key: "finalPrice",
              header: "成交价",
              align: "right",
              render: (i) => (i.finalPrice != null ? <MoneyText value={i.finalPrice} tone="expense" /> : "—"),
            },
            {
              key: "status",
              header: "状态",
              render: (i) => {
                const st = STATUS_LABELS[i.status] ?? { label: i.status, variant: "secondary" as const };
                return <Badge variant={st.variant}>{st.label}</Badge>;
              },
            },
          ]}
        />
      ) : (
        <div className="space-y-2">
          {inquiries.map((i) => {
            const st = STATUS_LABELS[i.status] ?? { label: i.status, variant: "secondary" as const };
            return (
              <MobileCard
                key={i.id}
                title={i.requestedItem}
                badge={<Badge variant={st.variant}>{st.label}</Badge>}
                subtitle={`${i.supplier?.name || "未知供应商"} · ${i.occurredAt?.slice(0, 10) || "—"}`}
                metrics={[
                  { label: "目标价", value: i.targetPrice != null ? <MoneyText value={i.targetPrice} /> : "—" },
                  { label: "成交价", value: i.finalPrice != null ? <MoneyText value={i.finalPrice} tone="expense" /> : "—" },
                ]}
                onClick={canEdit ? () => setEditingInquiry(i) : undefined}
              />
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
