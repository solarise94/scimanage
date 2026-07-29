"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { MoneyText } from "@/components/ui/money-text";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";

interface AdvanceRefund {
  id: string;
  amount: number;
  refundedAt: string;
}
interface Advance {
  id: string;
  amount: number;
  advancedAt: string;
  status: string;
  remark: string | null;
  customer: { id: string; name: string } | null;
  order: { id: string; orderNo: string } | null;
  project: { id: string; name: string } | null;
  refunds: AdvanceRefund[];
  createdBy?: { id: string; name: string } | null;
}
interface CustomerLite {
  id: string;
  name: string;
  organization?: string | null;
}

const STATUS_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  HELD: { label: "可用余额", variant: "default" },
  PARTIAL_REFUNDED: { label: "部分消费", variant: "secondary" },
  REFUNDED: { label: "已用完", variant: "outline" },
  WRITTEN_OFF: { label: "已核销", variant: "destructive" },
};

function remaining(a: Advance): number {
  const used = a.refunds.reduce((s, r) => s + r.amount, 0);
  return a.amount - used;
}

export default function AdvancesPage() {
  const router = useRouter();
  const { status, data: session } = useSession();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  // recharge dialog
  const [open, setOpen] = useState(false);
  const [custSearch, setCustSearch] = useState("");
  const [custResults, setCustResults] = useState<CustomerLite[]>([]);
  const [selectedCust, setSelectedCust] = useState<CustomerLite | null>(null);
  const [amount, setAmount] = useState("");
  const [remark, setRemark] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // consume (refund) dialog
  const [consumeAdvance, setConsumeAdvance] = useState<Advance | null>(null);
  const [eligibleReceipts, setEligibleReceipts] = useState<Array<{ id: string; amount: number; receivedAt: string; orderNo?: string | null }>>([]);
  const [selectedReceiptId, setSelectedReceiptId] = useState("");
  const [consumeAmount, setConsumeAmount] = useState("");
  const [consumeRemark, setConsumeRemark] = useState("");

  const isAdmin = session?.user?.role === "ADMIN";
  const canRecharge = isAdmin || session?.user?.role === "USER";

  const { data: advancesData, isLoading: loading } = useQuery<{ advances: Advance[] }>({
    queryKey: ["finance", "advances"],
    queryFn: async () => {
      const res = await fetch("/api/finance/advances?pageSize=100");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "加载失败");
      return data;
    },
    enabled: status === "authenticated",
  });
  const advances: Advance[] = advancesData?.advances || [];

  useEffect(() => {
    const q = custSearch.trim();
    const t = setTimeout(async () => {
      if (!q) { setCustResults([]); return; }
      try {
        const res = await fetch(`/api/customers?search=${encodeURIComponent(q)}&limit=10`, {
          headers: { "x-customer-api-caller": "finance-advances" },
        });
        const data = await res.json();
        setCustResults(data.customers || []);
      } catch { /* ignore */ }
    }, 300);
    return () => clearTimeout(t);
  }, [custSearch]);

  if (status === "loading") return <PageShell><div className="p-8">加载中…</div></PageShell>;
  if (status === "unauthenticated") { router.push("/login"); return null; }

  async function handleRecharge() {
    if (!selectedCust) { setError("请选择客户"); return; }
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { setError("金额必须大于 0"); return; }
    setSubmitting(true); setError(null);
    try {
      const res = await fetch("/api/finance/advances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: selectedCust.id, amount: amt, remark: remark.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "充值失败"); return; }
      setOpen(false);
      setSelectedCust(null); setAmount(""); setRemark(""); setCustSearch("");
      await queryClient.invalidateQueries({ queryKey: ["finance", "advances"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "充值失败");
    } finally { setSubmitting(false); }
  }

  async function openConsume(a: Advance) {
    setConsumeAdvance(a);
    setSelectedReceiptId(""); setConsumeAmount(""); setConsumeRemark(""); setError(null);
    setEligibleReceipts([]);
    try {
      const res = await fetch(`/api/finance/advances/${a.id}/eligible-receipts`);
      const data = await res.json();
      if (res.ok) setEligibleReceipts(data.eligible || []);
    } catch { /* ignore */ }
  }

  async function handleConsume() {
    if (!consumeAdvance) return;
    if (!selectedReceiptId) { setError("请选择对应回款记录"); return; }
    const amt = parseFloat(consumeAmount);
    if (!amt || amt <= 0) { setError("抵扣金额必须大于 0"); return; }
    setSubmitting(true); setError(null);
    try {
      const res = await fetch(`/api/finance/advances/${consumeAdvance.id}/refund`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amt, settledByReceiptId: selectedReceiptId, remark: consumeRemark.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "抵扣失败"); return; }
      setConsumeAdvance(null);
      await queryClient.invalidateQueries({ queryKey: ["finance", "advances"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "抵扣失败");
    } finally { setSubmitting(false); }
  }

  const totalHeld = advances.reduce((s, a) => s + remaining(a), 0);

  const columns: DataTableColumn<Advance>[] = [
    {
      key: "customer",
      header: "客户",
      render: (a) => a.customer?.name || "-",
    },
    { key: "amount", header: "充值金额", align: "right", money: true },
    {
      key: "used",
      header: "已消费",
      align: "right",
      money: true,
      sortValue: (a) => a.refunds.reduce((s, r) => s + r.amount, 0),
      render: (a) => <MoneyText value={a.refunds.reduce((s, r) => s + r.amount, 0)} />,
    },
    {
      key: "remaining",
      header: "可用余额",
      align: "right",
      sortValue: (a) => remaining(a),
      render: (a) => <MoneyText value={remaining(a)} className="font-medium" />,
    },
    {
      key: "status",
      header: "状态",
      render: (a) => {
        const st = STATUS_LABELS[a.status] || { label: a.status, variant: "outline" as const };
        return <Badge variant={st.variant}>{st.label}</Badge>;
      },
    },
    {
      key: "advancedAt",
      header: "充值时间",
      render: (a) => new Date(a.advancedAt).toLocaleDateString("zh-CN"),
    },
    {
      key: "remark",
      header: "备注",
      render: (a) => <span className="text-muted-foreground">{a.remark || "-"}</span>,
    },
    {
      key: "action",
      header: "操作",
      render: (a) =>
        canRecharge && remaining(a) > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => openConsume(a)}>消费抵扣</Button>
        ) : null,
    },
  ];

  return (
    <PageShell className="space-y-4">
      <PageHeader
        title="预存款"
        description="客户预存款充值与消费抵扣（充值后可用于订单交付抵扣）"
        actions={
          canRecharge && (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger render={<Button />}>预存款充值</DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>预存款充值</DialogTitle></DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>客户</Label>
                    {selectedCust ? (
                      <div className="flex items-center justify-between rounded-md border p-2">
                        <span>{selectedCust.name}{selectedCust.organization ? ` · ${selectedCust.organization}` : ""}</span>
                        <Button variant="ghost" size="sm" onClick={() => setSelectedCust(null)}>更换</Button>
                      </div>
                    ) : (
                      <>
                        <Input placeholder="搜索客户姓名…" value={custSearch} onChange={(e) => setCustSearch(e.target.value)} />
                        {custResults.length > 0 && (
                          <div className="max-h-40 overflow-y-auto rounded-md border">
                            {custResults.map((c) => (
                              <button
                                key={c.id}
                                className="block w-full text-left px-3 py-2 hover:bg-muted text-sm"
                                onClick={() => { setSelectedCust(c); setCustResults([]); setCustSearch(""); }}
                              >
                                {c.name}{c.organization ? ` · ${c.organization}` : ""}
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label>充值金额（元）</Label>
                    <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
                  </div>
                  <div className="space-y-2">
                    <Label>备注</Label>
                    <Input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="可选" />
                  </div>
                  {error && <p className="text-sm text-destructive">{error}</p>}
                  <Button onClick={handleRecharge} disabled={submitting} className="w-full">
                    {submitting ? "提交中…" : "确认充值"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          )
        }
      />

      {error && !open && <Card className="p-4 border-destructive text-destructive">{error}</Card>}

      <Card>
        <CardContent className="p-4">
          <p className="text-sm text-muted-foreground">当前可用预存款余额合计</p>
          <p className="text-2xl font-semibold"><MoneyText value={totalHeld} showCurrency /></p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <DataTable
            columns={columns}
            data={advances}
            keyExtractor={(a) => a.id}
            isLoading={loading}
            emptyTitle="暂无预存款记录"
          />
        </CardContent>
      </Card>

      <Dialog open={!!consumeAdvance} onOpenChange={(o) => { if (!o) setConsumeAdvance(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>预存款消费抵扣</DialogTitle></DialogHeader>
          {consumeAdvance && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                客户 {consumeAdvance.customer?.name || "-"} · 可用余额 <MoneyText value={remaining(consumeAdvance)} />
              </p>
              <div className="space-y-2">
                <Label>对应回款记录</Label>
                {eligibleReceipts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">无可用回款记录（需先有同客户/订单/项目的回款）</p>
                ) : (
                  <div className="max-h-40 overflow-y-auto rounded-md border">
                    {eligibleReceipts.map((r) => (
                      <button
                        key={r.id}
                        className={`block w-full text-left px-3 py-2 text-sm hover:bg-muted ${selectedReceiptId === r.id ? "bg-muted" : ""}`}
                        onClick={() => { setSelectedReceiptId(r.id); setConsumeAmount(String(r.amount)); }}
                      >
                        <MoneyText value={r.amount} /> · {new Date(r.receivedAt).toLocaleDateString("zh-CN")}{r.orderNo ? ` · ${r.orderNo}` : ""}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <Label>抵扣金额（元）</Label>
                <Input type="number" min="0" step="0.01" value={consumeAmount} onChange={(e) => setConsumeAmount(e.target.value)} placeholder="0.00" />
              </div>
              <div className="space-y-2">
                <Label>备注</Label>
                <Input value={consumeRemark} onChange={(e) => setConsumeRemark(e.target.value)} placeholder="可选" />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button onClick={handleConsume} disabled={submitting || !selectedReceiptId} className="w-full">
                {submitting ? "提交中…" : "确认抵扣"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
