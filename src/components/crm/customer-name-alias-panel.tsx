"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { crmKeys } from "@/lib/crm/query-keys";
import { CrmEmptyState } from "@/components/crm/empty-state";
import { toast } from "sonner";
import { Tag, Plus, Ban } from "lucide-react";
import { isAdmin } from "@/lib/role-guards";

interface CustomerNameAliasPanelProps {
  profileId: string;
}

interface NameAliasItem {
  id: string;
  profileId: string;
  alias: string;
  aliasType: string;
  sourceType: string;
  active: boolean;
  createdById: string | null;
  createdAt: string;
}

const ALIAS_TYPE_LABELS: Record<string, string> = {
  COMMON: "常用称呼",
  FORMER_NAME: "曾用名",
  MERGED_NAME: "合并姓名",
};

const ALIAS_TYPE_COLORS: Record<string, string> = {
  COMMON: "bg-blue-100 text-blue-700",
  FORMER_NAME: "bg-amber-100 text-amber-700",
  MERGED_NAME: "bg-purple-100 text-purple-700",
};

export function CustomerNameAliasPanel({ profileId }: CustomerNameAliasPanelProps) {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const [newAlias, setNewAlias] = useState("");
  const [newAliasType, setNewAliasType] = useState<string>("COMMON");

  const { data, isLoading } = useQuery<{ aliases: NameAliasItem[] }>({
    queryKey: crmKeys.nameAliases(profileId),
    queryFn: async () => {
      const res = await fetch(`/api/crm/profiles/${profileId}/name-aliases`);
      if (!res.ok) throw new Error("加载称呼失败");
      return res.json();
    },
  });

  const aliases = data?.aliases || [];
  const activeAliases = aliases.filter((a) => a.active);
  const inactiveAliases = aliases.filter((a) => !a.active);

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/crm/profiles/${profileId}/name-aliases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: newAlias, aliasType: newAliasType }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "添加失败");
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: crmKeys.nameAliases(profileId) });
      setNewAlias("");
      setNewAliasType("COMMON");
      if (data.reused) {
        toast.success("该称呼已存在，已复用");
      } else {
        toast.success("称呼已添加");
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deactivateMutation = useMutation({
    mutationFn: async (aliasId: string) => {
      const res = await fetch(`/api/crm/name-aliases/${aliasId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "停用失败");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: crmKeys.nameAliases(profileId) });
      toast.success("已停用");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const admin = isAdmin(session?.user?.role);
  // 后端允许任何通过 Profile access guard 的用户新增 COMMON 称呼（docs §11.1）。
  // 面板只在有 Profile 访问权限时渲染，因此所有已登录用户均可添加。
  const canAdd = !!session?.user;

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium flex items-center gap-1.5">
            <Tag className="h-4 w-4" />
            常用称呼 / 历史姓名
          </h3>
          <span className="text-xs text-muted-foreground">{activeAliases.length} 个</span>
        </div>

        {canAdd && (
          <div className="flex gap-2">
            <Input
              value={newAlias}
              onChange={(e) => setNewAlias(e.target.value)}
              placeholder="输入称呼，如：张老师"
              className="flex-1"
              onKeyDown={(e) => {
                if (e.key === "Enter" && newAlias.trim()) {
                  createMutation.mutate();
                }
              }}
            />
            <Select value={newAliasType} onValueChange={(v) => setNewAliasType(v ?? "COMMON")}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="COMMON">常用称呼</SelectItem>
                <SelectItem value="FORMER_NAME">曾用名</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={!newAlias.trim() || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        )}

        {activeAliases.length === 0 && !isLoading && (
          <CrmEmptyState
            icon={Tag}
            title="暂无称呼变体"
            description="客户合并后会自动沉淀历史姓名；也可手动添加常用称呼。"
          />
        )}

        <div className="flex flex-wrap gap-2">
          {activeAliases.map((a) => {
            const isSystem = a.sourceType === "CUSTOMER_MERGE";
            const canEdit = admin || (a.createdById === session?.user?.id && !isSystem);
            return (
              <div
                key={a.id}
                className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-sm"
              >
                <span>{a.alias}</span>
                <Badge variant="secondary" className={`text-xs ${ALIAS_TYPE_COLORS[a.aliasType] || ""}`}>
                  {ALIAS_TYPE_LABELS[a.aliasType] || a.aliasType}
                </Badge>
                {isSystem && (
                  <span className="text-xs text-muted-foreground">来自合并</span>
                )}
                {canEdit && (
                  <button
                    onClick={() => deactivateMutation.mutate(a.id)}
                    disabled={deactivateMutation.isPending}
                    className="text-muted-foreground hover:text-destructive"
                    title="停用"
                  >
                    <Ban className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {inactiveAliases.length > 0 && (
          <div className="border-t pt-3 space-y-2">
            <p className="text-xs text-muted-foreground">已停用称呼（{inactiveAliases.length}）</p>
            <div className="flex flex-wrap gap-2">
              {inactiveAliases.map((a) => (
                <span
                  key={a.id}
                  className="inline-flex items-center gap-1 rounded-full border bg-muted px-2.5 py-1 text-sm text-muted-foreground line-through"
                >
                  {a.alias}
                  <Badge variant="secondary" className="text-xs">
                    {ALIAS_TYPE_LABELS[a.aliasType] || a.aliasType}
                  </Badge>
                </span>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
