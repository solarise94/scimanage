"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable, DataTableColumn } from "@/components/ui/data-table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectDisplay,
} from "@/components/ui/select";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";

interface BusinessEmailLogItem {
  id: string;
  type: string;
  toEmail: string;
  toName: string | null;
  ccEmails: string | null;
  subject: string;
  status: string;
  error: string | null;
  contactId: string | null;
  projectId: string | null;
  milestoneId: string | null;
  invoiceId: string | null;
  orderId: string | null;
  representativeId: string | null;
  createdAt: string;
}

interface LogResponse {
  logs: BusinessEmailLogItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// 类型 → 中文标签（外部收件人邮件 B/C/D/E/F/F2 + 下单代表通知 H）
const TYPE_LABELS: Record<string, string> = {
  MILESTONE_OVERDUE_NUDGE: "节点逾期催办",
  MILESTONE_MANUAL_NUDGE: "节点手动催办",
  MILESTONE_COMPLETED: "节点完成通知",
  INVOICE_REQUESTED: "发票申请提交",
  INVOICE_ADJUSTED: "发票冲红/重开",
  INVOICE_OVERDUE_NUDGE: "发票超期催办",
  ORDER_REP_NOTIFIED: "下单代表通知",
};

const TYPE_OPTIONS = Object.entries(TYPE_LABELS);

function typeLabel(t: string): string {
  return TYPE_LABELS[t] || t;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function BusinessEmailLogsPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery<LogResponse>({
    queryKey: ["business-email-logs", { typeFilter, statusFilter, search, page }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (typeFilter) params.set("type", typeFilter);
      if (statusFilter) params.set("status", statusFilter);
      if (search) params.set("search", search);
      params.set("page", String(page));
      const res = await fetch(`/api/admin/business-email-logs?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });

  if (status === "loading") return null;
  if (!session || session.user.role !== "ADMIN") {
    router.replace("/dashboard");
    return null;
  }

  const logs = data?.logs || [];
  const totalPages = data?.totalPages || 1;
  const total = data?.total || 0;

  const applySearch = () => {
    setPage(1);
    setSearch(searchInput.trim());
  };

  const StatusBadge = ({ s }: { s: string }) =>
    s === "sent" ? (
      <Badge variant="outline" className="text-[10px] border-success-border text-success">已发送</Badge>
    ) : (
      <Badge variant="outline" className="text-[10px] border-danger-border text-danger">失败</Badge>
    );

  const columns: DataTableColumn<BusinessEmailLogItem>[] = [
    { key: "createdAt", header: "时间", render: (l) => <span className="text-muted-foreground whitespace-nowrap">{fmtTime(l.createdAt)}</span> },
    { key: "type", header: "类型", render: (l) => <Badge variant="secondary" className="text-[10px]">{typeLabel(l.type)}</Badge> },
    {
      key: "recipient",
      header: "收件人",
      render: (l) => (
        <div className="flex flex-col">
          <span>{l.toName || "—"}</span>
          <span className="text-xs text-muted-foreground">{l.toEmail}</span>
          {l.ccEmails && <span className="text-[10px] text-muted-foreground">抄送: {l.ccEmails}</span>}
        </div>
      ),
    },
    { key: "subject", header: "主题", render: (l) => <span className="text-muted-foreground">{l.subject}</span> },
    {
      key: "orderId",
      header: "订单",
      render: (l) =>
        l.orderId ? (
          <a
            href={`/orders?focus=${l.orderId}`}
            className="text-xs text-primary underline-offset-2 hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            查看订单
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      key: "status",
      header: "状态",
      render: (l) => (
        <div className="flex flex-col gap-0.5">
          <StatusBadge s={l.status} />
          {l.error && <span className="text-[10px] text-danger max-w-[220px] truncate" title={l.error}>{l.error}</span>}
        </div>
      ),
    },
  ];

  const renderMobileCard = (l: BusinessEmailLogItem) => (
    <div className="rounded-lg border bg-card p-4 space-y-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge variant="secondary" className="text-[10px]">{typeLabel(l.type)}</Badge>
        <StatusBadge s={l.status} />
        <span className="ml-auto text-xs text-muted-foreground">{fmtTime(l.createdAt)}</span>
      </div>
      <div className="text-sm">{l.toName || "—"} <span className="text-muted-foreground">&lt;{l.toEmail}&gt;</span></div>
      {l.ccEmails && <div className="text-xs text-muted-foreground">抄送: {l.ccEmails}</div>}
      <div className="text-sm text-muted-foreground">{l.subject}</div>
      {l.orderId && (
        <a href={`/orders?focus=${l.orderId}`} className="text-xs text-primary underline-offset-2 hover:underline" target="_blank" rel="noreferrer">
          查看订单
        </a>
      )}
      {l.error && <div className="text-xs text-danger">{l.error}</div>}
    </div>
  );

  return (
    <PageShell>
      <PageHeader
        title="邮件发送历史"
        description="发往外部收件人（外部联系人/财务部）与下单代表的商务邮件记录（节点催办、完成通知、发票邮件、下单代表通知等）。发往系统内成员的提醒见站内通知中心。"
      />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Select value={typeFilter} onValueChange={(v) => { setPage(1); setTypeFilter(v === "__all__" ? "" : (v || "")); }}>
          <SelectTrigger className="w-[160px] h-9 text-xs">
            <SelectDisplay label="类型" valueLabel={typeFilter ? typeLabel(typeFilter) : "全部"} placeholder="类型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部类型</SelectItem>
            {TYPE_OPTIONS.map(([value, label]) => (
              <SelectItem key={value} value={value}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={(v) => { setPage(1); setStatusFilter(v === "__all__" ? "" : (v || "")); }}>
          <SelectTrigger className="w-[120px] h-9 text-xs">
            <SelectDisplay label="状态" valueLabel={statusFilter === "sent" ? "已发送" : statusFilter === "failed" ? "失败" : "全部"} placeholder="状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部状态</SelectItem>
            <SelectItem value="sent">已发送</SelectItem>
            <SelectItem value="failed">失败</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex items-center gap-1">
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") applySearch(); }}
            placeholder="搜索邮箱/名称/主题"
            className="h-9 text-sm w-[220px]"
          />
          <Button size="sm" variant="secondary" onClick={applySearch}>搜索</Button>
        </div>

        <span className="ml-auto text-xs text-muted-foreground">共 {total} 条</span>
      </div>

      <DataTable
        columns={columns}
        data={logs}
        keyExtractor={(l) => l.id}
        isLoading={isLoading}
        emptyTitle="暂无邮件发送记录"
        renderMobileCard={renderMobileCard}
      />

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</Button>
          <span className="text-xs text-muted-foreground">第 {page} / {totalPages} 页</span>
          <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>下一页</Button>
        </div>
      )}
    </PageShell>
  );
}
