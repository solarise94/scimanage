"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, CheckCircle2, Link2 } from "lucide-react";
import { toast } from "sonner";

interface MappingPanelProps {
  orderId: string;
}

interface OrderLine {
  id: string;
  itemName: string;
  spec: string | null;
  quantity: number | null;
  unitPrice: number | null;
}

interface Mapping {
  id: string;
  orderLineId: string;
  serviceKey: string;
  confidence: number | null;
  source: string;
  confirmedById: string | null;
  confirmedAt: string | null;
  orderLine: { id: string; itemName: string; spec: string | null };
}

interface ServiceItem {
  serviceKey: string;
  name: string;
  active: boolean;
}

interface JoinedRow {
  line: OrderLine;
  mapping: Mapping | null;
}

export function OrderLineMappingPanel({ orderId }: MappingPanelProps) {
  const queryClient = useQueryClient();
  const [pendingMappings, setPendingMappings] = useState<Record<string, string>>({});
  // 已确认行进入编辑态时记录 editingLineId，点击「修改」显示 Select + 保存/取消
  const [editingLineId, setEditingLineId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["supply-mappings", orderId],
    queryFn: async () => {
      const res = await fetch(`/api/supply/order-line-mappings?orderId=${orderId}`);
      if (!res.ok) throw new Error("加载映射失败");
      return res.json();
    },
  });

  const { data: serviceData } = useQuery({
    queryKey: ["supply", "service-catalog"],
    queryFn: async () => {
      const res = await fetch("/api/supply/service-catalog");
      if (!res.ok) throw new Error("加载服务项失败");
      return res.json();
    },
  });

  const upsertMutation = useMutation({
    mutationFn: async (params: { orderLineId: string; serviceKey: string }) => {
      const res = await fetch("/api/supply/order-line-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderLineId: params.orderLineId,
          serviceKey: params.serviceKey,
          source: "MANUAL",
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "映射失败");
      }
      return res.json();
    },
    onSuccess: async () => {
      toast.success("服务项映射已更新");
      await queryClient.invalidateQueries({ queryKey: ["supply-mappings", orderId] });
      setEditingLineId(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const orderLines: OrderLine[] = data?.orderLines || [];
  const mappings: Mapping[] = data?.mappings || [];
  const services: ServiceItem[] = (serviceData?.items || []).filter((s: ServiceItem) => s.active !== false);

  // left join: orderLine 为左表，附 optional mapping
  const mappingByLineId = new Map<string, Mapping>();
  for (const m of mappings) mappingByLineId.set(m.orderLineId, m);

  const rows: JoinedRow[] = orderLines.map((line) => ({
    line,
    mapping: mappingByLineId.get(line.id) ?? null,
  }));

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="pt-4 text-sm text-muted-foreground text-center py-6">
          该订单暂无订单行。请先在订单明细中添加订单行，再为每个订单行映射标准服务项。
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {rows.map(({ line, mapping }) => {
        const service = mapping ? services.find((s) => s.serviceKey === mapping.serviceKey) : null;
        const confirmed = !!mapping?.confirmedAt;
        // 已确认行点击「修改」进入编辑态，显示 Select + 保存/取消；
        // 未确认/未映射行始终保持内联 Select。
        const isEditingConfirmed = confirmed && editingLineId === line.id;
        const showInlineSelect = !confirmed || isEditingConfirmed;
        const chosenKey = pendingMappings[line.id] || mapping?.serviceKey || "";

        return (
          <Card key={line.id}>
            <CardContent className="pt-3 pb-3 flex items-center gap-3 flex-wrap">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{line.itemName}</p>
                {line.spec && <p className="text-xs text-muted-foreground truncate">{line.spec}</p>}
              </div>
              <div className="flex items-center gap-2">
                {showInlineSelect ? (
                  <>
                    <Select
                      value={chosenKey}
                      onValueChange={(v) => v && setPendingMappings((prev) => ({ ...prev, [line.id]: v }))}
                    >
                      <SelectTrigger className="w-48 h-8 text-xs">
                        <SelectValue placeholder="选择服务项" />
                      </SelectTrigger>
                      <SelectContent>
                        {services.map((s) => (
                          <SelectItem key={s.serviceKey} value={s.serviceKey}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs"
                      onClick={() => {
                        if (!chosenKey) {
                          toast.error("请先选择服务项");
                          return;
                        }
                        upsertMutation.mutate({ orderLineId: line.id, serviceKey: chosenKey });
                      }}
                      disabled={upsertMutation.isPending}
                    >
                      <Link2 className="h-3 w-3 mr-1" />
                      {isEditingConfirmed ? "保存" : mapping ? "确认" : "映射"}
                    </Button>
                    {isEditingConfirmed && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 text-xs text-muted-foreground"
                        onClick={() => {
                          setEditingLineId(null);
                          setPendingMappings((prev) => {
                            const next = { ...prev };
                            delete next[line.id];
                            return next;
                          });
                        }}
                        disabled={upsertMutation.isPending}
                      >
                        取消
                      </Button>
                    )}
                  </>
                ) : (
                  <>
                    <Badge variant="outline">{service?.name || mapping!.serviceKey}</Badge>
                    {mapping!.confidence != null && (
                      <span className="text-xs text-muted-foreground">{Math.round(mapping!.confidence * 100)}%</span>
                    )}
                    <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 text-xs text-muted-foreground"
                      onClick={() => {
                        // 进入编辑态时把当前值预填到 pending，保证 Select 显示当前选项
                        setPendingMappings((prev) => ({ ...prev, [line.id]: mapping!.serviceKey }));
                        setEditingLineId(line.id);
                      }}
                      disabled={upsertMutation.isPending}
                    >
                      <Link2 className="h-3 w-3 mr-1" />
                      修改
                    </Button>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
