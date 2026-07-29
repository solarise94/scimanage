"use client";

import { useState } from "react";
import { FormSheet } from "@/components/ui/form-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { crmKeys } from "@/lib/crm/query-keys";
import { PREFERENCE_CATEGORY, PREFERENCE_CATEGORY_LABELS } from "@/lib/crm/constants";
import { toast } from "sonner";
import { Plus, Pencil, ChevronDown, ChevronUp } from "lucide-react";

interface PreferenceFormDialogProps {
  profileId: string;
  triggerVariant?: "button" | "inline";
  startOpen?: boolean;
  onClose?: () => void;
  /** 编辑模式时传入 */
  editing?: {
    id: string;
    category: string;
    label: string;
    valueText?: string | null;
    note?: string | null;
    pinned: boolean;
  };
}

export function PreferenceFormDialog({
  profileId,
  triggerVariant = "button",
  startOpen,
  onClose,
  editing,
}: PreferenceFormDialogProps) {
  const [open, setOpen] = useState(startOpen || false);
  const [category, setCategory] = useState(editing?.category || "AVAILABILITY");
  const [label, setLabel] = useState(editing?.label || "");
  const [valueText, setValueText] = useState(editing?.valueText || "");
  const [note, setNote] = useState(editing?.note || "");
  const [pinned, setPinned] = useState(editing?.pinned ?? false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => {
      if (editing) {
        const res = await fetch(`/api/crm/preferences/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label, valueText, note, pinned }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "更新失败");
        }
        return res.json();
      }
      const res = await fetch(`/api/crm/profiles/${profileId}/preferences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, label, valueText, pinned, note }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "创建失败");
      }
      return res.json();
    },
    onSuccess: async () => {
      toast.success(editing ? "偏好已更新" : "偏好已添加");
      const promises: Promise<void>[] = [
        queryClient.invalidateQueries({ queryKey: crmKeys.preferences(profileId) }),
        queryClient.invalidateQueries({ queryKey: crmKeys.profile(profileId) }),
      ];
      await Promise.all(promises);
      setOpen(false);
      if (!editing) {
        setLabel("");
        setValueText("");
        setNote("");
        setPinned(false);
      }
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v && onClose) onClose();
  };

  const trigger =
    triggerVariant === "inline" ? null : editing ? (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Pencil className="h-3.5 w-3.5 mr-1" />编辑
      </Button>
    ) : (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4 mr-1" />添加偏好
      </Button>
    );

  return (
    <>
      {trigger}
      <FormSheet
        open={open}
        onOpenChange={handleOpenChange}
        title={editing ? "编辑偏好" : "添加客户偏好"}
        desktopVariant="plain"
        desktopMaxW="sm:max-w-md"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
          className="space-y-4"
        >
          {!editing && (
            <div>
              <label className="text-sm font-medium">分类 *</label>
              <Select value={category} onValueChange={(v) => v && setCategory(v)}>
                <SelectTrigger>
                  <SelectValue placeholder="选择分类" />
                </SelectTrigger>
                <SelectContent>
                  {PREFERENCE_CATEGORY.map((c) => (
                    <SelectItem key={c} value={c}>
                      {PREFERENCE_CATEGORY_LABELS[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <label className="text-sm font-medium">标题 *</label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
              placeholder="例如：工作日上午在实验室"
            />
          </div>
          <div>
            <label className="text-sm font-medium">内容</label>
            <Textarea
              value={valueText}
              onChange={(e) => setValueText(e.target.value)}
              placeholder="详细描述偏好内容"
              rows={3}
            />
          </div>
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {showAdvanced ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            高级选项
          </button>
          {showAdvanced && (
            <div>
              <label className="text-sm font-medium">内部备注</label>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="仅内部可见的备注"
                rows={2}
              />
            </div>
          )}
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
              className="rounded"
            />
            <span>置顶（在概览卡片优先展示）</span>
          </label>
          <Button type="submit" disabled={mutation.isPending || !label.trim()} className="w-full">
            {mutation.isPending ? "保存中..." : editing ? "保存" : "添加"}
          </Button>
        </form>
      </FormSheet>
    </>
  );
}
