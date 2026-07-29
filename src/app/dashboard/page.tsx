"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { BusinessKpiRow, BusinessTrendCard, TodoReminderCard } from "@/components/dashboard/business-overview-section";
import { CrmActivityCard } from "@/components/dashboard/crm-activity-card";
import { ProjectStatusDonutCard, TicketTrendBarCard } from "@/components/dashboard/project-delivery-section";
import { fetchJsonOrThrow } from "@/lib/fetch-client";
import { cn } from "@/lib/utils";
import type { DashboardBusinessOverview } from "@/lib/dashboard/types";
import type { DashboardStats } from "@/lib/types";

function SectionError({ retry, title = "数据暂时无法加载" }: { retry: () => void; title?: string }) {
  return <div role="alert" className="rounded-lg border border-danger-border bg-danger-bg/20 p-4 text-sm"><p className="font-medium">{title}</p><p className="mt-1 text-muted-foreground">其他区域仍可正常使用。</p><Button variant="outline" size="sm" className="mt-3" onClick={retry}>重试</Button></div>;
}

function ChartErrorCard({ title, retry, className }: { title: string; retry: () => void; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent><SectionError retry={retry} /></CardContent>
    </Card>
  );
}

function KpiSkeleton() {
  return <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-32" />)}</div>;
}

function ChartSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn("h-[360px]", className)} />;
}

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  useEffect(() => { if (status === "unauthenticated") router.push("/login"); }, [status, router]);

  const businessQuery = useQuery<DashboardBusinessOverview>({
    queryKey: ["dashboard", "business-overview"],
    queryFn: () => fetchJsonOrThrow("/api/dashboard/business-overview"),
    enabled: status === "authenticated",
  });
  const projectQuery = useQuery<DashboardStats>({
    queryKey: ["dashboard", "stats"],
    queryFn: () => fetchJsonOrThrow("/api/dashboard/stats"),
    enabled: status === "authenticated",
  });

  if (status === "loading") {
    return (
      <PageShell>
        <KpiSkeleton />
        <div className="grid gap-4 lg:grid-cols-3">
          <ChartSkeleton className="lg:col-span-2" />
          <ChartSkeleton />
          <ChartSkeleton className="lg:col-span-2" />
          <ChartSkeleton />
        </div>
      </PageShell>
    );
  }
  if (!session) return null;
  const role = session.user.role;
  const business = businessQuery.data ?? null;
  const stats = projectQuery.data ?? null;

  return (
    <PageShell>
      <PageHeader title="仪表盘" description={`欢迎回来，${session.user.name}`} />

      {businessQuery.isLoading ? <KpiSkeleton /> : businessQuery.isError || !business ? <SectionError retry={() => void businessQuery.refetch()} /> : (
        <BusinessKpiRow data={business} role={role} retry={() => void businessQuery.refetch()} />
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {businessQuery.isLoading ? <ChartSkeleton className="lg:col-span-2" />
          : businessQuery.isError || !business ? <ChartErrorCard title="近 6 个月经营趋势" retry={() => void businessQuery.refetch()} className="lg:col-span-2" />
          : <BusinessTrendCard data={business} className="lg:col-span-2" />}

        {projectQuery.isLoading ? <ChartSkeleton />
          : projectQuery.isError || !stats ? <ChartErrorCard title="项目状态分布" retry={() => void projectQuery.refetch()} />
          : <ProjectStatusDonutCard stats={stats} />}

        {!businessQuery.isLoading && business?.crm.data ? (
          <CrmActivityCard crm={business.crm.data} className="lg:col-span-3" />
        ) : !businessQuery.isLoading && business?.crm.error ? (
          <ChartErrorCard title="近 6 个月客户与互动" retry={() => void businessQuery.refetch()} className="lg:col-span-3" />
        ) : null}

        {projectQuery.isLoading ? <ChartSkeleton className="lg:col-span-2" />
          : projectQuery.isError || !stats ? <ChartErrorCard title="近 7 天工单趋势" retry={() => void projectQuery.refetch()} className="lg:col-span-2" />
          : <TicketTrendBarCard stats={stats} className="lg:col-span-2" />}

        {businessQuery.isLoading ? <ChartSkeleton />
          : businessQuery.isError || !business ? <ChartErrorCard title="待办提醒" retry={() => void businessQuery.refetch()} />
          : <TodoReminderCard data={business} role={role} pendingTickets={stats?.pendingTickets} />}
      </div>
    </PageShell>
  );
}
