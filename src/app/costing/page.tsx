"use client";

import { Suspense } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Calculator, BookOpen, ClipboardList, AlertCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { canAccessCosting } from "@/lib/role-guards";

export default function CostingPage() {
  return (
    <Suspense
      fallback={
        <PageShell>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64" />
        </PageShell>
      }
    >
      <CostingContent />
    </Suspense>
  );
}

function CostingContent() {
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
  if (!canAccessCosting(session.user.role)) {
    router.push("/dashboard");
    return null;
  }

  const quickActions = [
    {
      title: "成本台账",
      desc: "全部成本条目，支持桶/状态/来源筛选",
      icon: BookOpen,
      href: "/costing/ledger",
    },
    {
      title: "订单成本视图",
      desc: "按订单查看成本口径与毛利",
      icon: Calculator,
      href: "/costing/orders",
    },
    {
      title: "客户成本视图",
      desc: "按客户查看成本汇总",
      icon: ClipboardList,
      href: "/costing/customers",
    },
    {
      title: "成本规则",
      desc: "平台费、提成、流通成本规则（ADMIN）",
      icon: AlertCircle,
      href: "/costing/rules",
    },
  ];

  return (
    <PageShell>
      <PageHeader
        title="成本核算"
        description="成本明细台账、口径计算、毛利分析"
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
            <h3 className="text-sm font-medium">成本口径说明</h3>
          </div>
          <div className="mt-3 grid gap-3 text-xs text-muted-foreground md:grid-cols-3">
            <div>
              <strong className="text-foreground">真实成本（REAL）</strong>
              <p>供应商履约成本，来自锁定供应方案或手动录入。</p>
            </div>
            <div>
              <strong className="text-foreground">流通成本（CIRCULATION）</strong>
              <p>平台费、提成、人工、市场等经营成本。</p>
            </div>
            <div>
              <strong className="text-foreground">税费成本（TAX）</strong>
              <p>价税分离后的税费部分。</p>
            </div>
          </div>
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => router.push("/costing/ledger")}>
              进入成本台账
            </Button>
          </div>
        </Card>
      </div>
    </PageShell>
  );
}
