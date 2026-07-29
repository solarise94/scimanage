"use client";

import { useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { isInternalStaff } from "@/lib/role-guards";
import {
  PRODUCT_KIND_LABELS,
  PRODUCT_DOMAIN_LABELS,
  PRODUCT_STATUS,
  PRODUCT_STATUS_LABELS,
  FULFILLMENT_MODE_LABELS,
} from "@/lib/products/constants";
import { centsToYuan } from "@/lib/finance/money";

interface ProductSkuItem {
  id: string;
  skuCode: string;
  name: string;
  spec: string | null;
  standardUnit: string;
  sellable: boolean;
  purchasable: boolean;
  fulfillmentMode: string;
  defaultSalesPrice: number | null;
  status: string;
}
interface ChangeLogItem {
  id: string;
  action: string;
  field: string | null;
  beforeValue: string | null;
  afterValue: string | null;
  note: string | null;
  createdAt: string;
  createdBy: { id: string; name: string | null } | null;
}
interface ProductDetail {
  id: string;
  productCode: string;
  name: string;
  kind: string;
  domain: string | null;
  status: string;
  description: string | null;
  skus: ProductSkuItem[];
  aliases: Array<{ id: string; alias: string; source: string }>;
  changeLogs: ChangeLogItem[];
}

const STATUS_COLOR: Record<string, string> = {
  [PRODUCT_STATUS.DRAFT]: "bg-gray-100 text-gray-700",
  [PRODUCT_STATUS.ACTIVE]: "bg-green-100 text-green-700",
  [PRODUCT_STATUS.RETIRED]: "bg-amber-100 text-amber-700",
  [PRODUCT_STATUS.MERGED]: "bg-purple-100 text-purple-700",
};

type Tab = "info" | "skus" | "aliases" | "changelog";

export default function ProductDetailPage() {
  const params = useParams<{ id: string }>();
  const { data: session, status } = useSession();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("info");
  const [showCreateSku, setShowCreateSku] = useState(false);

  const { data, isLoading } = useQuery<{ product: ProductDetail }>({
    queryKey: ["product", params.id],
    queryFn: async () => {
      const res = await fetch(`/api/products/${params.id}`);
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

  if (isLoading || !data) {
    return <PageShell><Skeleton className="h-96" /></PageShell>;
  }
  const product = data.product;

  const skuColumns: DataTableColumn<ProductSkuItem>[] = [
    { key: "skuCode", header: "货号", render: (s) => <span className="font-mono text-xs">{s.skuCode}</span> },
    { key: "name", header: "规格名称", render: (s) => <span className="font-medium">{s.name}</span> },
    { key: "spec", header: "规格", render: (s) => s.spec ?? <span className="text-muted-foreground">—</span> },
    { key: "unit", header: "单位", render: (s) => <span className="text-sm">{s.standardUnit}</span> },
    {
      key: "price",
      header: "默认售价",
      render: (s) => (s.defaultSalesPrice != null ? `¥${centsToYuan(s.defaultSalesPrice)}` : <span className="text-muted-foreground">—</span>),
    },
    {
      key: "flags",
      header: "可售/可采",
      render: (s) => (
        <div className="flex gap-1">
          {s.sellable && <Badge variant="outline" className="text-xs">可售</Badge>}
          {s.purchasable && <Badge variant="outline" className="text-xs">可采</Badge>}
        </div>
      ),
    },
    {
      key: "status",
      header: "状态",
      render: (s) => <Badge variant="secondary" className={STATUS_COLOR[s.status] ?? ""}>{PRODUCT_STATUS_LABELS[s.status] ?? s.status}</Badge>,
    },
  ];

  const tabs: Array<{ key: Tab; label: string; count?: number }> = [
    { key: "info", label: "基本信息" },
    { key: "skus", label: "SKU/货号", count: product.skus.length },
    { key: "aliases", label: "别名", count: product.aliases.length },
    { key: "changelog", label: "变更日志", count: product.changeLogs.length },
  ];

  return (
    <PageShell>
      <Button variant="ghost" size="sm" onClick={() => router.push("/products")} className="mb-2 -ml-2">
        <ArrowLeft className="h-4 w-4 mr-1" /> 返回目录
      </Button>
      <PageHeader
        title={product.name}
        description={`${product.productCode} · ${PRODUCT_KIND_LABELS[product.kind] ?? product.kind}${product.domain ? " · " + (PRODUCT_DOMAIN_LABELS[product.domain] ?? product.domain) : ""}`}
        actions={
          canManage && tab === "skus" ? (
            <Button onClick={() => setShowCreateSku(true)}>
              <Plus className="h-4 w-4 mr-1" /> 新建 SKU
            </Button>
          ) : undefined
        }
      />

      <div className="flex gap-1 border-b mb-4 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm whitespace-nowrap border-b-2 transition-colors ${
              tab === t.key
                ? "border-primary text-primary font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
            {t.count != null && <span className="ml-1 text-xs text-muted-foreground">({t.count})</span>}
          </button>
        ))}
      </div>

      {tab === "info" && <InfoTab product={product} canManage={canManage} />}
      {tab === "skus" && (
        <Card>
          <DataTable
            data={product.skus}
            columns={skuColumns}
            keyExtractor={(s) => s.id}
            emptyTitle="暂无 SKU"
            emptyDescription="点击「新建 SKU」添加"
          />
        </Card>
      )}
      {tab === "aliases" && (
        <Card className="p-4">
          {product.aliases.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无别名</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {product.aliases.map((a) => (
                <Badge key={a.id} variant="secondary">{a.alias}<span className="ml-1 text-xs opacity-60">{a.source}</span></Badge>
              ))}
            </div>
          )}
        </Card>
      )}
      {tab === "changelog" && <ChangeLogTab logs={product.changeLogs} />}

      {showCreateSku && canManage && (
        <CreateSkuDialog productId={product.id} onClose={() => setShowCreateSku(false)} />
      )}
    </PageShell>
  );
}

