"use client";

import { useState } from "react";
import { FormSheet } from "@/components/ui/form-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { crmKeys } from "@/lib/crm/query-keys";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { CRM_FOLLOW_UP_TASK_TYPES, FOLLOW_UP_TASK_TYPE_LABELS } from "@/lib/crm/constants";

export function FollowUpFormDialog({ profileId, profileName, startOpen, onClose }: { profileId: string; profileName?: string; startOpen?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(startOpen || false);
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [taskType, setTaskType] = useState<string>("CONTACT");
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/crm/follow-ups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId, title, dueAt, taskType }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "创建失败");
      }
      return res.json();
    },
    onSuccess: async () => {
      toast.success("跟进任务已创建");
      const promises: Promise<void>[] = [
        queryClient.invalidateQueries({ queryKey: crmKeys.followUps() }),
        queryClient.invalidateQueries({ queryKey: crmKeys.profiles() }),
        queryClient.invalidateQueries({ queryKey: crmKeys.myToday() }),
        queryClient.invalidateQueries({ queryKey: crmKeys.adminOverview() }),
      ];
      promises.push(queryClient.invalidateQueries({ queryKey: crmKeys.profile(profileId) }));
      await Promise.all(promises);
      setOpen(false);
      setTitle("");
      setDueAt("");
      setTaskType("CONTACT");
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
        <Plus className="h-4 w-4 mr-1" />新建跟进
      </Button>
      <FormSheet open={open} onOpenChange={handleOpenChange} title={`新建跟进任务${profileName ? ` - ${profileName}` : ""}`} desktopVariant="plain">
        <form onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }} className="space-y-4">
          <div>
            <label className="text-sm font-medium">任务类型</label>
            <div className="flex gap-2 mt-1">
              {CRM_FOLLOW_UP_TASK_TYPES.map((t) => (
                <Button
                  key={t}
                  type="button"
                  size="sm"
                  variant={taskType === t ? "default" : "outline"}
                  onClick={() => setTaskType(t)}
                >
                  {FOLLOW_UP_TASK_TYPE_LABELS[t]}
                </Button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">任务标题 *</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="例如：确认样品需求" />
          </div>
          <div>
            <label className="text-sm font-medium">截止时间 *</label>
            <Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} required />
          </div>
          <Button type="submit" disabled={mutation.isPending || !title || !dueAt} className="w-full">
            {mutation.isPending ? "创建中..." : "创建"}
          </Button>
        </form>
      </FormSheet>
    </>
  );
}
