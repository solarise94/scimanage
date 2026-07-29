"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * 治理中心 UI 已退役：主数据治理链路收口完成后关闭入口。
 * API（/api/admin/governance/*）仍保留，供脚本/紧急运维调用；本页仅作关闭说明。
 */
export default function GovernanceHubRetiredPage() {
  const { status, data } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  if (status === "loading") {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full max-w-lg" />
      </div>
    );
  }

  if (status === "unauthenticated") return null;

  if (data?.user?.role !== "ADMIN") {
    router.push("/dashboard");
    return null;
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col items-start gap-4 p-6 sm:p-10">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <ShieldOff className="h-6 w-6 text-muted-foreground" />
      </div>
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">治理中心已关闭</h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          主数据治理链路（机构补绑 / 代表不一致 / 去重 / 订单补绑等）已完成收口，工作台入口已下线。
          如需紧急运维，请使用保留的管理 API 或联系开发处理。
        </p>
      </div>
      <Button variant="outline" onClick={() => router.push("/dashboard")}>
        返回工作台
      </Button>
    </div>
  );
}
