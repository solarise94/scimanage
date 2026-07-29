"use client";

/**
 * 客服账号管理面板（ONLINE_OPS 门户 P1，设计 §10）。
 *
 * 列表 + 创建 + 停用/启用 + 改 owner（改 owner 需 ADMIN）。
 * 后端走 /api/online-ops/service-accounts；权限由 API 保证（ADMIN 全部 /
 * ONLINE_OPS USER 自己名下 / 其他部门 403）。
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Power, PowerOff } from "lucide-react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";

type ServiceAccount = {
  id: string;
  wechatId: string;
  name: string;
  department: string;
  ownerUserId: string;
  ownerName: string | null;
  ownerEmail: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

const QUERY_KEY = ["online-ops", "service-accounts"] as const;

export function OnlineOpsServiceAccountsPanel() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "ADMIN";

  const [dialogOpen, setDialogOpen] = useState(false);
  const [wechatId, setWechatId] = useState("");
  const [name, setName] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");

  const { data, isLoading } = useQuery<{ items: ServiceAccount[] }>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/online-ops/service-accounts");
      if (!res.ok) throw new Error("加载失败");
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async (input: { wechatId: string; name: string; ownerUserId: string }) => {
      const res = await fetch("/api/online-ops/service-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? "创建失败");
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("已创建客服账号");
      setDialogOpen(false);
      setWechatId("");
      setName("");
      setOwnerUserId("");
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const patchMutation = useMutation({
    mutationFn: async (input: { id: string; status?: string; ownerUserId?: string }) => {
      const res = await fetch(`/api/online-ops/service-accounts/${input.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? "更新失败");
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("已更新");
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const items = data?.items ?? [];

  const columns: DataTableColumn<ServiceAccount>[] = [
    { key: "wechatId", header: "微信ID", sortable: true },
    { key: "name", header: "名称", sortable: true },
    { key: "ownerName", header: "负责人", render: (r) => r.ownerName ?? "—" },
    {
      key: "status",
      header: "状态",
      render: (r) =>
        r.status === "ACTIVE" ? (
          <Badge>启用</Badge>
        ) : (
          <Badge variant="secondary">停用</Badge>
        ),
    },
    {
      key: "_actions",
      header: "操作",
      render: (r) => (
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            patchMutation.mutate({
              id: r.id,
              status: r.status === "ACTIVE" ? "DISABLED" : "ACTIVE",
            })
          }
          title={r.status === "ACTIVE" ? "停用" : "启用"}
        >
          {r.status === "ACTIVE" ? (
            <PowerOff className="h-4 w-4" />
          ) : (
            <Power className="h-4 w-4" />
          )}
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          管理网络运营客服微信账号（{items.length}）
        </p>
        <Button
          size="sm"
          onClick={() => {
            if (!isAdmin) setOwnerUserId(session?.user?.id ?? "");
            setDialogOpen(true);
          }}
        >
          <Plus className="h-4 w-4 mr-1" />
          新建客服账号
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={items}
        isLoading={isLoading}
        keyExtractor={(r) => r.id}
      />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建客服账号</DialogTitle>
            <DialogDescription>
              客服号归属网络运营部门；负责人必须属于网络运营部。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="sa-wechatId">微信ID</Label>
              <Input
                id="sa-wechatId"
                value={wechatId}
                onChange={(e) => setWechatId(e.target.value)}
                placeholder="如 wxid_xxx 或 微信号"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sa-name">名称</Label>
              <Input
                id="sa-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="客服昵称"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sa-owner">负责人 User ID</Label>
              <Input
                id="sa-owner"
                value={ownerUserId}
                onChange={(e) => setOwnerUserId(e.target.value)}
                placeholder="网络运营部成员的 User ID"
                disabled={!isAdmin}
              />
              {!isAdmin && (
                <p className="text-xs text-muted-foreground">
                  非 ADMIN 创建时负责人默认为当前用户。
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDialogOpen(false)}
            >
              取消
            </Button>
            <Button
              onClick={() =>
                createMutation.mutate({
                  wechatId: wechatId.trim(),
                  name: name.trim(),
                  ownerUserId: ownerUserId.trim(),
                })
              }
              disabled={
                createMutation.isPending ||
                !wechatId.trim() ||
                !name.trim() ||
                !ownerUserId.trim()
              }
            >
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
