"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { BellRing, Loader2 } from "lucide-react";

interface PushToFollowUpButtonProps {
  sourceType: "PROJECT_TICKET" | "TICKET_REPLY" | "PROJECT_COMMENT";
  sourceId: string;
  disabled?: boolean;
  disabledReason?: string;
}

export function PushToFollowUpButton({
  sourceType,
  sourceId,
  disabled,
  disabledReason,
}: PushToFollowUpButtonProps) {
  const [open, setOpen] = useState(false);
  const [dueDays, setDueDays] = useState(7);
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);

  const mutation = useMutation({
    mutationFn: async () => {
      const dueAt = new Date(Date.now() + dueDays * 24 * 60 * 60 * 1000).toISOString();
      const res = await fetch("/api/crm/follow-ups/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceType,
          sourceId,
          dueAt,
          note: note.trim() || undefined,
          notify,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "推送失败");
      return data;
    },
    onSuccess: (data: { message: string }) => {
      toast.success(data.message);
      setOpen(false);
      setNote("");
      setDueDays(7);
      setNotify(true);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setNote(""); setDueDays(7); } }}>
      <DialogTrigger render={<Button variant="ghost" size="sm" disabled={disabled} title={disabledReason} />}>
        <BellRing className="h-3.5 w-3.5 mr-1" />
        推送到代表跟进
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>推送到代表跟进任务</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            将此项推送给项目代表的 CRM 跟进任务列表。
          </p>
          <div className="space-y-2">
            <Label>截止天数</Label>
            <Input
              type="number"
              min={1}
              max={90}
              value={dueDays}
              onChange={(e) => setDueDays(Math.max(1, parseInt(e.target.value) || 1))}
            />
            <p className="text-xs text-muted-foreground">
              {dueDays} 天后截止
            </p>
          </div>
          <div className="space-y-2">
            <Label>备注（可选）</Label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="补充说明"
            />
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={notify}
              onChange={(e) => setNotify(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            同时发送站内通知
          </label>
          <Button
            className="w-full"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            确认推送
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
