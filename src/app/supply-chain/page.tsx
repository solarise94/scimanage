"use client";

import { Suspense } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Truck, Users, FileText, ClipboardList, AlertCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { canAccessSupplyChain } from "@/lib/role-guards";

export default function SupplyChainPage() {
  return (
    <Suspense
      fallback={
        <PageShell>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64" />
        </PageShell>
      }
    >
      <SupplyChainContent />
    </Suspense>
  );
}

function SupplyChainContent() {
  const { data: session, status } = useSession();
  const router = useRouter();

  if (status === "loading") {
    return (
      <PageShell>
        <Skeleton className="h-8 w-48" />
      </PageShell>
    );
  }
  if (!session) {
    router.push("/login");
    return null;
  }
  if (!canAccessSupplyChain(session.user.role)) {
    router.push("/dashboard");
    return null;
  }

  const quickActions = [
    {
      title: "供应商管理",
      desc: "维护供应商档案、联系人、能力范围",
      icon: Users,
      href: "/supply-chain/suppliers",
    },
    {
      title: "报价表",
      desc: "供应商报价维护与导入",
      icon: FileText,
      href: "/supply-chain/quotes",
    },
    {
      title: "服务项字典",
      desc: "标准服务项与订单行映射",
      icon: ClipboardList,
      href: "/supply-chain/service-catalog",
    },
    {
      title: "比价工具",
      desc: "生成供应方案候选并锁定",
      icon: Truck,
      href: "/supply-chain/compare",
    },
  ];

  return (
    <PageShell>
      <PageHeader
        title="供应链管理"
        description="供应商档案、报价、询价、供应方案与采购分析"
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {quickActions.map((action) => (
          <Card
            key={action.href}
            className="cursor-pointer p-4 transition hover:shadow-md"
            onClick={() => router.push(action.href)}
          >
            <action.icon className="mb-2 h-6 w-6 text-primary" />
            <h3 className="text-sm font-medium">{action.title}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{action.desc}</p>
          </Card>
        ))}
      </div>

      <div className="mt-6">
        <Card className="p-4">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">供应链工作台</h3>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            工作台将展示待确认服务项映射、待比价订单、报价过期、采购集中度等运营指标。
            目前请通过上方快捷入口访问各功能模块。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => router.push("/supply-chain/plans")}>
              供应方案
            </Button>
            <Button variant="outline" size="sm" onClick={() => router.push("/supply-chain/inquiries")}>
              询价记录
            </Button>
          </div>
        </Card>
      </div>
    </PageShell>
  );
}
