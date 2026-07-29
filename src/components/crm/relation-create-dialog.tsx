"use client";

import { useState, useEffect } from "react";
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

export interface RelationCreatePrefill {
  profileId: string;
  customerName: string;
}

interface RelationCreateDialogProps {
  prefilledA?: RelationCreatePrefill | null;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function RelationCreateDialog({ prefilledA, trigger, open: controlledOpen, onOpenChange: controlledOnOpenChange }: RelationCreateDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  const setOpen = (v: boolean) => {
    if (isControlled) controlledOnOpenChange?.(v);
    else setInternalOpen(v);
  };

  const [customerAId, setCustomerAId] = useState(prefilledA?.profileId || "");
  const [customerAName, setCustomerAName] = useState(prefilledA?.customerName || "");
  const [customerBId, setCustomerBId] = useState("");
  const [customerBName, setCustomerBName] = useState("");
  const [type, setType] = useState("REFERRED");
  const [strength, setStrength] = useState("");
  const [notes, setNotes] = useState("");
  const [introducedAt, setIntroducedAt] = useState("");
  const queryClient = useQueryClient();

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (open && prefilledA) {
        setCustomerAId(prefilledA.profileId);
        setCustomerAName(prefilledA.customerName);
      }
      if (open && !prefilledA) {
        setCustomerAId("");
        setCustomerAName("");
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, prefilledA]);

  const isSymmetric = SYMMETRIC_RELATION_TYPES.has(type);

  const mutation = useMutation({
    mutationFn: async () => {
      let fromId: string, toId: string;
      if (isSymmetric) {
        [fromId, toId] = [customerAId, customerBId].sort();
      } else {
        fromId = customerAId;
        toId = customerBId;
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
        fromProfileId?: string | null;
        toProfileId?: string | null;
      };
    }) => {
      toast.success("关系已添加");
      const fromId = data.relation.fromProfileId ?? null;
      const toId = data.relation.toProfileId ?? null;
      await Promise.all([
        ...(fromId ? [queryClient.invalidateQueries({ queryKey: crmKeys.relations(fromId) })] : []),
        ...(toId ? [queryClient.invalidateQueries({ queryKey: crmKeys.relations(toId) })] : []),
        queryClient.invalidateQueries({ queryKey: crmKeys.relationsAll() }),
      ]);
      setOpen(false);
      resetForm();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function resetForm() {
    setCustomerAId("");
    setCustomerAName("");
    setCustomerBId("");
    setCustomerBName("");
    setType("REFERRED");
    setStrength("");
    setNotes("");
    setIntroducedAt("");
  }

  const canSubmit = customerAId && customerBId && customerAId !== customerBId;

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetForm(); }}>
      {!isControlled && (
        <DialogTrigger render={
          trigger
            ? (trigger as React.ReactElement)
            : <Button size="sm"><Plus className="h-4 w-4 mr-1" />添加关系</Button>
        }>
          {trigger ? trigger : undefined}
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader><DialogTitle>添加客户关系</DialogTitle></DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }} className="space-y-4">
          <div>
            <label className="text-sm font-medium">客户 A *</label>
            <CustomerSelect
              value={customerAId}
              displayValue={customerAName}
              onChange={(id, name) => { setCustomerAId(id || ""); setCustomerAName(name || ""); }}
              crmScopeOnly
            />
          </div>
          <div>
            <label className="text-sm font-medium">客户 B *</label>
            <CustomerSelect
              value={customerBId}
              displayValue={customerBName}
              onChange={(id, name) => { setCustomerBId(id || ""); setCustomerBName(name || ""); }}
              crmScopeOnly
            />
          </div>
          {customerAId && customerBId && customerAId === customerBId && (
            <p className="text-xs text-destructive">不能选择相同的客户</p>
          )}
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
            {isSymmetric && (
              <p className="text-xs text-muted-foreground mt-1">对称关系：A 与 B 方向相同</p>
            )}
            {!isSymmetric && customerAName && customerBName && (
              <p className="text-xs text-muted-foreground mt-1">{customerAName} → {customerBName}</p>
            )}
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
          <Button type="submit" disabled={mutation.isPending || !canSubmit} className="w-full">
            {mutation.isPending ? "保存中..." : "保存"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
