"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CustomerSelect } from "@/components/customer-select";
import { CRM_RELATION_TYPES, RELATION_TYPE_LABELS, CRM_RELATION_STRENGTHS, RELATION_STRENGTH_LABELS, SYMMETRIC_RELATION_TYPES } from "@/lib/crm/constants";
import { crmKeys } from "@/lib/crm/query-keys";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus } from "lucide-react";

interface Props {
  currentProfileId: string;
  currentCustomerName: string;
}

export function RelationFormDialog({ currentProfileId, currentCustomerName }: Props) {
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<"from" | "to">("from");
  const [targetProfileId, setTargetProfileId] = useState("");
  const [targetCustomerName, setTargetCustomerName] = useState("");
  const [type, setType] = useState("REFERRED");
  const [strength, setStrength] = useState("");
  const [notes, setNotes] = useState("");
  const [introducedAt, setIntroducedAt] = useState("");
  const queryClient = useQueryClient();

  const isSymmetric = SYMMETRIC_RELATION_TYPES.has(type);

  const mutation = useMutation({
    mutationFn: async () => {
      let fromId: string, toId: string;
      if (isSymmetric) {
        [fromId, toId] = [currentProfileId, targetProfileId].sort();
      } else {
        fromId = direction === "from" ? currentProfileId : targetProfileId;
        toId = direction === "from" ? targetProfileId : currentProfileId;
      }
      const res = await fetch("/api/crm/relations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromProfileId: fromId,
          toProfileId: toId,
          type,
          strength: strength || undefined,
          notes: notes || undefined,
          introducedAt: introducedAt || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "创建失败");
      }
      return res.json();
    },
    onSuccess: async (data: {
      relation: {
        fromProfileId: string;
        toProfileId: string;
      };
    }) => {
      toast.success("关系已添加");
      queryClient.setQueryData(
        crmKeys.relations(currentProfileId),
        (old: { relations: unknown[] } | undefined) =>
          old ? { relations: [data.relation, ...old.relations] } : undefined,
      );
      const fromId = data.relation.fromProfileId;
      const toId = data.relation.toProfileId;
      const otherId = fromId === currentProfileId ? toId : fromId;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: crmKeys.relations(currentProfileId) }),
        queryClient.invalidateQueries({ queryKey: crmKeys.relations(otherId) }),
        queryClient.invalidateQueries({ queryKey: crmKeys.relationsAll() }),
      ]);
      setOpen(false);
      resetForm();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function resetForm() {
    setTargetProfileId("");
    setTargetCustomerName("");
    setType("REFERRED");
    setStrength("");
    setNotes("");
    setIntroducedAt("");
    setDirection("from");
  }

  const directionLabel = direction === "from"
    ? `${currentCustomerName} → 对方`
    : `对方 → ${currentCustomerName}`;

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetForm(); }}>
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="h-4 w-4 mr-1" />添加关系
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>添加客户关系</DialogTitle></DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }} className="space-y-4">
          {!isSymmetric && (
            <div>
              <label className="text-sm font-medium">方向</label>
              <Select value={direction} onValueChange={(v) => setDirection((v as "from" | "to") || "from")}>
                <SelectTrigger>
                  <SelectValue>
                    {direction === "to" ? `对方 → ${currentCustomerName}` : `${currentCustomerName} → 对方`}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="from">{currentCustomerName} → 对方</SelectItem>
                  <SelectItem value="to">对方 → {currentCustomerName}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">{directionLabel}</p>
            </div>
          )}
          <div>
            <label className="text-sm font-medium">对方客户 *</label>
            <CustomerSelect
              value={targetProfileId}
              displayValue={targetCustomerName || undefined}
              onChange={(id, name) => { setTargetProfileId(id || ""); setTargetCustomerName(name || ""); }}
              crmScopeOnly
            />
          </div>
          <div>
            <label className="text-sm font-medium">关系类型 *</label>
            <Select value={type} onValueChange={(v) => setType(v || "REFERRED")}>
              <SelectTrigger>
                <SelectValue>{RELATION_TYPE_LABELS[type] || type}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {CRM_RELATION_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>{RELATION_TYPE_LABELS[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-sm font-medium">关系强度</label>
            <Select value={strength} onValueChange={(v) => setStrength(v || "")}>
              <SelectTrigger>
                <SelectValue placeholder="选择强度（可选）">
                  {strength ? RELATION_STRENGTH_LABELS[strength] || strength : "选择强度（可选）"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {CRM_RELATION_STRENGTHS.map((s) => (
                  <SelectItem key={s} value={s}>{RELATION_STRENGTH_LABELS[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-sm font-medium">介绍/建立时间</label>
            <Input type="date" value={introducedAt} onChange={(e) => setIntroducedAt(e.target.value)} />
          </div>
          <div>
            <label className="text-sm font-medium">备注</label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="关系备注（可选）" />
          </div>
          <Button type="submit" disabled={mutation.isPending || !targetProfileId} className="w-full">
            {mutation.isPending ? "保存中..." : "保存"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
