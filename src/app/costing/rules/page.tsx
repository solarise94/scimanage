"use client";

import { Suspense } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Settings2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

interface CostEntry {
  id: string;
  bucket: string;
  costType: string;
  amount: number;
  sourceType: string;
}

const RULE_TYPE_NOTES: Array<{ type: string; bucket: string; desc: string }> = [
  { type: "平台费", bucket: "CIRCULATION / PLATFORM_FEE", desc: "按订单收入 × 费率，或固定手续费。" },
  { type: "提成", bucket: "CIRCULATION / COMMISSION", desc: "FinanceCommission 或 Order.commissionPaid 映射。" },
  { type: "流通成本", bucket: "CIRCULATION / 其他", desc: "人工、市场等经营成本，按 CIRCULATION_RULE 推导。" },
];

export default function CostRulesPage() {
  return (
    <Suspense
      fallback={
        <PageShell>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64" />
        </PageShell>
      }
    >
      <CostRulesContent />
    </Suspense>
  );
}

function CostRulesContent() {
  const { data: session, status } = useSession();
  const router = useRouter();

  // 暂无专用规则列表 API，先用 entries?sourceType=CIRCULATION_RULE 占位
  const { isLoading, data } = useQuery<{ entries: CostEntry[] }>({
    queryKey: ["costing", "entries", "circulation-rule-preview"],
    queryFn: async () => {
      const res = await fetch(`/api/costing/entries?sourceType=CIRCULATION_RULE&pageSize=100`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "加载失败");
      return json;
    },
    enabled: status === "authenticated",
  });

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
  if (session.user.role !== "ADMIN") {
    router.push("/dashboard");
    return null;
  }

  const entries = data?.entries ?? [];
  const ruleDrivenTotal = entries.reduce((sum, e) => sum + e.amount, 0);

  return (
    <PageShell>
      <PageHeader
        title="成本规则管理"
        description="平台费、提成、流通成本等规则来源（仅 ADMIN）"
        backHref="/costing"
        backLabel="返回成本核算"
      />

      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">规则说明</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            成本规则暂无独立的规则管理 API；下方列出 COST_RULE 主要类型及其映射口径，
            供核查规则驱动生成的成本条目使用。
          </p>
          <div className="space-y-3">
            {RULE_TYPE_NOTES.map((r) => (
              <div key={r.type} className="flex flex-col gap-1 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <span className="text-sm font-medium">{r.type}</span>
                  <p className="text-xs text-muted-foreground">{r.desc}</p>
                </div>
                <Badge variant="outline">{r.bucket}</Badge>
              </div>
            ))}
          </div>
          <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
            Phase 2.5 规则管理 UI 待上线。届时将支持在线配置费率、启用/停用规则与回溯重算。
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">规则驱动成本预览</h3>
            <span className="text-xs text-muted-foreground">
              sourceType = CIRCULATION_RULE · 共 {entries.length} 条
            </span>
          </div>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : entries.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              暂无规则驱动的流通成本条目
            </p>
          ) : (
            <div className="space-y-2">
              {entries.slice(0, 10).map((e) => (
                <div key={e.id} className="flex items-center justify-between text-sm border-b pb-2 last:border-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge variant="outline">{e.costType}</Badge>
                    <span className="text-xs text-muted-foreground truncate">{e.bucket}</span>
                  </div>
                  <span className="tabular-nums">¥{e.amount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              ))}
              <div className="flex items-center justify-between pt-1 text-sm">
                <span className="text-muted-foreground">合计（全部 {entries.length} 条）</span>
                <span className="font-medium tabular-nums">
                  ¥{ruleDrivenTotal.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}
