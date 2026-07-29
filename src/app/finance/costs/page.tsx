"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2, Search, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectDisplay,
} from "@/components/ui/select";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable } from "@/components/ui/data-table";
import { MobileCard } from "@/components/ui/mobile-card";
import { MoneyText } from "@/components/ui/money-text";
import { FinanceEmptyState } from "@/components/finance/finance-empty-state";
import { useMediaQuery } from "@/hooks/use-media-query";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

const COST_TYPES = [
  { value: "PROCUREMENT", label: "采购成本" },
  { value: "EXPERIMENT", label: "实验成本" },
  { value: "LABOR", label: "人工成本" },
  { value: "LOGISTICS", label: "物流成本" },
  { value: "PLATFORM", label: "平台成本" },
  { value: "MARKETING", label: "市场获客成本" },
  { value: "ENTERTAINMENT", label: "招待成本" },
  { value: "REFUND", label: "退款/冲减" },
  { value: "OTHER", label: "其他" },
];

interface CostItem {
  id: string;
  amount: number;
  costType: string;
  occurredAt: string;
  remark: string | null;
  customer: { id: string; name: string } | null;
  order: { id: string; orderNo: string } | null;
  project: { id: string; name: string } | null;
}

interface OrderOption {
  id: string;
  orderNo: string;
  profileId?: string | null;
  customer: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
  totalAmount: number;
}

export default function CostsPage() {
  return (
    <Suspense fallback={<PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>}>
      <CostsContent />
    </Suspense>
  );
}

function CostsContent() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const sp = useSearchParams();
  const defaultOrderId = sp.get("orderId") || "";

  if (status === "loading") return <PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>;
  if (!session) { router.push("/login"); return null; }
  if (session.user.role === "REPRESENTATIVE") { router.push("/dashboard"); return null; }

  return (
    <PageShell>
      <PageHeader
        title="成本管理"
        description="订单维度的成本跟踪与记录"
        backHref="/finance"
        backLabel="返回财务"
      />
      <CostForm defaultOrderId={defaultOrderId} />
      <CostList orderId={defaultOrderId} />
    </PageShell>
  );
}

