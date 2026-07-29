"use client";

import { useState, Suspense } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { Search, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable } from "@/components/ui/data-table";
import { MobileCard } from "@/components/ui/mobile-card";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { useMediaQuery } from "@/hooks/use-media-query";
import { canAccessSupplyChain } from "@/lib/role-guards";
import { SupplierFormDialog } from "@/components/supply-chain/supplier-form-dialog";

interface Supplier {
  id: string;
  name: string;
  shortName: string | null;
  status: string;
  category: string | null;
  region: string | null;
  contactName: string | null;
  phone: string | null;
  rating: number | null;
}

const STATUS_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "destructive" }> = {
  ACTIVE: { label: "活跃", variant: "default" },
  PAUSED: { label: "暂停", variant: "secondary" },
  BLACKLISTED: { label: "黑名单", variant: "destructive" },
};

export default function SuppliersPage() {
  return (
    <Suspense
      fallback={
        <PageShell>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64" />
        </PageShell>
      }
    >
      <SuppliersContent />
    </Suspense>
  );
}

function SuppliersContent() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const [search, setSearch] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["supply", "suppliers", search],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      params.set("pageSize", "100");
      const res = await fetch(`/api/supply/suppliers?${params}`);
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

  const suppliers: Supplier[] = data?.suppliers ?? [];

  return (
    <PageShell>
      <PageHeader
        title="供应商管理"
        description="供应商档案、联系人、能力范围"
        backHref="/supply-chain"
        backLabel="返回供应链"
      />

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜索供应商名称、联系人、电话…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        {session.user.role === "ADMIN" && <SupplierFormDialog />}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : suppliers.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          暂无供应商数据
        </Card>
      ) : isDesktop ? (
        <DataTable
          data={suppliers}
          keyExtractor={(s) => s.id}
          onRowClick={(s) => router.push(`/supply-chain/suppliers/${s.id}`)}
          columns={[
            { key: "name", header: "名称", render: (s) => (
              <span className="font-medium text-primary">{s.name}</span>
            ) },
            { key: "status", header: "状态", render: (s) => {
              const st = STATUS_LABELS[s.status] ?? { label: s.status, variant: "secondary" as const };
              return <Badge variant={st.variant}>{st.label}</Badge>;
            } },
            { key: "category", header: "类别", render: (s) => s.category || "—" },
            { key: "contactName", header: "联系人", render: (s) => s.contactName || "—" },
            { key: "phone", header: "电话", render: (s) => s.phone || "—" },
            { key: "rating", header: "评分", render: (s) => s.rating != null ? `${s.rating}★` : "—" },
          ]}
        />
      ) : (
        <div className="space-y-2">
          {suppliers.map((s) => {
            const st = STATUS_LABELS[s.status] ?? { label: s.status, variant: "secondary" as const };
            return (
              <MobileCard
                key={s.id}
                title={s.name}
                badge={<Badge variant={st.variant}>{st.label}</Badge>}
                subtitle={`${s.category || "未分类"} · ${s.contactName || "无联系人"} · ${s.phone || "无电话"}`}
                onClick={() => router.push(`/supply-chain/suppliers/${s.id}`)}
              />
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
