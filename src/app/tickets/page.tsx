"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Ticket, Filter, ExternalLink, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { TicketItem } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectDisplay, SelectItem, SelectTrigger } from "@/components/ui/select";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";

const PAGE_SIZE = 20;

const PRIORITY_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  LOW: { label: "低", variant: "secondary" },
  MEDIUM: { label: "中", variant: "default" },
  HIGH: { label: "高", variant: "destructive" },
  URGENT: { label: "紧急", variant: "destructive" },
};

const STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  OPEN: { label: "打开", variant: "secondary" },
  IN_PROGRESS: { label: "处理中", variant: "default" },
  CLOSED: { label: "已关闭", variant: "outline" },
};

export default function TicketsPage() {
  const { status } = useSession();
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const TICKET_STATUS_LABELS: Record<string, string> = { ALL: "全部状态", OPEN: "打开", IN_PROGRESS: "处理中", CLOSED: "已关闭" };

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading } = useQuery<{
    tickets: TicketItem[];
    total: number;
    totalPages: number;
    page: number;
    pageSize: number;
  }>({
    queryKey: ["tickets", statusFilter, debouncedSearch, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      if (debouncedSearch) params.set("search", debouncedSearch);
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));
      const res = await fetch(`/api/tickets?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load tickets");
      return res.json();
    },
    enabled: status === "authenticated",
  });

  if (status === "loading") return null;

  const tickets = data?.tickets || [];
  const totalPages = data?.totalPages || 1;

  return (
    <PageShell>
      <PageHeader
        title="工单"
        description="跟踪项目中的任务与问题"
      />

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="搜索工单标题或描述..."
            className="pl-9"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v || "ALL"); setPage(1); }}>
            <SelectTrigger className="w-[140px]">
              <SelectDisplay label="状态" valueLabel={TICKET_STATUS_LABELS[statusFilter]} placeholder="全部状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部状态</SelectItem>
              <SelectItem value="OPEN">打开</SelectItem>
              <SelectItem value="IN_PROGRESS">处理中</SelectItem>
              <SelectItem value="CLOSED">已关闭</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : tickets.length === 0 ? (
        <EmptyState
          icon={Ticket}
          title="暂无工单"
        />
      ) : (
        <div className="space-y-3">
          {tickets.map((ticket) => (
            <Card
              key={ticket.id}
              className="hover:shadow-sm transition-shadow cursor-pointer hover:border-primary/50"
              onClick={() => router.push(`/tickets/${ticket.id}`)}
            >
              <CardContent className="p-4">
                <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-medium">{ticket.title}</h3>
                      <Badge variant={PRIORITY_CONFIG[ticket.priority]?.variant || "secondary"}>
                        {PRIORITY_CONFIG[ticket.priority]?.label || ticket.priority}
                      </Badge>
                      <Badge variant={STATUS_CONFIG[ticket.status]?.variant || "secondary"}>
                        {STATUS_CONFIG[ticket.status]?.label || ticket.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground flex-wrap">
                      <span>项目: {ticket.project?.name || "-"}</span>
                      {ticket.assignee && <span>负责人: {ticket.assignee.name}</span>}
                    </div>
                  </div>
                  {ticket.project?.id && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        router.push(`/projects/${ticket.project!.id}?tab=tickets`);
                      }}
                    >
                      <ExternalLink className="h-4 w-4 mr-1" />打开项目
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="h-4 w-4 mr-1" />上一页
          </Button>
          <span className="text-sm text-muted-foreground">第 {page} / {totalPages} 页</span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            下一页<ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      )}
    </PageShell>
  );
}
