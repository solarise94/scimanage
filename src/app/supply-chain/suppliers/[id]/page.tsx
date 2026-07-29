"use client";

import { Suspense, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2, Pencil, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { canAccessSupplyChain } from "@/lib/role-guards";
import { SupplierFormDialog } from "@/components/supply-chain/supplier-form-dialog";

interface SupplierContact {
  id: string;
  supplierId: string;
  name: string;
  role: string | null;
  phone: string | null;
  email: string | null;
  wechat: string | null;
  qq: string | null;
  isPrimary: boolean;
  active: boolean;
  note: string | null;
}

interface SupplierCapability {
  id: string;
  supplierId: string;
  serviceKey: string;
  itemName: string;
  spec: string | null;
  active: boolean;
}

interface ServiceCatalogItem {
  id: string;
  serviceKey: string;
  name: string;
  active: boolean;
}

export default function SupplierDetailPage() {
  return (
    <Suspense
      fallback={
        <PageShell>
          <Skeleton className="h-8 w-48" />
        </PageShell>
      }
    >
      <SupplierDetailContent />
    </Suspense>
  );
}

function SupplierDetailContent() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const params = useParams();
  const supplierId = params.id as string;
  const queryClient = useQueryClient();

  const isAdmin = session?.user?.role === "ADMIN";

  const { data, isLoading } = useQuery({
    queryKey: ["supply-supplier-detail", supplierId],
    queryFn: async () => {
      const res = await fetch(`/api/supply/suppliers/${supplierId}`);
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

  if (isLoading) {
    return (
      <PageShell>
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </PageShell>
    );
  }

  const supplier = data?.supplier;
  if (!supplier) {
    return (
      <PageShell>
        <Card className="p-8 text-center text-sm text-muted-foreground">供应商不存在</Card>
      </PageShell>
    );
  }

  const contacts: SupplierContact[] = supplier.contacts ?? [];
  const capabilities: SupplierCapability[] = supplier.capabilities ?? [];

  return (
    <PageShell>
      <div className="flex items-center justify-between gap-2">
        <PageHeader
          title={supplier.name}
          description={`${supplier.category || "未分类"} · ${supplier.region || "未知地区"}`}
          backHref="/supply-chain/suppliers"
          backLabel="返回供应商列表"
        />
        {isAdmin && (
          <SupplierFormDialog
            hasPrimaryContact={contacts.some((c) => c.isPrimary)}
            editing={{
              id: supplier.id,
              name: supplier.name,
              shortName: supplier.shortName,
              status: supplier.status,
              category: supplier.category,
              region: supplier.region,
              contactName: supplier.contactName,
              phone: supplier.phone,
              email: supplier.email,
              wechat: supplier.wechat,
              address: supplier.address,
              paymentCycle: supplier.paymentCycle,
              defaultLeadDays: supplier.defaultLeadDays,
              quoteUpdateCycleDays: supplier.quoteUpdateCycleDays,
              rating: supplier.rating,
              qualityScore: supplier.qualityScore,
              deliveryScore: supplier.deliveryScore,
              priceScore: supplier.priceScore,
              preferenceNote: supplier.preferenceNote,
              riskNote: supplier.riskNote,
            }}
          />
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-medium">基础信息</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">状态</dt>
              <dd><Badge variant={supplier.status === "ACTIVE" ? "default" : "secondary"}>{supplier.status}</Badge></dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">简称</dt>
              <dd>{supplier.shortName || "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">联系人</dt>
              <dd>{supplier.contactName || "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">电话</dt>
              <dd>{supplier.phone || "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">邮箱</dt>
              <dd>{supplier.email || "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">地址</dt>
              <dd>{supplier.address || "—"}</dd>
            </div>
          </dl>
        </Card>

        <Card className="p-4">
          <h3 className="mb-3 text-sm font-medium">商务信息</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">付款周期</dt>
              <dd>{supplier.paymentCycle || "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">默认货期</dt>
              <dd>{supplier.defaultLeadDays != null ? `${supplier.defaultLeadDays} 天` : "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">报价更新周期</dt>
              <dd>{supplier.quoteUpdateCycleDays != null ? `${supplier.quoteUpdateCycleDays} 天` : "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">评分</dt>
              <dd>{supplier.rating != null ? `${supplier.rating}★` : "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">质量分</dt>
              <dd>{supplier.qualityScore != null ? supplier.qualityScore.toFixed(1) : "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">交付分</dt>
              <dd>{supplier.deliveryScore != null ? supplier.deliveryScore.toFixed(1) : "—"}</dd>
            </div>
          </dl>
        </Card>
      </div>

      <ContactsSection supplierId={supplierId} contacts={contacts} isAdmin={isAdmin} queryClient={queryClient} />

      <CapabilitiesSection supplierId={supplierId} capabilities={capabilities} isAdmin={isAdmin} queryClient={queryClient} />
    </PageShell>
  );
}

// ─── 联系人管理 ───────────────────────────────────────────────────
function ContactsSection({
  supplierId,
  contacts,
  isAdmin,
  queryClient,
}: {
  supplierId: string;
  contacts: SupplierContact[];
  isAdmin: boolean;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [showForm, setShowForm] = useState(false);
  const [editingContact, setEditingContact] = useState<SupplierContact | null>(null);
  const [formName, setFormName] = useState("");
  const [formPhone, setFormPhone] = useState("");
  const [formEmail, setFormEmail] = useState("");
  const [formWechat, setFormWechat] = useState("");
  const [formIsPrimary, setFormIsPrimary] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["supply-supplier-detail", supplierId] });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: formName.trim(),
        phone: formPhone.trim() || null,
        email: formEmail.trim() || null,
        wechat: formWechat.trim() || null,
        isPrimary: formIsPrimary,
      };
      if (editingContact) {
        const res = await fetch(`/api/supply/suppliers/${supplierId}/contacts/${editingContact.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const d = await res.json();
          throw new Error(d.error || "更新失败");
        }
        return res.json();
      }
      const res = await fetch(`/api/supply/suppliers/${supplierId}/contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "创建失败");
      }
      return res.json();
    },
    onSuccess: async () => {
      toast.success(editingContact ? "联系人已更新" : "联系人已创建");
      await invalidate();
      resetForm();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (contactId: string) => {
      const res = await fetch(`/api/supply/suppliers/${supplierId}/contacts/${contactId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "删除失败");
      }
      return res.json();
    },
    onSuccess: async () => {
      toast.success("联系人已删除");
      await invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function resetForm() {
    setShowForm(false);
    setEditingContact(null);
    setFormName("");
    setFormPhone("");
    setFormEmail("");
    setFormWechat("");
    setFormIsPrimary(false);
  }

  function openEdit(c: SupplierContact) {
    setEditingContact(c);
    setFormName(c.name);
    setFormPhone(c.phone || "");
    setFormEmail(c.email || "");
    setFormWechat(c.wechat || "");
    setFormIsPrimary(c.isPrimary);
    setShowForm(true);
  }

  function openAdd() {
    resetForm();
    setShowForm(true);
  }

  function handleDelete(c: SupplierContact) {
    if (!window.confirm(`确认删除联系人「${c.name}」？`)) return;
    deleteMutation.mutate(c.id);
  }

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium">联系人</h3>
        {isAdmin && !showForm && (
          <Button size="sm" variant="outline" onClick={openAdd}>
            <Plus className="mr-1 h-4 w-4" />添加
          </Button>
        )}
      </div>

      {showForm && (
        <div className="mb-3 space-y-2 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {editingContact ? "编辑联系人" : "新建联系人"}
            </span>
            <Button size="sm" variant="ghost" onClick={resetForm}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <Input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="姓名 *" />
          <Input value={formPhone} onChange={(e) => setFormPhone(e.target.value)} placeholder="电话" />
          <Input value={formEmail} onChange={(e) => setFormEmail(e.target.value)} placeholder="邮箱" />
          <Input value={formWechat} onChange={(e) => setFormWechat(e.target.value)} placeholder="微信" />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={formIsPrimary}
              onChange={(e) => setFormIsPrimary(e.target.checked)}
              className="rounded"
            />
            <span>设为主联系人</span>
          </label>
          <Button
            size="sm"
            className="w-full"
            disabled={saveMutation.isPending || !formName.trim()}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? "保存中..." : "保存"}
          </Button>
        </div>
      )}

      {contacts.length === 0 && !showForm ? (
        <p className="text-sm text-muted-foreground">暂无联系人</p>
      ) : (
        <div className="space-y-2 text-sm">
          {contacts.map((c) => {
            const contactInfo = [c.phone, c.email, c.wechat].filter(Boolean).join(" · ") || "无联系方式";
            return (
              <div key={c.id} className="flex flex-wrap items-center gap-2 border-b pb-2 last:border-0">
                <span className="font-medium">{c.name}</span>
                {c.role && <Badge variant="outline">{c.role}</Badge>}
                {c.isPrimary ? <Badge>主联系人</Badge> : null}
                <span className="text-muted-foreground">{contactInfo}</span>
                {isAdmin && (
                  <span className="ml-auto flex items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => openEdit(c)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => handleDelete(c)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ─── 能力范围管理 ─────────────────────────────────────────────────
function CapabilitiesSection({
  supplierId,
  capabilities,
  isAdmin,
  queryClient,
}: {
  supplierId: string;
  capabilities: SupplierCapability[];
  isAdmin: boolean;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [showForm, setShowForm] = useState(false);
  const [editingCap, setEditingCap] = useState<SupplierCapability | null>(null);
  const [serviceKey, setServiceKey] = useState("");
  const [itemName, setItemName] = useState("");
  const [spec, setSpec] = useState("");
  const [active, setActive] = useState(true);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["supply-supplier-detail", supplierId] });

  // 拉取服务目录用于 serviceKey 下拉
  const { data: catalogData } = useQuery({
    queryKey: ["supply", "service-catalog"],
    queryFn: async () => {
      const res = await fetch("/api/supply/service-catalog?active=true");
      if (!res.ok) throw new Error("加载服务目录失败");
      return res.json();
    },
    enabled: isAdmin,
  });
  const catalogItems: ServiceCatalogItem[] = catalogData?.items ?? [];

  const isEditing = !!editingCap;

  const createMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        serviceKey,
        itemName: itemName.trim(),
        spec: spec.trim() || null,
        active,
      };
      if (isEditing) {
        const res = await fetch(`/api/supply/suppliers/${supplierId}/capabilities/${editingCap.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const d = await res.json();
          throw new Error(d.error || "更新失败");
        }
        return res.json();
      }
      const res = await fetch(`/api/supply/suppliers/${supplierId}/capabilities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "创建失败");
      }
      return res.json();
    },
    onSuccess: async () => {
      toast.success(isEditing ? "能力已更新" : "能力已添加");
      await invalidate();
      resetForm();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (capabilityId: string) => {
      const res = await fetch(`/api/supply/suppliers/${supplierId}/capabilities/${capabilityId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "删除失败");
      }
      return res.json();
    },
    onSuccess: async () => {
      toast.success("能力已删除");
      await invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function resetForm() {
    setShowForm(false);
    setEditingCap(null);
    setServiceKey("");
    setItemName("");
    setSpec("");
    setActive(true);
  }

  function openAdd() {
    resetForm();
    setShowForm(true);
  }

  function openEdit(cap: SupplierCapability) {
    setEditingCap(cap);
    setServiceKey(cap.serviceKey);
    setItemName(cap.itemName);
    setSpec(cap.spec || "");
    setActive(cap.active);
    setShowForm(true);
  }

  // 选择服务项时自动填充 itemName
  function handleServiceKeyChange(v: string) {
    setServiceKey(v);
    const item = catalogItems.find((i) => i.serviceKey === v);
    if (item && !itemName.trim()) {
      setItemName(item.name);
    }
  }

  function handleDelete(cap: SupplierCapability) {
    if (!window.confirm(`确认删除能力「${cap.itemName}」？`)) return;
    deleteMutation.mutate(cap.id);
  }

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium">能力范围</h3>
        {isAdmin && !showForm && (
          <Button size="sm" variant="outline" onClick={openAdd}>
            <Plus className="mr-1 h-4 w-4" />添加
          </Button>
        )}
      </div>

      {showForm && (
        <div className="mb-3 space-y-2 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {isEditing ? "编辑能力" : "新建能力"}
            </span>
            <Button size="sm" variant="ghost" onClick={resetForm}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">服务项 *</label>
            <Select value={serviceKey} onValueChange={(v) => v && handleServiceKeyChange(v)}>
              <SelectTrigger>
                <SelectValue placeholder="选择服务项" />
              </SelectTrigger>
              <SelectContent>
                {catalogItems.map((i) => (
                  <SelectItem key={i.serviceKey} value={i.serviceKey}>
                    {i.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">项目名称 *</label>
            <Input value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="项目名称" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">规格</label>
            <Input value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="可选规格" />
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="rounded"
            />
            <span>启用</span>
          </label>
          <Button
            size="sm"
            className="w-full"
            disabled={createMutation.isPending || !serviceKey || !itemName.trim()}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? "保存中..." : isEditing ? "保存" : "添加"}
          </Button>
        </div>
      )}

      {capabilities.length === 0 && !showForm ? (
        <p className="text-sm text-muted-foreground">暂无能力数据</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {capabilities.map((cap) => (
            <div key={cap.id} className="flex items-center gap-1">
              <Badge variant={cap.active ? "secondary" : "outline"}>
                {cap.itemName}
                {cap.spec ? ` (${cap.spec})` : ""}
              </Badge>
              {isAdmin && (
                <span className="flex items-center gap-0.5">
                  <Button size="sm" variant="ghost" className="h-6 px-1" onClick={() => openEdit(cap)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 px-1" onClick={() => handleDelete(cap)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
