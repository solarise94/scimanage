"use client";

import { Suspense, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable } from "@/components/ui/data-table";
import { MobileCard } from "@/components/ui/mobile-card";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { useMediaQuery } from "@/hooks/use-media-query";
import { canAccessSupplyChain } from "@/lib/role-guards";
import { ServiceCatalogFormDialog } from "@/components/supply-chain/service-catalog-form-dialog";
import { SERVICE_DOMAIN_LABELS } from "@/lib/supply-chain/constants";

interface ServiceCatalogItem {
  id: string;
  serviceKey: string;
  name: string;
  category: string;
  domain: string | null;
  aliasesJson: string | null;
  description: string | null;
  active: boolean;
}

const CATEGORY_LABELS: Record<string, { label: string; variant: "default" | "secondary" }> = {
  SERVICE: { label: "服务", variant: "default" },
  PRODUCT: { label: "产品", variant: "secondary" },
  MIXED: { label: "混合", variant: "default" },
  OTHER: { label: "其他", variant: "secondary" },
};

export default function ServiceCatalogPage() {
  return (
    <Suspense
      fallback={
        <PageShell>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64" />
        </PageShell>
      }
    >
      <ServiceCatalogContent />
    </Suspense>
  );
}

function ServiceCatalogContent() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const isAdmin = session?.user?.role === "ADMIN";
  const [editingItem, setEditingItem] = useState<ServiceCatalogItem | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["supply", "service-catalog"],
    queryFn: async () => {
      const res = await fetch(`/api/supply/service-catalog`);
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

  const items: ServiceCatalogItem[] = data?.items ?? [];

  return (
    <PageShell>
      <div className="flex items-center justify-between gap-2">
        <PageHeader
          title="服务项字典"
          description="标准服务项与订单行映射"
          backHref="/supply-chain"
          backLabel="返回供应链"
        />
        {isAdmin && <ServiceCatalogFormDialog />}
      </div>

      {editingItem && (
        <ServiceCatalogFormDialog
          startOpen
          onClose={() => setEditingItem(null)}
          editing={{
            id: editingItem.id,
            serviceKey: editingItem.serviceKey,
            name: editingItem.name,
            category: editingItem.category,
            domain: editingItem.domain,
            aliasesJson: editingItem.aliasesJson,
            description: editingItem.description,
            active: editingItem.active,
          }}
        />
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          暂无服务项
        </Card>
      ) : isDesktop ? (
        <DataTable
          data={items}
          keyExtractor={(it) => it.id}
          onRowClick={(it) => isAdmin && setEditingItem(it)}
          columns={[
            {
              key: "serviceKey",
              header: "服务项 Key",
              render: (it) => <span className="font-mono text-xs">{it.serviceKey}</span>,
            },
            {
              key: "name",
              header: "名称",
              render: (it) => <span className="font-medium text-primary">{it.name}</span>,
            },
            {
              key: "category",
              header: "类别",
              render: (it) => {
                const c = CATEGORY_LABELS[it.category] ?? { label: it.category, variant: "secondary" as const };
                return <Badge variant={c.variant}>{c.label}</Badge>;
              },
            },
            {
              key: "domain",
              header: "业务域",
              render: (it) =>
                it.domain ? <Badge variant="outline">{SERVICE_DOMAIN_LABELS[it.domain] || it.domain}</Badge> : "—",
            },
            {
              key: "active",
              header: "启用",
              render: (it) =>
                it.active ? (
                  <Badge>启用</Badge>
                ) : (
                  <Badge variant="secondary">停用</Badge>
                ),
            },
            {
              key: "description",
              header: "描述",
              render: (it) => it.description || "—",
            },
          ]}
        />
      ) : (
        <div className="space-y-2">
          {items.map((it) => {
            const c = CATEGORY_LABELS[it.category] ?? { label: it.category, variant: "secondary" as const };
            return (
              <MobileCard
                key={it.id}
                title={it.name}
                badge={
                  <div className="flex items-center gap-1">
                    <Badge variant={c.variant}>{c.label}</Badge>
                    {it.active ? <Badge>启用</Badge> : <Badge variant="secondary">停用</Badge>}
                  </div>
                }
                subtitle={it.serviceKey}
                metrics={[
                  { label: "描述", value: it.description || "—" },
                ]}
              />
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
