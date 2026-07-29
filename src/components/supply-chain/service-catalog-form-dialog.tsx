"use client";

import { useState } from "react";
import { FormSheet } from "@/components/ui/form-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Pencil } from "lucide-react";
import {
  VALID_SERVICE_CATEGORIES,
  SERVICE_DOMAIN,
  SERVICE_DOMAIN_LABELS,
} from "@/lib/supply-chain/constants";

interface ServiceCatalogFormDialogProps {
  triggerVariant?: "button" | "inline";
  startOpen?: boolean;
  onClose?: () => void;
  editing?: {
    id: string;
    serviceKey: string;
    name: string;
    category: string;
    domain: string | null;
    aliasesJson: string | null;
    description: string | null;
    active: boolean;
  };
}

// 失效必须覆盖列表页订阅 key `["supply", "service-catalog"]`，
// 否则保存后列表不会刷新。用前缀失效，幂等且对子 key 友好。
const SUPPLY_QUERY_KEY = ["supply", "service-catalog"] as const;

export function ServiceCatalogFormDialog({
  triggerVariant = "button",
  startOpen,
  onClose,
  editing,
}: ServiceCatalogFormDialogProps) {
  const [open, setOpen] = useState(startOpen || false);
  const [serviceKey, setServiceKey] = useState(editing?.serviceKey || "");
  const [name, setName] = useState(editing?.name || "");
  const [category, setCategory] = useState(editing?.category || "SERVICE");
  const [domain, setDomain] = useState(editing?.domain || "OTHER");
  const [aliases, setAliases] = useState(
    editing?.aliasesJson ? (JSON.parse(editing.aliasesJson) as string[]).join("、") : "",
  );
  const [description, setDescription] = useState(editing?.description || "");
  const [active, setActive] = useState(editing?.active ?? true);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => {
      const aliasesJson = aliases.trim() ? JSON.stringify(aliases.split(/[、,，\s]+/).filter(Boolean)) : null;
      const payload = { name, category, domain, aliasesJson, description: description.trim() || null, active };

      if (editing) {
        const res = await fetch(`/api/supply/service-catalog/${editing.id}`, {
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

      const res = await fetch("/api/supply/service-catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, serviceKey: serviceKey.trim() }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "创建失败");
      }
      return res.json();
    },
    onSuccess: async () => {
      toast.success(editing ? "服务项已更新" : "服务项已创建");
      await queryClient.invalidateQueries({ queryKey: SUPPLY_QUERY_KEY });
      // 走统一关闭函数：编辑模式触发 onClose 清理父级 editingItem；
      // 创建模式保持 sheet 关闭 + 字段重置（供下次新增使用）。
      if (editing) {
        handleOpenChange(false);
      } else {
        setOpen(false);
        setServiceKey("");
        setName("");
        setDescription("");
        setAliases("");
      }
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v && onClose) onClose();
  };

  const trigger =
    triggerVariant === "inline" ? (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Pencil className="h-3.5 w-3.5 mr-1" />编辑
      </Button>
    ) : (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4 mr-1" />新增服务项
      </Button>
    );

  return (
    <>
      {trigger}
      <FormSheet
        open={open}
        onOpenChange={handleOpenChange}
        title={editing ? "编辑服务项" : "新增服务项"}
        desktopVariant="scrollable"
        desktopMaxW="sm:max-w-md"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
          className="space-y-4"
        >
          <div>
            <label className="text-sm font-medium">服务项 Key *</label>
            <Input
              value={serviceKey}
              onChange={(e) => setServiceKey(e.target.value)}
              required
              disabled={!!editing}
              placeholder="例如：scrna-seq（创建后不可修改）"
            />
          </div>
          <div>
            <label className="text-sm font-medium">名称 *</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="例如：单细胞 RNA 测序" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">类别</label>
              <Select value={category} onValueChange={(v) => v && setCategory(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VALID_SERVICE_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">业务域</label>
              <Select value={domain} onValueChange={(v) => v && setDomain(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SERVICE_DOMAIN.map((d) => (
                    <SelectItem key={d} value={d}>
                      {SERVICE_DOMAIN_LABELS[d] || d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">别名（逗号或顿号分隔）</label>
            <Input
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              placeholder="例如：scRNA-seq、单细胞转录组"
            />
          </div>
          <div>
            <label className="text-sm font-medium">描述</label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="rounded" />
            <span>启用（停用后不影响历史报价和映射）</span>
          </label>
          <Button type="submit" disabled={mutation.isPending || (!editing && !serviceKey.trim()) || !name.trim()} className="w-full">
            {mutation.isPending ? "保存中..." : editing ? "保存" : "创建"}
          </Button>
        </form>
      </FormSheet>
    </>
  );
}
