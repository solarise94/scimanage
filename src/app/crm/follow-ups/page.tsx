"use client";

import { Suspense } from "react";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FollowUpStatusBadge } from "@/components/crm/badges";
import { CrmEmptyState } from "@/components/crm/empty-state";
import type { CrmFollowUpTaskItem } from "@/lib/crm/types";
import { crmKeys } from "@/lib/crm/query-keys";
import { fetchJsonOrThrow } from "@/lib/fetch-client";
import { getBusinessDayWindow } from "@/lib/business-time";
import { toast } from "sonner";
import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";

export default function CrmFollowUpsPage() {
  const { status } = useSession();
  const router = useRouter();
  if (status === "unauthenticated") { router.push("/login"); return null; }
  if (status === "loading") return <PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>;
  return <Suspense fallback={<PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>}><FollowUpWorkbench /></Suspense>;
}

function FollowUpWorkbench() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const rawView = searchParams.get("view");
  const view = rawView === "today" || rawView === "overdue" ? rawView : "all";
  const mine = searchParams.get("mine") === "true";
  const followUpsUrl = `/api/crm/follow-ups?status=OPEN${mine ? "&mine=true" : ""}`;
  const { data, isLoading } = useQuery<{ tasks: CrmFollowUpTaskItem[] }>({ queryKey: [...crmKeys.followUps(), { mine }], queryFn: () => fetchJsonOrThrow(followUpsUrl) });
  const allTasks = data?.tasks || [];
  const completeMutation = useMutation({
    mutationFn: async (taskId: string) => fetchJsonOrThrow(`/api/crm/follow-ups/${taskId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "DONE" }) }),
    onSuccess: async (_data: unknown, taskId: string) => {
      toast.success("任务已完成");
      const task = allTasks.find((item) => item.id === taskId);
      const promises = [queryClient.invalidateQueries({ queryKey: crmKeys.followUps() }), queryClient.invalidateQueries({ queryKey: crmKeys.profiles() }), queryClient.invalidateQueries({ queryKey: crmKeys.myToday() }), queryClient.invalidateQueries({ queryKey: crmKeys.adminOverview() })];
      if (task?.profileId) promises.push(queryClient.invalidateQueries({ queryKey: crmKeys.profile(task.profileId) }));
      await Promise.all(promises);
    },
  });
  if (isLoading) return <PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>;
  const now = new Date();
  const day = getBusinessDayWindow(now);
  const tasks = allTasks.filter((task) => {
    const dueAt = new Date(task.dueAt);
    if (view === "today") return dueAt >= day.start && dueAt < day.end;
    if (view === "overdue") return dueAt < now;
    return true;
  });
  const overdue = view === "today" ? [] : tasks.filter((task) => new Date(task.dueAt) < now);
  const upcoming = view === "overdue"
    ? []
    : view === "today"
      ? tasks
      : tasks.filter((task) => new Date(task.dueAt) >= now);
  const title = view === "today" ? "今日到期任务" : view === "overdue" ? "逾期跟进任务" : "跟进工作台";
  return <PageShell><PageHeader title={title} />
    {overdue.length > 0 && <TaskGroup title={`已逾期 (${overdue.length})`} tasks={overdue} mutation={completeMutation} overdue />}
    {view !== "overdue" && <TaskGroup title={`${view === "today" ? "今日到期" : "待处理"} (${upcoming.length})`} tasks={upcoming} mutation={completeMutation} />}
    {tasks.length === 0 && <CrmEmptyState icon={ClipboardCheck} title={view === "today" ? "今日暂无到期任务" : view === "overdue" ? "暂无逾期任务" : "暂无待处理任务"} />}
  </PageShell>;
}

function TaskGroup({ title, tasks, mutation, overdue = false }: { title: string; tasks: CrmFollowUpTaskItem[]; mutation: { mutate: (id: string) => void; isPending: boolean }; overdue?: boolean }) {
  return <div><h2 className={overdue ? "mb-2 text-sm font-medium text-red-600" : "mb-2 text-sm font-medium text-muted-foreground"}>{title}</h2><div className="space-y-2">{tasks.map((task) => <TaskCard key={task.id} task={task} onComplete={() => mutation.mutate(task.id)} isPending={mutation.isPending} isOverdue={overdue} />)}</div></div>;
}
function TaskCard({ task, onComplete, isPending, isOverdue }: { task: CrmFollowUpTaskItem; onComplete: () => void; isPending: boolean; isOverdue?: boolean }) {
  return <Card className={isOverdue ? "border-l-4 border-l-red-500 border-red-200" : ""}><CardContent className="flex items-center justify-between gap-4 pt-4"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{task.title}</p><div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{task.profile && <Link href={`/crm/customers/${task.profile.id}`} className="text-primary hover:underline">{task.profile.name || "未命名客户"}</Link>}<span>截止: {new Date(task.dueAt).toLocaleString("zh-CN")}</span><span>{task.ownerUser.name}</span></div></div><div className="flex shrink-0 items-center gap-2"><FollowUpStatusBadge status={task.status} /><Button onClick={onComplete} disabled={isPending}>完成</Button></div></CardContent></Card>;
}
