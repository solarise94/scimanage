"use client";

/**
 * 跨部门公海共享开关（设计 §10 表格第一行 / §4.5）。
 *
 * 嵌入客户详情页的轻量组件，不重写详情页结构。
 * - ONLINE_OPS 门户：开关「共享到地推公海」（targetDepartment=FIELD_SALES）。
 * - FIELD_SALES 门户：开关「共享到网络运营公海」（targetDepartment=ONLINE_OPS）。
 *
 * 行为：
 * - 调 PUT /api/crm/profiles/[id]/pool-sharing（D3 契约）。
 * - 只展示本部门发出的授权状态（默认关闭）。
 * - 不展示对方是否已认领、负责人或业务数量（脱敏契约）。
 *
 * Portal code 由构建期内联的 NEXT_PUBLIC_PORTAL_CODE 决定，未设时按 session.department 推断。
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { getClientPortalCode } from "@/lib/portal/client-config";

function targetDepartmentFor(): string {
  const code = getClientPortalCode();
  return code === "ONLINE_OPS" ? "FIELD_SALES" : "ONLINE_OPS";
}

function labelFor(): string {
  const code = getClientPortalCode();
  return code === "ONLINE_OPS" ? "共享到地推公海" : "共享到网络运营公海";
}

export function CrossDepartmentPoolShareToggle({
  profileId,
  initialShared = false,
}: {
  profileId: string;
  /** 本部门对该目标部门发出的授权初始状态；调用方按本部门视图填充，默认关闭。 */
  initialShared?: boolean;
}) {
  const [shared, setShared] = useState(initialShared);
  const target = targetDepartmentFor();

  const mutation = useMutation({
    mutationFn: async (next: boolean) => {
      const res = await fetch(`/api/crm/profiles/${profileId}/pool-sharing`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetDepartment: target,
          shared: next,
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? "更新共享状态失败");
      }
      return res.json();
    },
    onSuccess: (_data, next) => {
      setShared(next);
      toast.success(next ? "已共享到对方公海" : "已撤回共享");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="flex items-center gap-2 rounded-lg border p-3">
      <Share2 className="h-4 w-4 text-muted-foreground" />
      <span className="text-sm font-medium">{labelFor()}</span>
      {shared ? (
        <Badge>已共享</Badge>
      ) : (
        <Badge variant="secondary">未共享</Badge>
      )}
      <Button
        size="sm"
        variant={shared ? "outline" : "default"}
        disabled={mutation.isPending}
        onClick={() => mutation.mutate(!shared)}
        className="ml-auto"
      >
        {shared ? "撤回共享" : "开启共享"}
      </Button>
      {shared && (
        <span className="text-xs text-muted-foreground">
          （对方可见脱敏公海信息；不暴露对方认领/业务状态）
        </span>
      )}
    </div>
  );
}
