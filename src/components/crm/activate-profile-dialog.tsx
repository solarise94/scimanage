"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { crmKeys } from "@/lib/crm/query-keys";
import { toast } from "sonner";
import { UserPlus } from "lucide-react";
import { CRM_STAGES, STAGE_LABELS, CRM_IMPORTANCE, IMPORTANCE_LABELS } from "@/lib/crm/constants";

interface AssigneeOption {
  userId: string;
  name: string;
  email: string;
  kind: "self" | "representative";
}

export function ActivateProfileDialog() {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [organization, setOrganization] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [stage, setStage] = useState("LEAD");
  const [importance, setImportance] = useState("NORMAL");
  const queryClient = useQueryClient();
  const canAssign = session?.user?.role !== "REPRESENTATIVE";

  const { data: assigneesData } = useQuery<{ assignees: AssigneeOption[] }>({
    queryKey: ["crm-assignees"],
    queryFn: async () => {
      const res = await fetch("/api/crm/assignees");
      return res.json();
    },
    enabled: open && canAssign,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, string> = { name: name.trim(), stage, importance };
      if (organization.trim()) payload.organization = organization.trim();
      if (ownerUserId) payload.ownerUserId = ownerUserId;
      const res = await fetch("/api/crm/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "操作失败");
      }
      return res.json();
    },
    onSuccess: async () => {
      toast.success("CRM 客户已创建");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: crmKeys.profiles() }),
        queryClient.invalidateQueries({ queryKey: crmKeys.myToday() }),
        queryClient.invalidateQueries({ queryKey: crmKeys.adminOverview() }),
        queryClient.invalidateQueries({ queryKey: crmKeys.customersForCrm() }),
      ]);
      setOpen(false);
      setName("");
      setOrganization("");
      setOwnerUserId("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const assignees = assigneesData?.assignees || [];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <UserPlus className="h-4 w-4 mr-1" />新建 CRM 客户
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>新建 CRM 客户</DialogTitle></DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }} className="space-y-4">
          <div>
            <label className="text-sm font-medium">客户姓名 *</label>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="请输入客户姓名" />
          </div>
          <div>
            <label className="text-sm font-medium">机构</label>
            <Input value={organization} onChange={(event) => setOrganization(event.target.value)} placeholder="选填" />
          </div>
          {canAssign && (
            <div>
              <label className="text-sm font-medium">指派负责人</label>
              <Select value={ownerUserId} onValueChange={(v) => setOwnerUserId(v || "")}>
                <SelectTrigger>
                  {ownerUserId
                    ? <span>{assignees.find((a) => a.userId === ownerUserId)?.name || ownerUserId}</span>
                    : <span className="text-muted-foreground">请选择负责人</span>}
                </SelectTrigger>
                <SelectContent>
                  {assignees.map((a) => (
                    <SelectItem key={a.userId} value={a.userId}>
                      {a.name}{a.kind === "representative" ? " (代表)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">阶段</label>
              <Select value={stage} onValueChange={(v) => setStage(v || "LEAD")}>
                <SelectTrigger>
                  <SelectValue>{STAGE_LABELS[stage] || stage}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CRM_STAGES.map((s) => (
                    <SelectItem key={s} value={s}>{STAGE_LABELS[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">重要度</label>
              <Select value={importance} onValueChange={(v) => setImportance(v || "NORMAL")}>
                <SelectTrigger>
                  <SelectValue>{IMPORTANCE_LABELS[importance] || importance}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CRM_IMPORTANCE.map((i) => (
                    <SelectItem key={i} value={i}>{IMPORTANCE_LABELS[i]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button type="submit" disabled={mutation.isPending || !name.trim() || (canAssign && !ownerUserId)} className="w-full">
            {mutation.isPending ? "创建中..." : "创建客户"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
