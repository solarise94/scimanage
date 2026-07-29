"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Search, Loader2, UserPlus, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OrganizationSelect } from "@/components/organization-select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/confirm-dialog";

interface Customer {
  id: string;
  name: string;
  customerCode: string;
  organization: string | null;
  principal: string | null;
  wechat: string | null;
  address: string | null;
  representativeName?: string | null;
}

interface OrderPrefill {
  receiverName: string | null;
  receiverPhone: string | null;
  orderUser: string | null;
  receiverAddress: string | null;
  storeName?: string | null;
}

interface CustomerMatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string;
  userId?: string;
  orderPrefill?: OrderPrefill;
  onBound: () => void;
}

function extractOrgFromAddress(address: string | null): string {
  if (!address) return "";
  const patterns = [
    /([^\s,，]+大学)/, /([^\s,，]+研究所)/, /([^\s,，]+医院)/, /([^\s,，]+公司)/,
  ];
  for (const p of patterns) {
    const m = address.match(p);
    if (m) return m[1];
  }
  return "";
}

export function CustomerMatchDialog({ open, onOpenChange, orderId, userId, orderPrefill, onBound }: CustomerMatchDialogProps) {
  const queryClient = useQueryClient();
  const { confirm } = useConfirm();
  const [activeTab, setActiveTab] = useState("existing");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [binding, setBinding] = useState(false);
  const [autoMatching, setAutoMatching] = useState(false);

  // New customer form
  const [custName, setCustName] = useState("");
  const [custPrincipal, setCustPrincipal] = useState("");
  const [custWechat, setCustWechat] = useState("");
  const [custAddress, setCustAddress] = useState("");
  const [custOrg, setCustOrg] = useState("");
  const [custOrgId, setCustOrgId] = useState("");
  // Prefill/reset on open change
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (open && orderPrefill) {
        setCustName(orderPrefill.receiverName || "");
        setCustPrincipal(orderPrefill.receiverPhone || "");
        setCustWechat(orderPrefill.orderUser || "");
        setCustAddress(orderPrefill.receiverAddress || "");
        setCustOrg(orderPrefill.storeName || extractOrgFromAddress(orderPrefill.receiverAddress));
        setCustOrgId("");
        setSearch(orderPrefill.receiverName || orderPrefill.storeName || "");
      } else if (!open) {
        setCustName("");
        setCustPrincipal("");
        setCustWechat("");
        setCustAddress("");
        setCustOrg("");
        setCustOrgId("");
        setSearch("");
        setSelectedId(null);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, orderPrefill]);

  const { data, isLoading } = useQuery<{ customers: Customer[] }>({
    queryKey: ["customers", "search", search],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      params.set("pageSize", "20");
      const res = await fetch(`/api/customers?${params}`, { headers: { "x-customer-api-caller": "finance-match-dialog" } });
      if (!res.ok) throw new Error("Failed to fetch customers");
      return res.json();
    },
    enabled: open && activeTab === "existing",
  });

  const createMutation = useMutation({
    mutationFn: async (formData: Record<string, string>) => {
      const res = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-customer-api-caller": "finance-match-dialog" },
        body: JSON.stringify(formData),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "创建客户失败");
      }
      return res.json();
    },
  });

  async function handleBind() {
    if (!selectedId) return;
    setBinding(true);
    try {
      const res = await fetch(`/api/orders/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileId: selectedId,
          customerMatchStatus: "MANUAL_MATCHED",
          customerMatchScore: null,
          customerMatchReason: `manual_bind_by_${userId || "unknown"}`,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "绑定失败");
      }
      toast.success("客户绑定成功");
      onBound();
      onOpenChange(false);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "绑定失败");
    } finally {
      setBinding(false);
    }
  }

  async function handleAutoMatchScan() {
    setAutoMatching(true);
    try {
      const res = await fetch("/api/finance/pingoodmice/match-scan?source=ALL", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds: [orderId] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "自动匹配失败");
      }

      const detail = Array.isArray(data.details) ? data.details[0] : null;
      if ((data.matched || 0) > 0) {
        const matchedName = detail?.matchedCustomerName ? `：${detail.matchedCustomerName}` : "";
        toast.success(`已自动绑定客户${matchedName}`);
        onBound();
        onOpenChange(false);
        return;
      }
      if ((data.conflicted || 0) > 0) {
        toast.warning("找到多个可能客户，请在已有客户中确认绑定");
        onBound();
        return;
      }
      toast.info("没有找到可自动绑定的客户，可手动搜索或新增");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "自动匹配失败");
    } finally {
      setAutoMatching(false);
    }
  }

  async function handleCreateAndBind() {
    if (!custName.trim()) { toast.error("请输入客户名称"); return; }
    setBinding(true);
    try {
      // Check duplicates by name, phone, and wechat in parallel
      const dupSearches: Promise<Response>[] = [
        fetch(`/api/customers?search=${encodeURIComponent(custName.trim())}&pageSize=5`, { headers: { "x-customer-api-caller": "finance-match-dialog" } }),
      ];
      if (custPrincipal.trim()) {
        dupSearches.push(fetch(`/api/customers?search=${encodeURIComponent(custPrincipal.trim())}&pageSize=5`, { headers: { "x-customer-api-caller": "finance-match-dialog" } }));
      }
      if (custWechat.trim()) {
        dupSearches.push(fetch(`/api/customers?search=${encodeURIComponent(custWechat.trim())}&pageSize=5`, { headers: { "x-customer-api-caller": "finance-match-dialog" } }));
      }
      const dupResults = await Promise.all(dupSearches);
      const seen = new Set<string>();
      const allSimilar: Customer[] = [];
      for (const res of dupResults) {
        if (!res.ok) continue;
        const data = await res.json();
        for (const c of (data.customers || [])) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          const nameMatch = custName.trim() && c.name === custName.trim();
          const phoneMatch = custPrincipal.trim() && c.principal === custPrincipal.trim();
          const wechatMatch = custWechat.trim() && c.wechat === custWechat.trim();
          if (nameMatch || phoneMatch || wechatMatch) {
            allSimilar.push(c);
          }
        }
      }
      if (allSimilar.length > 0) {
        const names = allSimilar.map((c: Customer) => `${c.name}(${c.customerCode})`).join(", ");
        const ok = await confirm({
          title: "可能存在重复客户",
          description: `可能存在重复客户：${names}\n\n仍要创建新客户吗？`,
          variant: "destructive",
        });
        if (!ok) {
          setBinding(false);
          return;
        }
      }

      const newCust = await createMutation.mutateAsync({
        name: custName.trim(),
        principal: custPrincipal.trim() || undefined,
        wechat: custWechat.trim() || undefined,
        address: custAddress.trim() || undefined,
        organization: custOrg.trim() || undefined,
        organizationId: custOrgId || undefined,
        organizationRawInput: custOrg.trim() || custAddress.trim() || undefined,
      } as unknown as Record<string, string>);

      const createdCustomer = newCust?.customer;
      if (createdCustomer?.id) {
        const res = await fetch(`/api/orders/${orderId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profileId: createdCustomer.id,
            customerMatchStatus: "MANUAL_MATCHED",
            customerMatchScore: null,
            customerMatchReason: `manual_bind_by_${userId || "unknown"}`,
          }),
        });
        if (!res.ok) throw new Error("绑定失败");
        toast.success("客户创建并绑定成功");
        queryClient.invalidateQueries({ queryKey: ["customers"] });
        onBound();
        onOpenChange(false);
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBinding(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-1rem)] max-w-md overflow-x-hidden p-4 sm:w-full sm:max-w-md">
        <DialogHeader>
          <DialogTitle>绑定客户</DialogTitle>
        </DialogHeader>

        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={handleAutoMatchScan}
          disabled={autoMatching || binding}
        >
          {autoMatching ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <ScanSearch className="h-4 w-4 mr-1" />}
          按订单快照自动匹配
        </Button>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="w-full">
            <TabsTrigger value="existing">已有客户</TabsTrigger>
            <TabsTrigger value="new">新增并绑定</TabsTrigger>
          </TabsList>

          <TabsContent value="existing" className="space-y-4 mt-4">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input placeholder="搜索客户名称或编号..." className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            {isLoading ? (
              <div className="flex justify-center py-4"><Loader2 className="h-6 w-6 animate-spin" /></div>
            ) : (
              <div className="max-h-64 overflow-y-auto space-y-1 min-w-0">
                {(data?.customers || []).map((cust) => (
                  <button key={cust.id} type="button"
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors min-w-0 ${selectedId === cust.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                    onClick={() => setSelectedId(cust.id)}>
                    <div className="min-w-0">
                      <div className="truncate font-medium">{cust.name} <span className="font-normal opacity-70">({cust.customerCode})</span></div>
                      {cust.organization && <div className="truncate text-xs opacity-70">单位: {cust.organization}</div>}
                      {(cust.principal || cust.wechat) && (
                        <div className="truncate text-xs opacity-70">{[cust.principal && `☎ ${cust.principal}`, cust.wechat && `💬 ${cust.wechat}`].filter(Boolean).join(" / ")}</div>
                      )}
                      {cust.representativeName && (
                        <div className="truncate text-xs text-blue-600">代表: {cust.representativeName}</div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
              <Button onClick={handleBind} disabled={!selectedId || binding}>
                {binding ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}确认绑定
              </Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="new" className="space-y-3 mt-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>客户名称 *</Label>
                <Input value={custName} onChange={(e) => setCustName(e.target.value)} placeholder="收件人姓名" />
              </div>
              <div className="space-y-1.5">
                <Label>手机号</Label>
                <Input value={custPrincipal} onChange={(e) => setCustPrincipal(e.target.value)} placeholder="收件人电话" />
              </div>
              <div className="space-y-1.5">
                <Label>微信号</Label>
                <Input value={custWechat} onChange={(e) => setCustWechat(e.target.value)} placeholder="下单用户" />
              </div>
              <div className="space-y-1.5">
                <Label>单位</Label>
                <OrganizationSelect
                  value={custOrgId}
                  displayValue={custOrg}
                  onChange={(id, name) => {
                    setCustOrgId(id || "");
                    setCustOrg(name || "");
                  }}
                />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label>地址</Label>
                <Input value={custAddress} onChange={(e) => setCustAddress(e.target.value)} placeholder="收件人地址" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
              <Button onClick={handleCreateAndBind} disabled={!custName.trim() || binding}>
                {binding ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                <UserPlus className="h-4 w-4 mr-1" />创建并绑定
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
