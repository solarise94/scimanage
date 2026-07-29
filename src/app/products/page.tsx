"use client";

import { Suspense, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { isInternalStaff } from "@/lib/role-guards";
import {
  PRODUCT_KIND_LABELS,
  PRODUCT_DOMAIN_LABELS,
  PRODUCT_STATUS,
  PRODUCT_STATUS_LABELS,
  PRODUCT_KIND,
  PRODUCT_DOMAIN,
} from "@/lib/products/constants";

interface ProductSkuSummary {
  id: string;
  skuCode: string;
  name: string;
  status: string;
  sellable: boolean;
  purchasable: boolean;
}
interface ProductItem {
  id: string;
  productCode: string;
  name: string;
  kind: string;
  domain: string | null;
  status: string;
  description: string | null;
  skus: ProductSkuSummary[];
  _count: { skus: number; aliases: number };
}

const STATUS_COLOR: Record<string, string> = {
  [PRODUCT_STATUS.DRAFT]: "bg-gray-100 text-gray-700",
  [PRODUCT_STATUS.ACTIVE]: "bg-green-100 text-green-700",
  [PRODUCT_STATUS.RETIRED]: "bg-amber-100 text-amber-700",
  [PRODUCT_STATUS.MERGED]: "bg-purple-100 text-purple-700",
};

export default function ProductsPage() {
  return (
    <Suspense fallback={<PageShell><Skeleton className="h-96" /></PageShell>}>
      <ProductsContent />
    </Suspense>
  );
}

function ProductsContent() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const { data, isLoading } = useQuery<{ items: ProductItem[] }>({
    queryKey: ["products", search, kindFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (kindFilter) params.set("kind", kindFilter);
      const res = await fetch(`/api/products?${params}`);
      if (!res.ok) throw new Error("加载失败");
      return res.json();
    },
    enabled: status === "authenticated",
  });

  if (status === "loading") {
    return <PageShell><Skeleton className="h-96" /></PageShell>;
  }
  if (!session) { router.push("/login"); return null; }
  if (!isInternalStaff(session.user.role)) { router.push("/dashboard"); return null; }

  const canManage = session.user.role === "ADMIN" || session.user.role === "USER";

  const items = data?.items ?? [];

  const columns: DataTableColumn<ProductItem>[] = [
    {
      key: "productCode",
      header: "编号",
      render: (p) => <span className="font-mono text-xs text-muted-foreground">{p.productCode}</span>,
    },
    {
      key: "name",
      header: "产品名称",
      render: (p) => (
        <button
          onClick={() => router.push(`/products/${p.id}`)}
          className="font-medium text-primary hover:underline text-left"
        >
          {p.name}
        </button>
      ),
    },
    {
      key: "kind",
      header: "类型",
      render: (p) => <span className="text-sm">{PRODUCT_KIND_LABELS[p.kind] ?? p.kind}</span>,
    },
    {
      key: "domain",
      header: "业务域",
      render: (p) => (p.domain ? <span className="text-sm">{PRODUCT_DOMAIN_LABELS[p.domain] ?? p.domain}</span> : <span className="text-muted-foreground">—</span>),
    },
    {
      key: "skuCount",
      header: "SKU 数",
      render: (p) => <span className="tabular-nums">{p._count.skus}</span>,
    },
    {
      key: "status",
      header: "状态",
      render: (p) => (
        <Badge variant="secondary" className={STATUS_COLOR[p.status] ?? ""}>
          {PRODUCT_STATUS_LABELS[p.status] ?? p.status}
        </Badge>
      ),
    },
  ];

  return (
    <PageShell>
      <PageHeader
        title="产品与服务目录"
        description="产品（SPU）与 SKU 两级结构，订单、供应链、成本共同依赖的稳定事实源"
        actions={
          canManage ? (
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-1" /> 新建产品
            </Button>
          ) : undefined
        }
      />

      <Card className="p-4 mb-4">
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="搜索产品编号、名称、SKU、别名..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            className="border rounded px-2 py-1.5 text-sm bg-background"
          >
            <option value="">全部类型</option>
            {Object.values(PRODUCT_KIND).map((k) => (
              <option key={k} value={k}>{PRODUCT_KIND_LABELS[k]}</option>
            ))}
          </select>
        </div>
      </Card>

      <Card>
        <DataTable
          data={items}
          columns={columns}
          keyExtractor={(p) => p.id}
          isLoading={isLoading}
          onRowClick={(p: ProductItem) => router.push(`/products/${p.id}`)}
          emptyTitle="暂无产品"
          emptyDescription="点击「新建产品」创建第一个"
        />
      </Card>

      {showCreate && canManage && (
        <CreateProductDialog onClose={() => setShowCreate(false)} />
      )}
    </PageShell>
  );
}

function CreateProductDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<string>(PRODUCT_KIND.SERVICE);
  const [domain, setDomain] = useState<string>("");
  const [description, setDescription] = useState("");
  const [aliases, setAliases] = useState("");
  const [status, setStatus] = useState<string>(PRODUCT_STATUS.DRAFT);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          kind,
          domain: domain || null,
          description: description || null,
          status,
          aliases: aliases.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "创建失败");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>新建产品</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label>产品名称 *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：单细胞 RNA 测序" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>类型</Label>
              <select value={kind} onChange={(e) => setKind(e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm bg-background">
                {Object.values(PRODUCT_KIND).map((k) => (
                  <option key={k} value={k}>{PRODUCT_KIND_LABELS[k]}</option>
                ))}
              </select>
            </div>
            <div>
              <Label>业务域</Label>
              <select value={domain} onChange={(e) => setDomain(e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm bg-background">
                <option value="">（无）</option>
                {PRODUCT_DOMAIN.map((d) => (
                  <option key={d} value={d}>{PRODUCT_DOMAIN_LABELS[d]}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <Label>描述</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="可选" />
          </div>
          <div>
            <Label>别名（逗号或换行分隔）</Label>
            <Input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="如：10x 单细胞, scRNA" />
          </div>
          <div>
            <Label>初始状态</Label>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm bg-background">
              <option value={PRODUCT_STATUS.DRAFT}>草稿（可维护但不能下单）</option>
              <option value={PRODUCT_STATUS.ACTIVE}>有效（可立即用于下单/报价）</option>
            </select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !name.trim()}>
            {mutation.isPending ? "创建中..." : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
