"use client";

import { useState, useEffect, useRef, Suspense, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { DraftInputPanel } from "@/components/draft-input-panel";
import { CustomerSelect } from "@/components/customer-select";
import { OrganizationSelect } from "@/components/organization-select";
import { SourceBrandSelect } from "@/components/source-brand-select";
import { RepresentativeSelect } from "@/components/representative-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectDisplay } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { isAdmin, isInternalStaff } from "@/lib/role-guards";
import { toast } from "sonner";
import { getProjectTypeLabel, normalizeProjectType } from "@/lib/project-type";
import { TechSupportSelect } from "@/components/tech-support-select";
import { actorDisplayName } from "@/lib/tech-support";

const ORDER_FIELD_LABELS: Record<string, string> = {
  title: "订单标题", description: "描述", category: "分类",
  customer: "客户", buyerNameSnapshot: "收件人", buyerPhoneSnapshot: "电话",
  buyerWechatSnapshot: "微信", buyerOrgNameSnapshot: "单位", buyerAddressSnapshot: "地址",
  orderedAt: "下单日期", lines: "明细项", quantity: "数量/例数",
  unitPrice: "单价", sampleType: "样本类型", totalAmount: "总金额",
  projectType: "项目类型", procurementSource: "采购渠道", brand: "品牌",
  techSupport: "技术支持", budgetCost: "项目成本",
  initialCost: "订单成本", initialCostType: "成本类型", initialCostRemark: "成本备注",
};

const DERIVED_PROJECT_TYPES = new Set(["商品", "服务"]);

function deriveProjectTypeFromCategory(category: string): string {
  if (category === "PRODUCT") return "商品";
  return "服务";
}

function NewOrderForm() {
  const router = useRouter();
  const { status, data: session } = useSession();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("SERVICE");
  const [profileId, setProfileId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerOrgName, setCustomerOrgName] = useState("");
  const [representativeId, setRepresentativeId] = useState("");
  const [representativeName, setRepresentativeName] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [orderedAt, setOrderedAt] = useState(new Date().toISOString().slice(0, 10));
  const [projectAction, setProjectAction] = useState("GENERATE"); // GENERATE, NONE, LINK
  const [projectId, setProjectId] = useState("");
  const [manualProjectOverride, setManualProjectOverride] = useState(false);
  // Project draft fields (for GENERATE)
  const [pProjectType, setPProjectType] = useState(deriveProjectTypeFromCategory(category));
  const pProjectTypeTouched = useRef(false);
  const [pProjectContent, setPProjectContent] = useState("");
  const [pQuantity, setPQuantity] = useState("");
  const [pProcurementSource, setPProcurementSource] = useState("");
  const [pBrand, setPBrand] = useState("");
  const [pTechSupport, setPTechSupport] = useState("");
  const [techSupportTouched, setTechSupportTouched] = useState(false);
  const [pStartDate, setPStartDate] = useState(orderedAt);
  const pStartDateTouched = useRef(false);
  const [pBudgetCost, setPBudgetCost] = useState("");
  // Order-level cost (for non-GENERATE)
  const [initialCost, setInitialCost] = useState("");
  const [initialCostType, setInitialCostType] = useState("");
  const [initialCostRemark, setInitialCostRemark] = useState("");
  const [financeTreatment, setFinanceTreatment] = useState("PROJECT_INCLUDED");
  const [buyerName, setBuyerName] = useState("");
  const [buyerPhone, setBuyerPhone] = useState("");
  const [buyerWechat, setBuyerWechat] = useState("");
  const [buyerOrgName, setBuyerOrgName] = useState("");
  const [buyerOrgId, setBuyerOrgId] = useState("");
  const [buyerAddress, setBuyerAddress] = useState("");
  const [lines, setLines] = useState<{ productSkuId: string; itemName: string; spec: string; unit: string; quantity: number; unitPrice: number; amount: number }[]>([
    { productSkuId: "", itemName: "", spec: "", unit: "", quantity: 1, unitPrice: 0, amount: 0 },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");



  // Sync project draft defaults from order fields.
  // Only auto-sync when the current value is still a simple category-derived default
  // ("商品"/"服务"/"混合"). AI drafts often fill a richer projectType like "mRNA转录组测序"
  // — those should be preserved even though the user hasn't manually touched the input.
  useEffect(() => {
    if (pProjectTypeTouched.current) return;
    setPProjectType((current) => (
      DERIVED_PROJECT_TYPES.has(current) ? deriveProjectTypeFromCategory(category) : current
    ));
  }, [category]);

  // 内部员工默认「谁填谁负责」：派生展示值，避免 effect 内 setState
  const sessionDefaultTechSupport = useMemo(() => {
    if (!isInternalStaff(session?.user?.role)) return "";
    return actorDisplayName({
      role: session?.user?.role,
      name: session?.user?.name,
      email: session?.user?.email,
    });
  }, [session?.user?.role, session?.user?.name, session?.user?.email]);
  const effectiveTechSupport = techSupportTouched
    ? pTechSupport
    : (pTechSupport.trim() || sessionDefaultTechSupport);

  useEffect(() => {
    if (!pStartDateTouched.current) {
      setPStartDate(orderedAt);
    }
  }, [orderedAt]);

  const handleDraftApply = useCallback(async (fields: Record<string, unknown>) => {
    if (fields.title) setTitle(String(fields.title));
    if (fields.description) setDescription(String(fields.description));
    if (fields.category && ["SERVICE", "PRODUCT"].includes(String(fields.category))) {
      setCategory(String(fields.category));
    }
    if (fields.customer && typeof fields.customer === "object") {
      const cust = fields.customer as Record<string, unknown>;
      if (cust.matched && cust.id) {
        // Existing customer — fetch full CRM info then apply
        const applyCustomerOption = (c: Record<string, unknown>) => {
          setProfileId(String(c.id || cust.id));
          setCustomerName(String(c.name || cust.name || ""));
          setCustomerOrgName(String(c.organization || ""));
          setBuyerName(String(c.name || cust.name || ""));
          setBuyerPhone(String(c.principal || ""));
          setBuyerWechat(String(c.wechat || ""));
          setBuyerAddress(String(c.address || ""));
          setBuyerOrgName(String(c.organization || ""));
          setBuyerOrgId(String(c.organizationId || ""));
          setRepresentativeId(String(c.representativeId || ""));
          setRepresentativeName(String(c.representativeName || ""));
        };
        try {
          const res = await fetch("/api/customers/list", {
            headers: { "x-customer-api-caller": "orders-new" },
          });
          if (res.ok) {
            const data = await res.json();
            const customers = data?.customers as Array<Record<string, unknown>> | undefined;
            const full = customers?.find((c: Record<string, unknown>) => String(c.id) === String(cust.id));
            if (full) {
              applyCustomerOption(full);
            } else {
              // Fallback: apply what we have from entity resolver
              applyCustomerOption(cust);
            }
          } else {
            applyCustomerOption(cust);
          }
        } catch {
          applyCustomerOption(cust);
        }
      } else if (cust.shouldCreate && cust.name) {
        // New customer — create via API then fill
        const createCustomerFromDraft = async () => {
          const orgEntity = typeof fields.buyerOrgNameSnapshot === "object" && fields.buyerOrgNameSnapshot !== null
            ? (fields.buyerOrgNameSnapshot as Record<string, unknown>)
            : null;
          const orgName = orgEntity ? String(orgEntity.name || "") : (typeof fields.buyerOrgNameSnapshot === "string" ? String(fields.buyerOrgNameSnapshot) : "");
          const orgId = orgEntity ? String(orgEntity.id || "") : "";

          const res = await fetch("/api/customers", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-customer-api-caller": "orders-new" },
            body: JSON.stringify({
              name: String(cust.name),
              principal: (cust.principal as string)?.trim() || (fields.buyerPhoneSnapshot as string)?.trim() || undefined,
              wechat: (cust.wechat as string)?.trim() || (fields.buyerWechatSnapshot as string)?.trim() || undefined,
              address: (cust.address as string)?.trim() || (fields.buyerAddressSnapshot as string)?.trim() || undefined,
              organization: (cust.organization as string)?.trim() || orgName || undefined,
              organizationId: (cust.organizationId as string) || orgId || undefined,
              organizationRawInput: (cust.organization as string)?.trim() || orgName || undefined,
              autoCreateOrganization: true,
            }),
          });
          return res;
        };

        try {
          const res = await createCustomerFromDraft();
          if (res.ok) {
            const data = await res.json();
            const created = data.customer;
            if (created?.id) {
              setProfileId(String(created.id));
              setCustomerName(String(created.name || cust.name));
              if (created.organization) setCustomerOrgName(String(created.organization));
              if (created.organizationId) setBuyerOrgId(String(created.organizationId));
              if (created.principal) setBuyerPhone(String(created.principal));
              if (created.wechat) setBuyerWechat(String(created.wechat));
              if (created.address) setBuyerAddress(String(created.address));
              // Rep: use returned value or explicitly clear
              setRepresentativeId(created.representativeId ? String(created.representativeId) : "");
              setRepresentativeName(created.representativeName ? String(created.representativeName) : "");
              setBuyerName(String(cust.name));
              if (cust.organization) setBuyerOrgName(String(cust.organization as string));
              // Invalidate customer list cache so pickers reflect new customer
              queryClient.invalidateQueries({ queryKey: ["customers-list"] });
              toast.success(`已创建客户 "${String(cust.name)}"`);
            }
          } else {
            const err = await res.json().catch(() => ({}));
            toast.error(err.error || "客户创建失败，请在表单中手动选择");
            setProfileId("");
            setCustomerName("");
            setRepresentativeId("");
            setRepresentativeName("");
            setBuyerName(String(cust.name));
          }
        } catch {
          toast.error("客户创建失败，请在表单中手动选择");
          setProfileId("");
          setCustomerName("");
          setRepresentativeId("");
          setRepresentativeName("");
          setBuyerName(String(cust.name));
        }
      } else if (cust.name) {
        // Unmatched, not marked for creation — just fill buyer name
        setBuyerName(String(cust.name));
      }
    }
    if (fields.buyerNameSnapshot) setBuyerName(String(fields.buyerNameSnapshot));
    if (fields.buyerPhoneSnapshot) setBuyerPhone(String(fields.buyerPhoneSnapshot));
    if (fields.buyerWechatSnapshot) setBuyerWechat(String(fields.buyerWechatSnapshot));
    if (fields.buyerOrgNameSnapshot) {
      if (typeof fields.buyerOrgNameSnapshot === "object" && fields.buyerOrgNameSnapshot !== null) {
        const org = fields.buyerOrgNameSnapshot as Record<string, unknown>;
        setBuyerOrgName(String(org.name || ""));
        setBuyerOrgId(String(org.id || ""));
      } else {
        setBuyerOrgName(String(fields.buyerOrgNameSnapshot));
        setBuyerOrgId("");
      }
    }
    if (fields.buyerAddressSnapshot) setBuyerAddress(String(fields.buyerAddressSnapshot));
    if (fields.orderedAt) {
      const d = String(fields.orderedAt);
      if (d.match(/^\d{4}-\d{2}-\d{2}/)) setOrderedAt(d.slice(0, 10));
    }
    if (fields.totalAmount) {
      const amt = Number(fields.totalAmount);
      if (!Number.isNaN(amt)) setTotalAmount(String(amt));
    }
    // ── Unified line derivation ────────────────────────────────────
    const deriveOrderLinesFromDraft = () => {
      const rawLines = fields.lines;
      const totalAmt = fields.totalAmount ? Number(fields.totalAmount) : 0;
      const qty = fields.quantity != null ? Number(fields.quantity) : undefined;
      const up = fields.unitPrice != null ? Number(fields.unitPrice) : undefined;
      const st = fields.sampleType ? String(fields.sampleType) : "";
      const itemName = String(fields.title || "订单服务");

      // Normalize a single line: amount = max(rawAmount, quantity × unitPrice)
      const normalizeLine = (l: Record<string, unknown>) => {
        const q = Number(l.quantity) || 1;
        const up = Number(l.unitPrice) || 0;
        const rawAmt = Number(l.amount);
        const amt = rawAmt > 0 ? rawAmt : q * up;
        return {
          // AI 草稿填充的自由文本行无 productSkuId；用户需手动选择 SKU 后才可提交。
          productSkuId: "",
          itemName: String(l.itemName || l.name || ""),
          spec: String(l.spec || st),
          unit: String(l.unit || "项"),
          quantity: q,
          unitPrice: up,
          amount: amt,
        };
      };

      // Priority 1: structured lines array with valid data
      if (Array.isArray(rawLines) && rawLines.length > 0) {
        const first = rawLines[0] as Record<string, unknown>;
        if ((first.quantity && Number(first.quantity) > 0) || (first.unitPrice && Number(first.unitPrice) > 0)) {
          return (rawLines as Array<Record<string, unknown>>).map(normalizeLine);
        }
      }

      // Priority 2: quantity + unitPrice → derive amount
      if (qty && qty > 0 && up != null) {
        const amt = totalAmt || qty * up;
        return [{
          productSkuId: "",
          itemName, spec: st,
          unit: "例",
          quantity: qty, unitPrice: up, amount: amt,
        }];
      }

      // Priority 3: totalAmount only → single line (last resort)
      if (totalAmt > 0) {
        return [{
          productSkuId: "",
          itemName, spec: st,
          unit: "项", quantity: 1,
          unitPrice: totalAmt, amount: totalAmt,
        }];
      }

      // Priority 4: string lines
      if (typeof rawLines === "string" && rawLines.trim()) {
        const amt = totalAmt || 0;
        return [{
          productSkuId: "",
          itemName: rawLines.trim(), spec: st,
          unit: "项", quantity: 1,
          unitPrice: Number.isNaN(amt) ? 0 : amt,
          amount: Number.isNaN(amt) ? 0 : amt,
        }];
      }

      return null;
    };
    const derivedLines = deriveOrderLinesFromDraft();
    if (derivedLines) {
      setLines(derivedLines);
      // Recompute totalAmount from lines if missing or zero
      const lineSum = derivedLines.reduce((s, l) => s + l.amount, 0);
      if (lineSum > 0 && (!fields.totalAmount || Number(fields.totalAmount) === 0)) {
        setTotalAmount(String(lineSum));
      }
    }
    // Supplement project fields (non-derivable)
    if (fields.projectType) setPProjectType(getProjectTypeLabel(String(fields.projectType)));
    if (fields.procurementSource) setPProcurementSource(String(fields.procurementSource));
    if (fields.brand) setPBrand(String(fields.brand));
    if (fields.techSupport) {
      setTechSupportTouched(true);
      setPTechSupport(String(fields.techSupport));
    }
    if (fields.budgetCost != null) setPBudgetCost(String(fields.budgetCost));
    // Cost linkage: GENERATE → budgetCost, non-GENERATE → initialCost
    if (fields.budgetCost != null && projectAction !== "GENERATE") {
      setInitialCost(String(fields.budgetCost));
    }
    if (fields.initialCost != null && projectAction === "GENERATE") {
      setPBudgetCost(String(fields.initialCost));
    }
    toast.success("已从草稿填充订单信息，请为每行选择产品 SKU 后提交");
  }, [queryClient, projectAction]);

  const { data: procurementChannelsData } = useQuery<{ channels: Array<{ id: string; name: string }> }>({
    queryKey: ["procurement-channels"],
    queryFn: () => fetch("/api/procurement-channels").then(r => r.json()),
    staleTime: 5 * 60 * 1000,
    enabled: status === "authenticated" && isAdmin(session?.user?.role),
  });
  const procurementChannels = procurementChannelsData?.channels || [];

  // Phase 1 review #1：新业务订单每行必须绑定 SKU。加载可销售 SKU 供行编辑器选择。
  const { data: sellableSkusData } = useQuery<{
    options: Array<{
      productSkuId: string; productSkuCode: string; productId: string; productCode: string;
      productName: string; skuName: string; displayName: string;
      spec: string | null; standardUnit: string; defaultSalesPrice: number | null;
    }>;
  }>({
    queryKey: ["products", "sellable-options"],
    queryFn: async () => {
      const res = await fetch("/api/products?options=sellable");
      if (!res.ok) throw new Error("加载产品失败");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    enabled: status === "authenticated" && isAdmin(session?.user?.role),
  });
  const sellableSkuOptions = sellableSkusData?.options ?? [];
  const sellableSkuMap = useMemo(() => {
    const m = new Map<string, (typeof sellableSkuOptions)[number]>();
    for (const o of sellableSkuOptions) m.set(o.productSkuId, o);
    return m;
  }, [sellableSkuOptions]);

  if (status === "loading") return <div className="p-8 text-muted-foreground">加载中...</div>;
  if (status === "unauthenticated") { router.push("/login"); return null; }
  if (!isAdmin(session?.user?.role)) { router.push("/dashboard"); return null; }

  const updateLine = (i: number, field: string, value: unknown) => {
    const updated = [...lines];
    updated[i] = { ...updated[i], [field]: value };
    if (field === "quantity" || field === "unitPrice") {
      updated[i].amount = (updated[i].quantity || 0) * (updated[i].unitPrice || 0);
    }
    setLines(updated);
  };

  // 选择 SKU 时自动填充展示字段（itemName/spec/unit）+ 默认售价。
  // productSkuId 是提交给后端的唯一身份源；展示字段仅为用户参考。
  const selectLineSku = (i: number, productSkuId: string) => {
    const sku = productSkuId ? sellableSkuMap.get(productSkuId) : undefined;
    const updated = [...lines];
    if (sku) {
      updated[i] = {
        ...updated[i],
        productSkuId: sku.productSkuId,
        itemName: sku.skuName,
        spec: sku.spec ?? "",
        unit: sku.standardUnit,
        unitPrice: sku.defaultSalesPrice != null ? sku.defaultSalesPrice / 100 : updated[i].unitPrice,
        amount: (updated[i].quantity || 0) * (sku.defaultSalesPrice != null ? sku.defaultSalesPrice / 100 : updated[i].unitPrice),
      };
    } else {
      updated[i] = { ...updated[i], productSkuId: "" };
    }
    setLines(updated);
  };

  const addLine = () => setLines([...lines, { productSkuId: "", itemName: "", spec: "", unit: "", quantity: 1, unitPrice: 0, amount: 0 }]);
  const removeLine = (i: number) => setLines(lines.filter((_, idx) => idx !== i));

  const handleProjectActionChange = (next: string) => {
    if (next === "GENERATE") {
      setProjectAction("GENERATE");
      setFinanceTreatment("PROJECT_INCLUDED");
      if (!pProjectType && !pProjectTypeTouched.current) setPProjectType(deriveProjectTypeFromCategory(category));
      if (!pBudgetCost && initialCost) setPBudgetCost(initialCost);
    }
    if (next === "NONE") {
      setProjectAction("NONE");
      setFinanceTreatment("STANDALONE");
      if (!initialCost && pBudgetCost) setInitialCost(pBudgetCost);
    }
    if (next === "LINK") {
      setProjectAction("LINK");
      setFinanceTreatment("PROJECT_INCLUDED");
    }
  };

  const handleSubmit = async (draft: boolean) => {
    setSubmitting(true);
    setError("");
    // Phase 1 review #1：提交前校验每行已选 SKU。
    const linesWithoutSku = lines.filter(l => !l.productSkuId);
    if (linesWithoutSku.length > 0) {
      setError(`每行必须选择产品 SKU；当前 ${linesWithoutSku.length} 行未选择。请为每行选择产品后再提交。`);
      setSubmitting(false);
      return;
    }
    try {
      const body: Record<string, unknown> = {
        title,
        description: description || null,
        category,
        status: draft ? "DRAFT" : "CONFIRMED",
        orderedAt: orderedAt ? new Date(orderedAt).toISOString() : null,
        profileId: profileId || null,
        representativeId: representativeId || null,
        projectAction,
        projectId: projectId || null,
        financeTreatment,
        buyerNameSnapshot: buyerName || null,
        buyerPhoneSnapshot: buyerPhone || null,
        buyerWechatSnapshot: buyerWechat || null,
        buyerOrgNameSnapshot: buyerOrgName || null,
        buyerAddressSnapshot: buyerAddress || null,
        techSupport: effectiveTechSupport || null,
        lines: lines.filter(l => l.productSkuId).map(l => ({
          productSkuId: l.productSkuId,
          itemName: l.itemName,
          spec: l.spec || null,
          unit: l.unit || null,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          amount: l.amount,
        })),
        totalAmount: totalAmount ? Number(totalAmount) : undefined,
      };

      if (projectAction === "GENERATE") {
        body.projectDraft = {
          projectType: normalizeProjectType(pProjectType) || null,
          projectContent: manualProjectOverride ? (pProjectContent || null) : null,
          quantity: manualProjectOverride ? (pQuantity || null) : null,
          procurementSource: pProcurementSource || null,
          brand: pBrand || null,
          techSupport: effectiveTechSupport || null,
          startDate: pStartDate || null,
          budgetCost: pBudgetCost || null,
        };
      } else {
        body.initialCost = initialCost || null;
        body.initialCostType = initialCostType || null;
        body.initialCostRemark = initialCostRemark || null;
      }
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const d = await res.json();
        if (!profileId && !draft) {
          toast.warning("订单已创建，但未绑定客户，请尽快处理", {
            action: {
              label: "去处理",
              onClick: () => router.push(`/orders?focus=${d.order.id}`),
            },
          });
        }
        router.push(`/orders?focus=${d.order.id}`);
      } else {
        const d = await res.json();
        setError(d.error || "创建失败");
      }
    } catch (e) {
      setError(`提交失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setSubmitting(false); }
  };

  const lineTotal = lines.reduce((s, l) => s + l.amount, 0);
  const primaryLine = lines.find((l) => l.itemName.trim());
  const derivedOrderAmount = lineTotal || Number(totalAmount) || 0;
  const derivedProjectName = title.trim();
  const derivedProjectContent = manualProjectOverride
    ? pProjectContent
    : primaryLine?.itemName || title.trim();
  const derivedQuantity = manualProjectOverride
    ? pQuantity
    : String(primaryLine?.quantity || 1);

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div><Link href="/orders" className="text-sm text-muted-foreground hover:underline">&larr; 返回</Link><h1 className="text-xl font-bold">新建服务订单</h1></div>
      </div>

      <DraftInputPanel
        formKey="order.create"
        fieldLabels={ORDER_FIELD_LABELS}
        onApply={handleDraftApply}
        fallbackPlugin="order.smart-fill"
      />

      {error && <Card className="p-3 text-sm text-danger bg-danger-bg border-danger-border">{error}</Card>}


      <Card className="p-4 space-y-3">
        <div><label className="text-sm font-medium">订单标题 *</label><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例: 单细胞测序服务" /></div>
        <div><label className="text-sm font-medium">描述</label><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="订单描述（可选）" /></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-sm font-medium">分类</Label>
            <Select value={category} onValueChange={(v) => setCategory(v || "SERVICE")} aria-label="分类">
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择分类" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SERVICE">服务</SelectItem>
                <SelectItem value="PRODUCT">商品</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1"><Label className="text-sm font-medium">下单日期</Label><Input type="date" value={orderedAt} onChange={(e) => setOrderedAt(e.target.value)} /></div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium">客户</label>
            <CustomerSelect
              value={profileId}
              displayValue={customerName}
              onChange={(id, name, org, organizationId, customer) => {
                setProfileId(id || "");
                setCustomerName(name || "");
                setCustomerOrgName(org || "");

                if (id && customer) {
                  setBuyerName(customer.name || "");
                  setBuyerPhone(customer.principal || "");
                  setBuyerWechat(customer.wechat || "");
                  setBuyerAddress(customer.address || "");
                  setBuyerOrgName(customer.organization || "");
                  setBuyerOrgId(customer.organizationId || "");
                  setRepresentativeId(customer.representativeId || "");
                  setRepresentativeName(customer.representativeName || "");
                } else {
                  // Customer cleared — clear representative, keep buyer snapshots
                  setRepresentativeId("");
                  setRepresentativeName("");
                }
              }}
              quickCreateDefaults={{
                name: buyerName,
                principal: buyerPhone,
                wechat: buyerWechat,
                organization: buyerOrgName,
                organizationId: buyerOrgId,
                address: buyerAddress,
              }}
            />
          </div>
          <div>
            <label className="text-sm font-medium">代表</label>
            {profileId ? (
              <>
                <Input
                  value={representativeName || representativeId || "由客户 CRM 负责人同步"}
                  disabled
                  className="text-muted-foreground"
                />
                {!representativeId && !representativeName && (
                  <p className="text-xs text-muted-foreground mt-1">无匹配代表</p>
                )}
              </>
            ) : (
              <RepresentativeSelect
                value={representativeId}
                displayValue={representativeName}
                onChange={(id, name) => {
                  setRepresentativeId(id || "");
                  setRepresentativeName(name || "");
                }}
              />
            )}
          </div>
        </div>
        {(customerName || customerOrgName) && (
          <div className="text-xs text-muted-foreground">
            已选客户：{customerName || profileId}{customerOrgName ? ` / ${customerOrgName}` : ""}
          </div>
        )}
      </Card>

      {/* Buyer Snapshot */}
      <Card className="p-4 space-y-3">
        <h3 className="font-medium">买方信息（快照）</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><label className="text-sm font-medium">收件人</label><Input value={buyerName} onChange={(e) => setBuyerName(e.target.value)} placeholder="收件人姓名" /></div>
          <div><label className="text-sm font-medium">电话</label><Input value={buyerPhone} onChange={(e) => setBuyerPhone(e.target.value)} placeholder="联系电话" /></div>
          <div><label className="text-sm font-medium">微信</label><Input value={buyerWechat} onChange={(e) => setBuyerWechat(e.target.value)} placeholder="微信号" /></div>
          <div>
            <label className="text-sm font-medium">单位</label>
            <OrganizationSelect
              value={buyerOrgId}
              displayValue={buyerOrgName}
              onChange={(id, name) => {
                setBuyerOrgId(id || "");
                setBuyerOrgName(name || "");
              }}
            />
          </div>
        </div>
        <div><label className="text-sm font-medium">地址</label><Input value={buyerAddress} onChange={(e) => setBuyerAddress(e.target.value)} placeholder="收货地址" /></div>
      </Card>

      {/* Lines */}
      <Card className="p-4 space-y-3">
        <div className="flex justify-between items-center"><h3 className="font-medium">订单明细</h3><Button variant="outline" size="sm" onClick={addLine}>+ 添加行</Button></div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-1 sm:grid-cols-6 gap-2 items-end border-b pb-2">
            <div className="sm:col-span-2">
              <label className="text-xs text-muted-foreground">产品 SKU *</label>
              <Select
                value={l.productSkuId}
                onValueChange={(v) => selectLineSku(i, v ?? "")}
                aria-label={`选择产品 SKU ${i + 1}`}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={l.itemName ? `${l.itemName}（未选 SKU）` : "选择产品 SKU"} />
                </SelectTrigger>
                <SelectContent>
                  {sellableSkuOptions.length === 0 ? (
                    <SelectItem value="__none" disabled>暂无可销售 SKU，请先在产品目录创建</SelectItem>
                  ) : (
                    sellableSkuOptions.map((o) => (
                      <SelectItem key={o.productSkuId} value={o.productSkuId}>
                        {o.displayName}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <div><label className="text-xs text-muted-foreground">数量</label><Input type="number" value={l.quantity || ""} onChange={(e) => updateLine(i, "quantity", Number(e.target.value))} /></div>
            <div><label className="text-xs text-muted-foreground">单价</label><Input type="number" value={l.unitPrice || ""} onChange={(e) => updateLine(i, "unitPrice", Number(e.target.value))} /></div>
            <div><label className="text-xs text-muted-foreground">金额</label><div className="text-sm py-1.5 font-medium">¥{l.amount.toLocaleString()}</div></div>
            <div className="flex items-end justify-end sm:justify-start"><Button variant="outline" size="sm" onClick={() => removeLine(i)} disabled={lines.length <= 1}>×</Button></div>
          </div>
        ))}
        <div className="text-right font-medium">合计: ¥{lineTotal.toLocaleString()}</div>
      </Card>

      {/* Project options */}
      <Card className="p-4 space-y-3">
        <h3 className="font-medium">项目选项</h3>
        <Select value={projectAction} onValueChange={(v) => handleProjectActionChange(v || "NONE")} aria-label="项目选项">
          <SelectTrigger className="w-full">
            <SelectValue placeholder="选择项目处理方式" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="GENERATE">创建订单并自动生成项目</SelectItem>
            <SelectItem value="NONE">仅创建订单</SelectItem>
            <SelectItem value="LINK">绑定已有项目</SelectItem>
          </SelectContent>
        </Select>
        {projectAction === "LINK" && <Input value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="输入项目ID" />}
      </Card>

      <Card className="p-4 space-y-2">
        <h3 className="font-medium">订单技术支持</h3>
        <TechSupportSelect
          value={effectiveTechSupport}
          onChange={(name) => {
            setTechSupportTouched(true);
            setPTechSupport(name);
          }}
          placeholder="默认自己，可搜索转交"
        />
      </Card>

      {/* Project preview + advanced settings (GENERATE) */}
      {projectAction === "GENERATE" && (
        <Card className="p-4 space-y-3">
          <h3 className="font-medium">项目预览</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div><span className="text-muted-foreground">项目名称：</span>{derivedProjectName || "未填写订单标题"}</div>
            <div><span className="text-muted-foreground">项目金额：</span>¥{derivedOrderAmount.toLocaleString()}</div>
            <div><span className="text-muted-foreground">项目内容：</span>{derivedProjectContent || "将从订单明细派生"}</div>
            <div><span className="text-muted-foreground">数量：</span>{derivedQuantity}</div>
            <div><span className="text-muted-foreground">客户：</span>{customerName || buyerName || "—"}</div>
            <div><span className="text-muted-foreground">单位：</span>{customerOrgName || buyerOrgName || "—"}</div>
            <div className="sm:col-span-2"><span className="text-muted-foreground">代表：</span>{representativeName || "由客户 CRM 负责人同步"}</div>
          </div>

          <div className="flex items-center gap-2 pt-2 border-t">
            <Checkbox
              id="manualProjectOverride"
              checked={manualProjectOverride}
              onCheckedChange={(checked) => setManualProjectOverride(Boolean(checked))}
            />
            <Label htmlFor="manualProjectOverride" className="text-sm cursor-pointer">手动覆盖项目内容和数量</Label>
          </div>
          {manualProjectOverride && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div><label className="text-sm font-medium">项目内容</label><Input value={pProjectContent} onChange={(e) => setPProjectContent(e.target.value)} placeholder="项目内容描述" /></div>
              <div><label className="text-sm font-medium">数量</label><Input type="number" value={pQuantity} onChange={(e) => setPQuantity(e.target.value)} placeholder="0" /></div>
            </div>
          )}

          <h3 className="font-medium pt-2 border-t">项目补充信息</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><label className="text-sm font-medium">项目类型</label><Input value={pProjectType} onChange={(e) => { setPProjectType(e.target.value); pProjectTypeTouched.current = true; }} placeholder="商品 / 服务" /></div>
            <div>
              <label className="text-sm font-medium">采购渠道</label>
              <Select value={pProcurementSource} onValueChange={(v) => setPProcurementSource(v || "")}>
                <SelectTrigger>
                  <SelectDisplay
                    label="选择渠道"
                    valueLabel={
                      pProcurementSource && !procurementChannels.find(c => c.name === pProcurementSource)
                        ? `历史/AI：${pProcurementSource}`
                        : (pProcurementSource || "选择渠道")
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">不选择</SelectItem>
                  {pProcurementSource && !procurementChannels.find(c => c.name === pProcurementSource) && (
                    <SelectItem value={pProcurementSource}>历史/AI：{pProcurementSource}</SelectItem>
                  )}
                  {procurementChannels.map((ch) => (
                    <SelectItem key={ch.id} value={ch.name}>{ch.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div><label className="text-sm font-medium">品牌</label><SourceBrandSelect value={pBrand} onChange={setPBrand} /></div>
            <div><label className="text-sm font-medium">开始日期</label><Input type="date" value={pStartDate} onChange={(e) => { setPStartDate(e.target.value); pStartDateTouched.current = true; }} /></div>
            <div><label className="text-sm font-medium">项目成本</label><Input type="number" value={pBudgetCost} onChange={(e) => setPBudgetCost(e.target.value)} placeholder="0" /></div>
          </div>
        </Card>
      )}

      {/* Order-level initial cost (non-GENERATE) */}
      {projectAction !== "GENERATE" && (
        <Card className="p-4 space-y-3">
          <h3 className="font-medium">订单成本</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><label className="text-sm font-medium">初始成本</label><Input type="number" value={initialCost} onChange={(e) => setInitialCost(e.target.value)} placeholder="0" /></div>
            <div><label className="text-sm font-medium">成本类型</label><Input value={initialCostType} onChange={(e) => setInitialCostType(e.target.value)} placeholder="如：试剂、服务" /></div>
          </div>
          <div><label className="text-sm font-medium">成本备注</label><Input value={initialCostRemark} onChange={(e) => setInitialCostRemark(e.target.value)} placeholder="备注说明" /></div>
        </Card>
      )}

      {/* Finance — hidden in GENERATE/LINK (locked to PROJECT_INCLUDED by backend) */}
      {projectAction === "NONE" && (
        <Card className="p-4 space-y-3">
          <h3 className="font-medium">财务设置</h3>
          <Select value={financeTreatment} onValueChange={(v) => setFinanceTreatment(v || "AUTO")} aria-label="财务设置">
            <SelectTrigger className="w-full">
              <SelectValue placeholder="选择财务处理方式" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="AUTO">自动判断</SelectItem>
              <SelectItem value="STANDALONE">独立计入</SelectItem>
              <SelectItem value="PROJECT_INCLUDED">并入项目</SelectItem>
              <SelectItem value="EXCLUDED">排除</SelectItem>
            </SelectContent>
          </Select>
        </Card>
      )}

      {/* U3：订单必须有客户——全模式要求选客户（非仅 GENERATE）。 */}
      {!profileId && (
        <Card className="p-3 text-sm text-warning bg-warning-bg border-warning-border">
          订单必须绑定客户。请在上方「客户」字段选择已有客户，或通过 AI 填单 / 快速添加创建新客户。
        </Card>
      )}
      {projectAction === "LINK" && !projectId.trim() && (
        <Card className="p-3 text-sm text-warning bg-warning-bg border-warning-border">
          绑定已有项目需要提供项目ID。请在项目选项中输入目标项目ID。
        </Card>
      )}
      <div className="flex flex-wrap gap-3 justify-end">
        <Button variant="outline" onClick={() => handleSubmit(true)} disabled={submitting || !title.trim() || !profileId || (projectAction === "LINK" && !projectId.trim())}>保存草稿</Button>
        <Button onClick={() => handleSubmit(false)} disabled={submitting || !title.trim() || !profileId || (projectAction === "LINK" && !projectId.trim())}>确认创建</Button>
      </div>
    </div>
  );
}

export default function NewOrderPage() {
  return (
    <Suspense fallback={<div className="p-8 text-muted-foreground">加载中...</div>}>
      <NewOrderForm />
    </Suspense>
  );
}
