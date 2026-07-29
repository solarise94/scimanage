"use client";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectDisplay,
} from "@/components/ui/select";
import { contractKeys } from "@/lib/contracts/query-keys";
import { CONTRACT_CATEGORY_LABELS } from "@/lib/contracts/constants";
import { toast } from "sonner";
import { Loader2, ChevronDown } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string;
  order: Record<string, unknown>;
  onGenerated: () => void;
}

export function ContractGenerateDialog({
  open,
  onOpenChange,
  orderId,
  order,
  onGenerated,
}: Props) {
  const [category, setCategory] = useState("SEQUENCING");
  const [templateId, setTemplateId] = useState("");
  const [sellerProfileId, setSellerProfileId] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [remark, setRemark] = useState("");

  // 买方覆盖字段（合并为单一对象以避免 effect 内 setState）
  const [buyerOverride, setBuyerOverride] = useState({
    buyerName: "",
    buyerOrgName: "",
    buyerTaxId: "",
    buyerAddress: "",
    buyerPhone: "",
    buyerEmail: "",
  });
  const setBuyerField = (field: string, value: string) =>
    setBuyerOverride((prev) => ({ ...prev, [field]: value }));

  // 预填买方信息（用 useMemo 替代 useEffect + setState）
  const buyerPrefill = useMemo(() => {
    if (!open || !order) return null;
    const customer = order.customer as Record<string, unknown> | undefined;
    const org = customer?.org as Record<string, unknown> | undefined;
    return {
      buyerName:
        (customer?.name as string) ||
        (order.buyerNameSnapshot as string) ||
        "",
      buyerOrgName:
        (org?.canonicalName as string) ||
        (customer?.organization as string) ||
        (order.buyerOrgNameSnapshot as string) ||
        "",
      buyerTaxId: (org?.taxId as string) || "",
      buyerAddress:
        (org?.address as string) ||
        (customer?.address as string) ||
        (order.buyerAddressSnapshot as string) ||
        "",
      buyerPhone: (order.buyerPhoneSnapshot as string) || "",
      buyerEmail: (customer?.email as string) || "",
    };
  }, [open, order]);

  // 模板列表（按 category 筛选）
  const { data: templatesData } = useQuery({
    queryKey: contractKeys.templates.list({ category }),
    queryFn: async () => {
      const res = await fetch(`/api/contracts/templates?category=${category}`);
      if (!res.ok) throw new Error("Failed to fetch templates");
      return res.json();
    },
    enabled: open,
  });

  // 开票主体列表
  const { data: profilesData } = useQuery({
    queryKey: ["billing-profiles"],
    queryFn: async () => {
      const res = await fetch("/api/billing-profiles");
      if (!res.ok) throw new Error("Failed to fetch profiles");
      return res.json();
    },
    enabled: open,
  });

  const templates = useMemo<Array<Record<string, unknown>>>(
    () => templatesData?.templates || [],
    [templatesData]
  );
  const profiles = useMemo<Array<Record<string, unknown>>>(
    () => profilesData?.profiles || [],
    [profilesData]
  );

  // 默认模板：优先 isDefault=true，否则第一个
  const defaultTemplateId = useMemo(() => {
    if (templates.length === 0) return "";
    const dft =
      templates.find((t) => t.isDefault as boolean) || templates[0];
    return (dft.id as string) || "";
  }, [templates]);

  // 默认开票主体
  const defaultProfileId = useMemo(() => {
    if (profiles.length === 0) return "";
    const dft =
      profiles.find((p) => p.isDefault as boolean) || profiles[0];
    return (dft.id as string) || "";
  }, [profiles]);

  // 实际使用的值（优先用户选择，否则默认值）
  const effectiveTemplateId = templateId || defaultTemplateId;
  const effectiveProfileId = sellerProfileId || defaultProfileId;
  const selectedTemplate = templates.find((t) => t.id === effectiveTemplateId);
  const selectedProfile = profiles.find((p) => p.id === effectiveProfileId);

  // 买方显示值：优先使用用户输入的覆盖值，否则用预填值
  const buyerName = buyerOverride.buyerName || buyerPrefill?.buyerName || "";
  const buyerOrgName = buyerOverride.buyerOrgName || buyerPrefill?.buyerOrgName || "";
  const buyerTaxId = buyerOverride.buyerTaxId || buyerPrefill?.buyerTaxId || "";
  const buyerAddress = buyerOverride.buyerAddress || buyerPrefill?.buyerAddress || "";
  const buyerPhone = buyerOverride.buyerPhone || buyerPrefill?.buyerPhone || "";
  const buyerEmail = buyerOverride.buyerEmail || buyerPrefill?.buyerEmail || "";

  const handleGenerate = async () => {
    if (!effectiveTemplateId || !effectiveProfileId) {
      toast.error("请选择模板和开票主体");
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch("/api/contracts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderIds: [orderId],
          templateId: effectiveTemplateId,
          sellerProfileId: effectiveProfileId,
          buyerOverrides: {
            buyerNameOverride: buyerName || undefined,
            buyerOrgNameOverride: buyerOrgName || undefined,
            buyerTaxIdOverride: buyerTaxId || undefined,
            buyerAddressOverride: buyerAddress || undefined,
            buyerPhoneOverride: buyerPhone || undefined,
            buyerEmailOverride: buyerEmail || undefined,
          },
          remark: remark || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "生成失败");
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition");
      const filename =
        disposition?.match(/filename="?([^"]+)"?/)?.[1] || "合同.docx";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = decodeURIComponent(filename);
      a.click();
      URL.revokeObjectURL(url);
      // Refresh the order-detail contracts list so the new contract appears,
      // and offer a "查看合同" affordance that surfaces the contracts block.
      onGenerated();
      onOpenChange(false);
      toast.success("合同生成成功", {
        action: {
          label: "查看合同",
          onClick: () => onGenerated(),
        },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "生成失败");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>生成合同</DialogTitle>
          <DialogDescription>
            选择模板和开票主体，系统将自动从订单和客户信息中填充合同变量
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 mt-4">
          {/* 合同类型 */}
          <div>
            <Label>合同类型</Label>
            <Select
              value={category}
              onValueChange={(v) => {
                if (!v) return;
                setCategory(v);
                setTemplateId("");
              }}
            >
              <SelectTrigger className="h-9 mt-1">
                <SelectDisplay
                  label="类型"
                  valueLabel={CONTRACT_CATEGORY_LABELS[category] || category}
                />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(CONTRACT_CATEGORY_LABELS).map(
                  ([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  )
                )}
              </SelectContent>
            </Select>
          </div>

          {/* 模板选择 */}
          <div>
            <Label>选择模板</Label>
            <Select
              value={effectiveTemplateId}
              onValueChange={(v) => { if (v) setTemplateId(v); }}
              disabled={templates.length === 0}
            >
              <SelectTrigger className="h-9 mt-1">
                <SelectDisplay
                  label="模板"
                  valueLabel={
                    selectedTemplate
                      ? `${selectedTemplate.name as string}${(selectedTemplate.isDefault as boolean) ? " (默认)" : ""}`
                      : undefined
                  }
                  placeholder="请选择"
                />
              </SelectTrigger>
              <SelectContent>
                {templates.map((t) => (
                  <SelectItem key={t.id as string} value={t.id as string}>
                    {t.name as string}
                    {(t.isDefault as boolean) ? " (默认)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {templates.length === 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                该类型暂无可用的合同模板
              </p>
            )}
          </div>

          {/* 开票主体 */}
          <div>
            <Label>开票主体</Label>
            <Select
              value={effectiveProfileId}
              onValueChange={(v) => { if (v) setSellerProfileId(v); }}
              disabled={profiles.length === 0}
            >
              <SelectTrigger className="h-9 mt-1">
                <SelectDisplay
                  label="主体"
                  valueLabel={
                    selectedProfile
                      ? `${selectedProfile.name as string}${(selectedProfile.isDefault as boolean) ? " (默认)" : ""}`
                      : undefined
                  }
                  placeholder="请选择"
                />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((p) => (
                  <SelectItem key={p.id as string} value={p.id as string}>
                    {p.name as string}
                    {(p.isDefault as boolean) ? " (默认)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 买方信息覆盖（可折叠） */}
          <div>
            <button
              type="button"
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-2"
              onClick={() => setAdvancedOpen(!advancedOpen)}
            >
              <ChevronDown
                className="h-4 w-4 transition-transform"
                style={{ transform: advancedOpen ? "rotate(180deg)" : "" }}
              />
              买方信息（可手动修改）
            </button>
            {advancedOpen && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">买方名称</Label>
                    <Input
                      value={buyerName}
                      onChange={(e) => setBuyerField("buyerName", e.target.value)}
                      className="h-8 text-sm mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">买方单位</Label>
                    <Input
                      value={buyerOrgName}
                      onChange={(e) => setBuyerField("buyerOrgName", e.target.value)}
                      className="h-8 text-sm mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">买方税号</Label>
                    <Input
                      value={buyerTaxId}
                      onChange={(e) => setBuyerField("buyerTaxId", e.target.value)}
                      className="h-8 text-sm mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">买方电话</Label>
                    <Input
                      value={buyerPhone}
                      onChange={(e) => setBuyerField("buyerPhone", e.target.value)}
                      className="h-8 text-sm mt-1"
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-xs">买方地址</Label>
                  <Input
                    value={buyerAddress}
                    onChange={(e) => setBuyerField("buyerAddress", e.target.value)}
                    className="h-8 text-sm mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">买方邮箱</Label>
                  <Input
                    value={buyerEmail}
                    onChange={(e) => setBuyerField("buyerEmail", e.target.value)}
                    className="h-8 text-sm mt-1"
                  />
                </div>
              </div>
            )}
          </div>

          {/* 备注 */}
          <div>
            <Label className="text-xs">备注</Label>
            <Input
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder="可选备注"
              className="h-8 text-sm mt-1"
            />
          </div>

          {/* 操作 */}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={generating}
            >
              取消
            </Button>
            <Button onClick={handleGenerate} disabled={generating}>
              {generating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              生成并下载
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