function InfoTab({ product, canManage }: { product: ProductDetail; canManage: boolean }) {
  return (
    <Card className="p-4 space-y-3">
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div><span className="text-muted-foreground">编号：</span><span className="font-mono">{product.productCode}</span></div>
        <div><span className="text-muted-foreground">状态：</span><Badge variant="secondary" className={STATUS_COLOR[product.status] ?? ""}>{PRODUCT_STATUS_LABELS[product.status] ?? product.status}</Badge></div>
        <div><span className="text-muted-foreground">类型：</span>{PRODUCT_KIND_LABELS[product.kind] ?? product.kind}</div>
        <div><span className="text-muted-foreground">业务域：</span>{product.domain ? (PRODUCT_DOMAIN_LABELS[product.domain] ?? product.domain) : "—"}</div>
      </div>
      {product.description && (
        <div className="text-sm border-t pt-3">
          <span className="text-muted-foreground">描述：</span>{product.description}
        </div>
      )}
      {!canManage && (
        <p className="text-xs text-muted-foreground border-t pt-2">仅管理员可编辑产品信息。</p>
      )}
    </Card>
  );
}

function ChangeLogTab({ logs }: { logs: ChangeLogItem[] }) {
  if (logs.length === 0) return <Card className="p-4"><p className="text-sm text-muted-foreground">暂无变更记录</p></Card>;
  return (
    <Card className="p-4">
      <div className="space-y-2">
        {logs.map((log) => (
          <div key={log.id} className="text-sm border-b last:border-0 pb-2 last:pb-0">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">{log.action}</Badge>
              <span className="text-xs text-muted-foreground">{new Date(log.createdAt).toLocaleString()}</span>
              {log.createdBy?.name && <span className="text-xs text-muted-foreground">· {log.createdBy.name}</span>}
            </div>
            {(log.field || log.beforeValue || log.afterValue) && (
              <div className="mt-1 text-xs text-muted-foreground ml-1">
                {log.field && <span>{log.field}: </span>}
                {log.beforeValue && <span className="line-through">{log.beforeValue}</span>}
                {log.beforeValue && log.afterValue && <span> → </span>}
                {log.afterValue && <span className="font-medium text-foreground">{log.afterValue}</span>}
              </div>
            )}
            {log.note && <div className="mt-1 text-xs ml-1">{log.note}</div>}
          </div>
        ))}
      </div>
    </Card>
  );
}

function CreateSkuDialog({ productId, onClose }: { productId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [spec, setSpec] = useState("");
  const [standardUnit, setStandardUnit] = useState("项");
  const [defaultSalesPriceYuan, setDefaultSalesPriceYuan] = useState("");
  const [status, setStatus] = useState<string>(PRODUCT_STATUS.ACTIVE);
  const [sellable, setSellable] = useState(true);
  const [purchasable, setPurchasable] = useState(true);
  const [fulfillmentMode, setFulfillmentMode] = useState("EXTERNAL_OR_INTERNAL");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/products/${productId}/skus`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          spec: spec || null,
          standardUnit,
          sellable,
          purchasable,
          fulfillmentMode,
          defaultSalesPriceYuan: defaultSalesPriceYuan ? Number(defaultSalesPriceYuan) : null,
          status,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "创建失败");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["product", productId] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>新建 SKU</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label>规格名称 *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：10x 3' GEX 3 万 reads/cell" />
          </div>
          <div>
            <Label>规格说明</Label>
            <Input value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="可选" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>标准单位 *</Label>
              <Input value={standardUnit} onChange={(e) => setStandardUnit(e.target.value)} placeholder="如：样本、项" />
            </div>
            <div>
              <Label>默认售价（元）</Label>
              <Input type="number" value={defaultSalesPriceYuan} onChange={(e) => setDefaultSalesPriceYuan(e.target.value)} placeholder="可选" />
            </div>
          </div>
          <div>
            <Label>履约模式</Label>
            <select value={fulfillmentMode} onChange={(e) => setFulfillmentMode(e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm bg-background">
              {Object.entries(FULFILLMENT_MODE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={sellable} onChange={(e) => setSellable(e.target.checked)} />
              可销售
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={purchasable} onChange={(e) => setPurchasable(e.target.checked)} />
              可采购
            </label>
          </div>
          <div>
            <Label>状态</Label>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full border rounded px-2 py-1.5 text-sm bg-background">
              <option value={PRODUCT_STATUS.ACTIVE}>有效（可立即使用）</option>
              <option value={PRODUCT_STATUS.DRAFT}>草稿</option>
            </select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !name.trim() || !standardUnit.trim()}>
            {mutation.isPending ? "创建中..." : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
