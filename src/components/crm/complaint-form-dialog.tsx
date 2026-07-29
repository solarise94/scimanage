"use client";

import { useState } from "react";
import { FormSheet } from "@/components/ui/form-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { crmKeys } from "@/lib/crm/query-keys";
import {
  COMPLAINT_CATEGORY,
  COMPLAINT_CATEGORY_LABELS,
  COMPLAINT_SEVERITY,
  COMPLAINT_SEVERITY_LABELS,
} from "@/lib/crm/constants";
import { toast } from "sonner";
import { Plus, AlertCircle } from "lucide-react";

interface ComplaintFormDialogProps {
  profileId: string;
  startOpen?: boolean;
  onClose?: () => void;
}

export function ComplaintFormDialog({
  profileId,
  startOpen,
  onClose,
}: ComplaintFormDialogProps) {
  const [open, setOpen] = useState(startOpen || false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("DELIVERY_DELAY");
  const [severity, setSeverity] = useState("MEDIUM");
  const [expectedResolutionAt, setExpectedResolutionAt] = useState("");
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/crm/profiles/${profileId}/complaints`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          category,
          severity,
          expectedResolutionAt: expectedResolutionAt || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "创建失败");
      }
      return res.json();
    },
    onSuccess: async () => {
      toast.success("客诉已创建，已自动生成处理任务");
      const promises: Promise<void>[] = [
        queryClient.invalidateQueries({ queryKey: crmKeys.complaints(profileId) }),
        queryClient.invalidateQueries({ queryKey: crmKeys.profile(profileId) }),
      ];
      await Promise.all(promises);
      setOpen(false);
      setTitle("");
      setDescription("");
      setExpectedResolutionAt("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v && onClose) onClose();
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <AlertCircle className="h-4 w-4 mr-1" />新建客诉
      </Button>
      <FormSheet
        open={open}
        onOpenChange={handleOpenChange}
        title="新建客诉"
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
          <div>
            <label className="text-sm font-medium">客诉标题 *</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              placeholder="例如：交付延迟 3 天"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">类型 *</label>
              <Select value={category} onValueChange={(v) => v && setCategory(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMPLAINT_CATEGORY.map((c) => (
                    <SelectItem key={c} value={c}>
                      {COMPLAINT_CATEGORY_LABELS[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">严重程度 *</label>
              <Select value={severity} onValueChange={(v) => v && setSeverity(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMPLAINT_SEVERITY.map((s) => (
                    <SelectItem key={s} value={s}>
                      {COMPLAINT_SEVERITY_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">客诉描述</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="详细描述客诉内容"
              rows={3}
            />
          </div>
          <div>
            <label className="text-sm font-medium">期望解决时间</label>
            <Input
              type="datetime-local"
              value={expectedResolutionAt}
              onChange={(e) => setExpectedResolutionAt(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={mutation.isPending || !title.trim()} className="w-full">
            {mutation.isPending ? "创建中..." : "创建客诉"}
          </Button>
        </form>
      </FormSheet>
    </>
  );
}