function CostForm({ defaultOrderId }: { defaultOrderId: string }) {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const isAdmin = session?.user?.role === "ADMIN";
  const [amount, setAmount] = useState("");
  const [costType, setCostType] = useState("OTHER");
  const [remark, setRemark] = useState("");
  const [open, setOpen] = useState(false);

  // Order search state
  const [selectedOrder, setSelectedOrder] = useState<OrderOption | null>(null);
  const [orderSearch, setOrderSearch] = useState("");
  const [orderSearchOpen, setOrderSearchOpen] = useState(false);

  // Fetch locked order info when coming from order detail
  const { data: lockedOrder } = useQuery<OrderOption>({
    queryKey: ["order", "mini", defaultOrderId],
    queryFn: async () => {
      const res = await fetch(`/api/orders/${defaultOrderId}`);
      if (!res.ok) throw new Error("Failed to load order");
      const data = await res.json();
      return {
        id: data.order?.id || data.id,
        orderNo: data.order?.orderNo || data.orderNo,
        profileId: data.order?.profileId || data.profileId || null,
        customer: data.order?.customer || data.customer,
        project: data.order?.project || data.project,
        totalAmount: data.order?.totalAmount || data.totalAmount || 0,
      };
    },
    enabled: !!defaultOrderId,
  });

  // Search orders
  const { data: searchResults } = useQuery<{ orders: OrderOption[] }>({
    queryKey: ["orders", "search", orderSearch],
    queryFn: async () => {
      const params = new URLSearchParams({ search: orderSearch, pageSize: "10" });
      const res = await fetch(`/api/orders?${params}`);
      if (!res.ok) return { orders: [] };
      const data = await res.json();
      /* eslint-disable @typescript-eslint/no-explicit-any */
      return {
        orders: (data.orders || []).map((o: any) => ({
          id: o.id as string,
          orderNo: (o.orderNo || o.externalOrderNo) as string,
          profileId: (o.profileId as string | null) ?? null,
          customer: o.customer as { id: string; name: string } | null,
          project: (o.project || (o.projectLinks?.[0]?.project)) as { id: string; name: string } | null,
          totalAmount: (o.totalAmount || o.paidAmount || 0) as number,
        })),
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    },
    enabled: orderSearch.length >= 2 && !defaultOrderId && orderSearchOpen,
  });

  // Use locked order as the effective order when available
  const effectiveOrder = selectedOrder || lockedOrder || null;

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/finance/costs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: Number(amount),
          costType,
          profileId: effectiveOrder?.profileId || null,
          orderId: effectiveOrder?.id || null,
          projectId: effectiveOrder?.project?.id || null,
          remark: remark || null,
        }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "创建失败"); }
      return res.json();
    },
    onSuccess: () => {
      toast.success("成本已记录");
      queryClient.invalidateQueries({ queryKey: ["finance", "costs"] });
      setAmount(""); setRemark(""); setCostType("OTHER");
      if (!defaultOrderId) setSelectedOrder(null);
      setOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!isAdmin) return null;
  if (!open) return <Button onClick={() => setOpen(true)}><Plus className="mr-1 h-4 w-4" />新增成本</Button>;

  return (
    <Card className="p-4 space-y-4">
      <h3 className="font-medium">新增成本</h3>

      {/* Order context */}
      {defaultOrderId && effectiveOrder ? (
        <div className="p-3 bg-muted/50 rounded-lg">
          <div className="flex items-center gap-2 text-sm">
            <Package className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{effectiveOrder.orderNo}</span>
            {effectiveOrder.customer && <span className="text-muted-foreground">· {effectiveOrder.customer.name}</span>}
            {effectiveOrder.project && <span className="text-muted-foreground">· {effectiveOrder.project.name}</span>}
            <span className="text-muted-foreground ml-auto">
              <MoneyText value={effectiveOrder.totalAmount} compact />
            </span>
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label>关联订单（可选）</Label>
          <Popover open={orderSearchOpen} onOpenChange={setOrderSearchOpen}>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={orderSearchOpen}
                  className="w-full justify-between h-9 text-sm font-normal"
                >
                  {selectedOrder ? selectedOrder.orderNo : "选择订单…"}
                  <Search className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
                </Button>
              }
            />
            <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
              <Command className="w-full">
                <CommandInput
                  placeholder="搜索订单号…"
                  value={orderSearch}
                  onValueChange={setOrderSearch}
                />
                <CommandList>
                  <CommandEmpty className="py-3 text-xs">{orderSearch.length < 2 ? "输入至少 2 个字符" : "未找到匹配的订单"}</CommandEmpty>
                  <CommandGroup>
                    {(searchResults?.orders || []).map((o) => (
                      <CommandItem
                        key={o.id}
                        value={o.orderNo}
                        onSelect={() => { setSelectedOrder(o); setOrderSearch(o.orderNo); setOrderSearchOpen(false); }}
                        className="text-sm"
                      >
                        <span className="flex-1 truncate">{o.orderNo} {o.customer && <span className="text-muted-foreground">· {o.customer.name}</span>}</span>
                        <MoneyText value={o.totalAmount} compact />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          {selectedOrder && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>已选：{selectedOrder.orderNo}</span>
              {selectedOrder.customer && <span>· {selectedOrder.customer.name}</span>}
              {selectedOrder.project && <span>· {selectedOrder.project.name}</span>}
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setSelectedOrder(null); setOrderSearch(""); }}>清除</Button>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>金额 *</Label>
          <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
        </div>
        <div className="space-y-1.5">
          <Label>类型</Label>
          <Select value={costType} onValueChange={(v) => { if (v) setCostType(v); }}>
            <SelectTrigger className="h-9"><SelectDisplay label="选择类型" valueLabel={COST_TYPES.find(c => c.value === costType)?.label} /></SelectTrigger>
            <SelectContent>{COST_TYPES.map(c => (<SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
            ))}</SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>备注</Label>
        <Input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="可选" />
      </div>
      <div className="flex gap-2">
        <Button size="sm" className="h-9" onClick={() => createMutation.mutate()} disabled={createMutation.isPending || !amount}>{createMutation.isPending ? "创建中..." : "保存"}</Button>
        <Button size="sm" variant="outline" className="h-9" onClick={() => setOpen(false)}>取消</Button>
      </div>
    </Card>
  );
}

function CostList({ orderId }: { orderId?: string }) {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const { confirm } = useConfirm();
  const [page, setPage] = useState(1);
  const isMobile = useMediaQuery("(max-width: 767px)");

  const sp = new URLSearchParams();
  sp.set("page", String(page));
  sp.set("pageSize", "20");
  if (orderId) sp.set("orderId", orderId);

  const { data, isLoading } = useQuery<{ costs: CostItem[]; total: number; totalPages: number }>({
    queryKey: ["finance", "costs", page, orderId],
    queryFn: () => fetch(`/api/finance/costs?${sp.toString()}`).then(r => r.json()),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => fetch(`/api/finance/costs/${id}`, { method: "DELETE" }),
    onSuccess: () => { toast.success("已删除"); queryClient.invalidateQueries({ queryKey: ["finance", "costs"] }); },
  });

  const costs = data?.costs || [];

  if (isLoading) return <div className="text-center py-8"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></div>;

  if (costs.length === 0) {
    return (
      <FinanceEmptyState
        title="暂无成本记录"
        description="点击上方按钮新增成本。建议优先关联订单。"
      />
    );
  }

  return (
    <>
      {isMobile ? (
        <div className="md:hidden space-y-3">
          {costs.map((c) => (
            <MobileCard
              key={c.id}
              title={
                <MoneyText value={c.amount} tone="expense" />
              }
              badge={<Badge variant="outline">{COST_TYPES.find(t => t.value === c.costType)?.label || c.costType}</Badge>}
              subtitle={
                <div className="space-y-0.5">
                  {c.order && <p>订单：{c.order.orderNo}</p>}
                  {c.customer && <p>客户：{c.customer.name}</p>}
                  <p>{c.occurredAt?.slice(0, 10)}</p>
                </div>
              }
              metrics={[
                { label: "类型", value: COST_TYPES.find(t => t.value === c.costType)?.label || c.costType },
                { label: "日期", value: c.occurredAt?.slice(0, 10) || "-" },
              ]}
              moreActions={
                session?.user?.role === "ADMIN"
                  ? [{
                      label: "删除",
                      onClick: async () => {
                        const ok = await confirm({ title: "删除成本", description: "删除此成本记录？", variant: "destructive" });
                        if (ok) deleteMutation.mutate(c.id);
                      },
                      destructive: true,
                    }]
                  : undefined
              }
            />
          ))}
        </div>
      ) : (
        <DataTable
          columns={[
            { key: "occurredAt", header: "日期", sortable: true, sortValue: (c) => c.occurredAt || "", render: (c) => c.occurredAt?.slice(0, 10) || "-" },
            { key: "costType", header: "类型", sortable: true, sortValue: (c) => c.costType, render: (c) => <Badge variant="outline">{COST_TYPES.find(t => t.value === c.costType)?.label || c.costType}</Badge> },
            { key: "order", header: "订单", sortable: true, sortValue: (c) => c.order?.orderNo || "", render: (c) => c.order?.orderNo || "-" },
            { key: "customer", header: "客户", sortable: true, sortValue: (c) => c.customer?.name || "", render: (c) => c.customer?.name || "-" },
            { key: "amount", header: "金额", align: "right", sortable: true, sortValue: (c) => c.amount, render: (c) => <MoneyText value={c.amount} tone="expense" /> },
            { key: "remark", header: "备注", render: (c) => c.remark || "-" },
            {
              key: "actions",
              header: "操作",
              align: "center",
              render: (c) => session?.user?.role === "ADMIN" ? (
                <Button variant="ghost" size="sm" onClick={async () => {
                  const ok = await confirm({ title: "删除成本", description: "删除此成本记录？", variant: "destructive" });
                  if (ok) deleteMutation.mutate(c.id);
                }}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              ) : null,
            },
          ]}
          data={costs}
          keyExtractor={(c) => c.id}
        />
      )}

      {(data?.totalPages ?? 0) > 1 && (
        <div className="flex justify-center gap-2 pt-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button>
          <span className="text-sm py-2">{page}/{data?.totalPages}</span>
          <Button variant="outline" size="sm" disabled={page >= (data?.totalPages ?? 0)} onClick={() => setPage(page + 1)}>下一页</Button>
        </div>
      )}
    </>
  );
}