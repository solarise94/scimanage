"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable } from "@/components/ui/data-table";
import { FinanceEmptyState } from "@/components/finance/finance-empty-state";
import { PageShell } from "@/components/ui/page-shell";
import { crmKeys } from "@/lib/crm/query-keys";
import type { OrganizationFinanceItem } from "@/lib/finance/collection-analysis";
import { DEFAULT_COLLECTION_WINDOW_MONTHS } from "@/lib/finance/collection-analysis";
import { formatCollectionCycle, formatCollectionRate } from "@/lib/finance/collection-display";
import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectDisplay } from "@/components/ui/select";
import { Button } from "@/components/ui/button";

export default function FinanceOrganizationsPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }
  if (!session) { router.push("/login"); return null; }
  if (session.user.role !== "ADMIN") { router.push("/finance"); return null; }

  return <FinanceOrganizationsList />;
}

function FinanceOrganizationsList() {
  const [sort, setSort] = useState("canonicalName");
  const [order, setOrder] = useState("asc");

  const params = new URLSearchParams({ sort, order });
  const { data, isLoading } = useQuery<{ organizations: OrganizationFinanceItem[] }>({
    queryKey: [...crmKeys.organizationFinance(), sort, order],
    queryFn: async () => {
      const res = await fetch(`/api/finance/organizations?${params}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });

  const organizations = data?.organizations ?? [];

  return (
    <PageShell>
      <PageHeader
        title="机构财务看板"
        description="按发票买方机构聚合的回款效率与达成度（仅 direct-order 发票回款）"
        backHref="/finance"
        backLabel="返回财务"
      />

      <div className="flex flex-wrap gap-2 items-center">
        <Select value={sort} onValueChange={(v) => setSort(v || "canonicalName")}>
          <SelectTrigger className="w-[140px] h-9 text-xs">
            <SelectDisplay label="排序" valueLabel={sortLabel(sort)} placeholder="排序" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="canonicalName">机构名称</SelectItem>
            <SelectItem value="avgCollectionCycleDays">回款周期</SelectItem>
            <SelectItem value="quarterlyReceiptRate">本季回款率</SelectItem>
            <SelectItem value="yearlyReceiptRate">本年回款率</SelectItem>
            <SelectItem value="pairCount">配对数</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" className="h-9 text-xs" onClick={() => setOrder(order === "asc" ? "desc" : "asc")}>
          {order === "asc" ? "↑" : "↓"}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin" /></div>
      ) : organizations.length === 0 ? (
        <FinanceEmptyState title="暂无机构回款数据" description="需发票录入买方机构且存在已配对回款" />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            回款率分子仅统计 direct-order 发票的已配对回款，分母为全部应收；覆盖多订单发票的回款暂无法精确分摊，故比率可能系统性偏低。统计范围为近 {DEFAULT_COLLECTION_WINDOW_MONTHS} 个月已配对回款。
          </p>
          <DataTable
          columns={[
            {
              key: "canonicalName",
              header: "机构",
              sortable: true,
              sortValue: (o) => o.canonicalName,
              render: (o) => (
                <div>
                  <div className="font-medium">{o.canonicalName}</div>
                  {o.orgCode && <div className="text-xs text-muted-foreground">{o.orgCode}</div>}
                </div>
              ),
            },
            {
              key: "avgCollectionCycleDays",
              header: "平均回款周期",
              align: "right",
              render: (o) => formatCollectionCycle(o.avgCollectionCycleDays, o.pairCount),
            },
            {
              key: "quarterlyReceiptRate",
              header: "本季回款率",
              align: "right",
              render: (o) => formatCollectionRate(
                o.quarterlyReceiptRate,
                o.quarterlyReceiptAmount,
                o.quarterlyReceivableAmount,
              ),
            },
            {
              key: "yearlyReceiptRate",
              header: "本年回款率",
              align: "right",
              render: (o) => formatCollectionRate(
                o.yearlyReceiptRate,
                o.yearlyReceiptAmount,
                o.yearlyReceivableAmount,
              ),
            },
          ]}
          data={organizations}
          keyExtractor={(o) => o.organizationId}
        />
        </>
      )}
    </PageShell>
  );
}

function sortLabel(sort: string): string {
  switch (sort) {
    case "avgCollectionCycleDays": return "回款周期";
    case "quarterlyReceiptRate": return "本季回款率";
    case "yearlyReceiptRate": return "本年回款率";
    case "pairCount": return "配对数";
    default: return "机构名称";
  }
}
