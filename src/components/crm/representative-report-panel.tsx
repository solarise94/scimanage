"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { crmKeys } from "@/lib/crm/query-keys";
import type { CrmRepresentativeReport, CrmReportLineItem, CrmReportCustomerItem } from "@/lib/crm/types";
import { StageBadge, ImportanceBadge, PersonCategoryBadge } from "@/components/crm/badges";
import { CustomerProfilePicker } from "@/components/crm/customer-profile-picker";
import { toast } from "sonner";
import Link from "next/link";
import {
  Users, MapPin, ShoppingCart, MessageSquare, Loader2,
  Plus, Trash2, ArrowUp, ArrowDown, RefreshCw, Sparkles, Save,
} from "lucide-react";

interface Props {
  representativeId: string;
  readOnly?: boolean;
  period?: string;
}

/** Compute period key eg "2026-05-12" for this week's Monday */
function getWeekKey(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function lineKey(l: CrmReportLineItem) {
  return l.id || l.profileId;
}

/** API 金额单位为分 */
function formatCurrencyFromCents(cents: number) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format((cents || 0) / 100);
}

function reportAmountCents(
  summary: CrmRepresentativeReport["summary"] | undefined,
  kind: "new" | "delivery" | "confirmed",
): number {
  if (!summary) return 0;
  if (kind === "new") return summary.newBusinessAmountCents ?? summary.newBusinessAmount ?? 0;
  if (kind === "delivery") return summary.deliveryBusinessAmountCents ?? summary.deliveryBusinessAmount ?? 0;
  return summary.confirmedBusinessAmountCents ?? summary.confirmedBusinessAmount ?? 0;
}

export function RepresentativeReportPanel({ representativeId, readOnly = false, period = "week" }: Props) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { confirm } = useConfirm();

  // --- Data ---
  const { data, isLoading, error: reportError } = useQuery<CrmRepresentativeReport>({
    queryKey: crmKeys.representativeReport(representativeId, period),
    queryFn: async () => {
      const res = await fetch(`/api/crm/representatives/${representativeId}/report?period=${period}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof json?.error === "string" ? json.error : `加载周报失败 (${res.status})`,
        );
      }
      return json as CrmRepresentativeReport;
    },
  });

  // 保存草稿优先用服务端业务周键，避免客户端 TZ 漂移
  const periodKey = data?.periodKey || getWeekKey();

  // --- Lines state ---
  const [lines, setLines] = useState<CrmReportLineItem[]>([]);
  const [linesDirty, setLinesDirty] = useState(false);
  const linesLoadedRef = useRef(false);
  const linesRef = useRef<CrmReportLineItem[]>([]);
  useEffect(() => { linesRef.current = lines; }, [lines]);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const pendingSaveSnapshotRef = useRef<string>("");

  // Load from data once
  useEffect(() => {
    if (data && !linesLoadedRef.current) {
      setLines(data.lines || []);
      linesLoadedRef.current = true;
      setLinesDirty(false);
    }
  }, [data]);

  // Reset when rep changes
  useEffect(() => {
    linesLoadedRef.current = false;
    queueMicrotask(() => setLinesDirty(false));
  }, [representativeId]);

  // --- Save mutation ---
  const saveMutation = useMutation({
    mutationFn: async (payload: { lines?: CrmReportLineItem[] }) => {
      const res = await fetch(`/api/crm/representatives/${representativeId}/report`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodType: "WEEK", periodKey, ...payload }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "保存失败" }));
        throw new Error(err.error || "保存失败");
      }
      return res.json() as Promise<{ lines: CrmReportLineItem[]; draftNote: string }>;
    },
    onSuccess: (result) => {
      if (result.lines) {
        const snapshot = pendingSaveSnapshotRef.current;
        const current = JSON.stringify(linesRef.current);
        const unchanged = current === snapshot;
        if (unchanged) {
          setLines((prev) => {
            if (prev.length === result.lines.length) {
              return prev.map((l, i) => ({ ...l, id: result.lines[i].id }));
            }
            return result.lines;
          });
          setLinesDirty(false);
          // Reset ref so the next data refresh re-initializes lines with enriched details
          linesLoadedRef.current = false;
          queryClient.invalidateQueries({ queryKey: crmKeys.representativeReport(representativeId, period) });
          toast.success("保存成功");
          setLastSavedAt(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
        } else {
          // Only sync IDs back without overwriting content
          setLines((prev) => {
            const idMap = new Map(result.lines.map((l) => [l.profileId, l.id]));
            return prev.map((l) => ({ ...l, id: idMap.get(l.profileId) || l.id }));
          });
          toast.success("保存成功（本地有未保存修改）");
          setLastSavedAt(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
        }
      }
    },
    onError: (err: Error) => {
      toast.error(err.message || "保存失败");
    },
  });

  const saveLines = useCallback(() => {
    if (readOnly) return;
    pendingSaveSnapshotRef.current = JSON.stringify(lines);
    saveMutation.mutate({
      lines: lines.map(({ profileId, customerName, customerCode, organization, demand, note, sortOrder, id }) => ({
        id,
        profileId,
        customerName,
        customerCode,
        organization,
        demand,
        note,
        sortOrder,
      })),
    });
  }, [lines, readOnly, saveMutation]);

  // --- Add customer ---
  async function handleAddCustomer(profileId: string, customerName: string) {
    if (readOnly || isSaving) return;

    if (lines.some((l) => l.profileId === profileId)) {
      toast.info("该客户已在汇报中");
      return;
    }

    // Try to get full details from active customers list first
    const activeCustomer = data?.customers.find((c) => c.profileId === profileId);

    let organization: string | null = null;
    let customerCode = "";
    let stage = "";
    let importance = "";
    let weeklyVisitCount = 0;
    let lastVisitAt: string | null = null;
    let hasOrderThisWeek = false;

    if (activeCustomer) {
      organization = activeCustomer.organization;
      customerCode = activeCustomer.customerCode;
      stage = activeCustomer.stage;
      importance = activeCustomer.importance;
      weeklyVisitCount = activeCustomer.weeklyVisitCount;
      lastVisitAt = activeCustomer.lastVisitAt;
      hasOrderThisWeek = activeCustomer.hasOrderThisWeek;
    } else {
      try {
        const res = await fetch(`/api/crm/profiles/${encodeURIComponent(profileId)}`);
        if (res.ok) {
          const d = await res.json();
          const profile = d.profile;
          if (profile) {
            organization = profile.customerView?.organization ?? profile.organization ?? null;
            customerCode = profile.customerView?.customerCode || "";
            stage = profile.stage || "";
            importance = profile.importance || "";
          }
        }
      } catch {
        // ignore
      }
    }

    let demand = "";
    try {
      const res = await fetch(
        `/api/crm/representatives/${representativeId}/report/interactions?profileId=${encodeURIComponent(profileId)}`,
      );
      if (res.ok) {
        const d = await res.json();
        const ix = d.interactions?.[0];
        demand = ix?.summaryTitle?.trim() || ix?.summary?.trim() || ix?.summaryNote?.trim() || "";
      }
    } catch {
      // ignore
    }

    const newLine: CrmReportLineItem = {
      id: `temp-${Date.now()}`,
      profileId,
      customerName,
      customerCode,
      organization,
      demand,
      note: "",
      sortOrder: lines.length,
      stage,
      importance,
      weeklyVisitCount,
      lastVisitAt,
      hasOrderThisWeek,
    };

    setLines((prev) => [...prev, newLine]);
    setLinesDirty(true);
  }

  // --- Auto-fill from active customers ---
  function handleAutoFill() {
    if (readOnly || !data?.customers) return;
    const existingIds = new Set(lines.map((l) => l.profileId));
    const newLines = data.customers
      .filter((c) => !existingIds.has(c.profileId))
      .map((c, i) => ({
        id: `temp-${Date.now()}-${i}`,
        profileId: c.profileId,
        customerName: c.customerName,
        customerCode: c.customerCode,
        organization: c.organization,
        demand: c.latestDemand || "",
        note: "",
        sortOrder: lines.length + i,
        stage: c.stage,
        importance: c.importance,
        weeklyVisitCount: c.weeklyVisitCount,
        lastVisitAt: c.lastVisitAt,
        hasOrderThisWeek: c.hasOrderThisWeek,
      }));

    if (newLines.length === 0) {
      toast.info("本周活跃客户已全部在汇报中");
      return;
    }

    setLines((prev) => [...prev, ...newLines]);
    setLinesDirty(true);
    toast.success(`已添加 ${newLines.length} 个客户`);
  }

  // --- Regenerate (replace all) ---
  async function handleRegenerate() {
    if (readOnly || !data?.customers) return;
    if (lines.length > 0) {
      const ok = await confirm({
        title: "重新生成汇报",
        description: "这将替换当前所有汇报明细，已手写的内容会丢失，确定吗？",
        variant: "destructive",
      });
      if (!ok) return;
    }
    const newLines = data.customers.map((c, i) => ({
      id: `temp-${Date.now()}-${i}`,
      profileId: c.profileId,
      customerName: c.customerName,
      customerCode: c.customerCode,
      organization: c.organization,
      demand: c.latestDemand || "",
      note: "",
      sortOrder: i,
      stage: c.stage,
      importance: c.importance,
      weeklyVisitCount: c.weeklyVisitCount,
      lastVisitAt: c.lastVisitAt,
      hasOrderThisWeek: c.hasOrderThisWeek,
    }));
    setLines(newLines);
    setLinesDirty(true);
  }

  const isSaving = saveMutation.isPending;

  // --- Update line ---
  function updateLine(index: number, updates: Partial<CrmReportLineItem>) {
    if (readOnly || isSaving) return;
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...updates } : l)));
    setLinesDirty(true);
  }

  // --- Delete line ---
  function deleteLine(index: number) {
    if (readOnly || isSaving) return;
    setLines((prev) => prev.filter((_, i) => i !== index).map((l, i) => ({ ...l, sortOrder: i })));
    setLinesDirty(true);
  }

  // --- Move line ---
  function moveLine(index: number, direction: -1 | 1) {
    if (readOnly || isSaving) return;
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= lines.length) return;
    setLines((prev) => {
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(newIndex, 0, item);
      return next.map((l, i) => ({ ...l, sortOrder: i }));
    });
    setLinesDirty(true);
  }

  // --- Fetch demand from interactions ---
  async function fetchDemandForLine(profileId: string, index: number) {
    if (isSaving) return;
    try {
      const res = await fetch(
        `/api/crm/representatives/${representativeId}/report/interactions?profileId=${encodeURIComponent(profileId)}`,
      );
      if (!res.ok) return;
      const d = await res.json();
      const ix = d.interactions?.[0];
      const demand = ix?.summaryTitle?.trim() || ix?.summary?.trim() || ix?.summaryNote?.trim() || "";
      if (demand) {
        updateLine(index, { demand });
        toast.success("已填充需求");
      } else {
        toast.info("本周暂无沟通记录");
      }
    } catch {
      toast.error("拉取沟通记录失败");
    }
  }

  // --- Unload guard ---
  const linesDirtyRef = useRef(linesDirty);
  useEffect(() => { linesDirtyRef.current = linesDirty; }, [linesDirty]);

  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (linesDirtyRef.current && !readOnly) {
        // Best-effort flush via sendBeacon
        try {
          const payload = JSON.stringify({
            periodType: "WEEK",
            periodKey,
            lines: linesRef.current,
          });
          const blob = new Blob([payload], { type: "application/json" });
          navigator.sendBeacon(`/api/crm/representatives/${representativeId}/report`, blob);
        } catch {
          // ignore
        }
        e.preventDefault();
        e.returnValue = "";
      }
    }
    function handlePopState() {
      if (linesDirtyRef.current && !readOnly) {
        // Cancel the back navigation first, then show async confirm
        window.history.pushState(null, "", window.location.href);
        confirm({
          title: "未保存的变更",
          description: "汇报明细有未保存的变更，确定要离开吗？",
          variant: "destructive",
        }).then((ok) => {
          if (ok) router.back();
        });
      }
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("popstate", handlePopState);
    };
  }, [readOnly, periodKey, representativeId, confirm, router]);

  // --- Render ---
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" />
        加载周报...
      </div>
    );
  }

  if (reportError) {
    return (
      <div className="text-sm text-danger py-8 text-center">
        周报加载失败：{reportError instanceof Error ? reportError.message : "未知错误"}
      </div>
    );
  }

  if (!data) {
    return <div className="text-sm text-muted-foreground py-8 text-center">暂无周报数据</div>;
  }

  const s = data.summary;
  // 优先用服务端本地日期，避免 ISO UTC slice 偏一天
  const weekLabel = `${data.periodStartDate || data.periodStart.slice(0, 10)} ~ ${data.periodEndDate || data.periodEnd.slice(0, 10)}`;

  return (
    <div className="space-y-6">
      <div className="text-sm text-muted-foreground">
        统计周期：{weekLabel}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card>
          <CardContent className="pt-3 pb-2 px-3">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <MapPin className="h-4 w-4" />
              <span className="text-xs">本周签到</span>
            </div>
            <p className="text-2xl font-bold">{s.visitCheckinCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2 px-3">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Users className="h-4 w-4" />
              <span className="text-xs">本周新增客户</span>
            </div>
            <p className="text-2xl font-bold">{s.newCustomerCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2 px-3">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <ShoppingCart className="h-4 w-4" />
              <span className="text-xs">本周下单数</span>
            </div>
            <p className="text-2xl font-bold">{s.reservedOrderCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2 px-3">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <ShoppingCart className="h-4 w-4" />
              <span className="text-xs">本周新增业务额</span>
            </div>
            <p className="text-2xl font-bold">{formatCurrencyFromCents(reportAmountCents(s, "new"))}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2 px-3">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <ShoppingCart className="h-4 w-4" />
              <span className="text-xs">本周交付业务额</span>
            </div>
            <p className="text-2xl font-bold">{formatCurrencyFromCents(reportAmountCents(s, "delivery"))}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2 px-3">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <ShoppingCart className="h-4 w-4" />
              <span className="text-xs">本周确认业务额</span>
            </div>
            <p className="text-2xl font-bold">{formatCurrencyFromCents(reportAmountCents(s, "confirmed"))}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2 px-3">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <MessageSquare className="h-4 w-4" />
              <span className="text-xs">本周沟通次数</span>
            </div>
            <p className="text-2xl font-bold">{s.communicationEventCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2 px-3">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <MessageSquare className="h-4 w-4" />
              <span className="text-xs">本周沟通客户</span>
            </div>
            <p className="text-2xl font-bold">{s.communicatedCustomerCount}</p>
          </CardContent>
        </Card>
      </div>

      {/* Active customers (read-only source) */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">本周活跃客户 ({data.customers.length})</h3>
          {!readOnly && (
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="sm" onClick={handleAutoFill} disabled={saveMutation.isPending}>
                <Sparkles className="h-3.5 w-3.5 mr-1" />
                一键填入汇报
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void handleRegenerate()} disabled={saveMutation.isPending}>
                <RefreshCw className="h-3.5 w-3.5 mr-1" />
                重新生成
              </Button>
            </div>
          )}
        </div>
        {data.customers.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center border rounded-lg">本周暂无客户数据</div>
        ) : (
          <DataTable
            columns={activeCustomerColumns}
            data={data.customers}
            keyExtractor={(c) => c.profileId}
            renderMobileCard={(c) => (
              <Card>
                <CardContent className="p-4 space-y-2">
                  <div>
                    <Link href={`/crm/customers/${c.profileId}`} className="text-primary hover:underline text-sm font-medium">
                      {c.customerView?.name || c.customerName}
                    </Link>
                    <div className="text-[11px] text-muted-foreground">{c.customerView?.customerCode || c.customerCode}</div>
                  </div>
                  <div className="text-xs text-muted-foreground">{c.organization || "-"}</div>
                  <div className="flex flex-wrap gap-2">
                    {c.stage && <StageBadge stage={c.stage} />}
                    {c.importance && <ImportanceBadge importance={c.importance} />}
                    {c.personCategory && <PersonCategoryBadge category={c.personCategory} />}
                  </div>
                  <div className="text-sm">本周拜访 {c.weeklyVisitCount} 次</div>
                  <div className="text-xs text-muted-foreground">最近拜访 {c.lastVisitAt ? new Date(c.lastVisitAt).toLocaleDateString("zh-CN") : "—"}</div>
                  <div className="text-sm text-muted-foreground truncate">{c.latestDemand || "-"}</div>
                  <div>{c.hasOrderThisWeek ? <Badge variant="default" className="text-xs">已下单</Badge> : <span className="text-muted-foreground text-sm">未下单</span>}</div>
                </CardContent>
              </Card>
            )}
            emptyTitle="本周暂无客户数据"
          />
        )}
      </div>

      {/* Report lines (editable) */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">我的汇报明细 ({lines.length})</h3>
          {!readOnly && (
            <div className="flex items-center gap-1.5">
              <CustomerProfilePicker
                title="添加客户到汇报"
                actionLabel="添加"
                trigger={
                  <Button variant="outline" size="sm" disabled={saveMutation.isPending}>
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    添加客户
                  </Button>
                }
                onPick={handleAddCustomer}
              />
            </div>
          )}
        </div>

        {lines.length === 0 ? (
          <div className="text-sm text-muted-foreground py-6 text-center border rounded-lg border-dashed">
            暂无汇报明细，可点击「添加客户」或「一键填入汇报」
          </div>
        ) : (
          <div className="space-y-2">
            {lines.map((line, index) => (
              <Card key={lineKey(line)} className="overflow-hidden">
                <CardContent className="p-3 space-y-3">
                  {/* Rich info row */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {line.customerExists !== false ? (
                        <Link href={`/crm/customers/${line.profileId}`} className="text-sm font-medium text-primary hover:underline truncate">
                          {line.customerName}
                        </Link>
                      ) : (
                        <span className="text-sm font-medium truncate">{line.customerName}</span>
                      )}
                      {line.customerCode && (
                        <span className="text-[11px] text-muted-foreground">{line.customerCode}</span>
                      )}
                    </div>

                    {line.organization && (
                      <span className="text-xs text-muted-foreground truncate max-w-[160px]" title={line.organization}>{line.organization}</span>
                    )}

                    {line.stage && <StageBadge stage={line.stage} />}
                    {line.importance && <ImportanceBadge importance={line.importance} />}

                    <span className="text-xs text-muted-foreground">
                      本周拜访 {line.weeklyVisitCount ?? 0} 次
                    </span>

                    {line.lastVisitAt && (
                      <span className="text-xs text-muted-foreground">
                        最近拜访 {new Date(line.lastVisitAt).toLocaleDateString("zh-CN")}
                      </span>
                    )}

                    {line.hasOrderThisWeek ? (
                      <Badge variant="default" className="text-[10px] h-4 px-1">本周已下单</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">未下单</span>
                    )}

                    {!readOnly && (
                      <div className="flex items-center gap-0.5 ml-auto shrink-0">
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => moveLine(index, -1)} disabled={index === 0 || isSaving}>
                          <ArrowUp className="h-3 w-3" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => moveLine(index, 1)} disabled={index === lines.length - 1 || isSaving}>
                          <ArrowDown className="h-3 w-3" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-6 w-6 text-danger hover:text-danger/80" onClick={() => deleteLine(index)} disabled={isSaving}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Demand */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <label className="text-xs text-muted-foreground">需求</label>
                      {!readOnly && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 text-xs px-1.5"
                          onClick={() => fetchDemandForLine(line.profileId, index)}
                          disabled={isSaving || !line.profileId}
                        >
                          <Sparkles className="h-3 w-3 mr-1" />
                          从沟通记录拉取
                        </Button>
                      )}
                    </div>
                    <Textarea
                      value={line.demand}
                      onChange={(e) => updateLine(index, { demand: e.target.value })}
                      placeholder="客户需求..."
                      rows={3}
                      readOnly={readOnly || isSaving}
                      className={(readOnly || isSaving) ? "bg-muted text-sm" : "text-sm"}
                    />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Save button — sticky bottom bar */}
      {!readOnly && (
        <div className="sticky bottom-0 z-20 -mx-4 px-4 py-3 bg-background/95 backdrop-blur-sm border-t flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {linesDirty && (
              <span className="text-xs text-warning shrink-0">有未保存变更</span>
            )}
            {lastSavedAt && !linesDirty && (
              <span className="text-xs text-muted-foreground shrink-0">已保存于 {lastSavedAt}</span>
            )}
            {saveMutation.isPending && (
              <span className="text-xs text-muted-foreground flex items-center gap-1 shrink-0">
                <Loader2 className="h-3 w-3 animate-spin" />
                保存中...
              </span>
            )}
          </div>
          <Button onClick={saveLines} disabled={saveMutation.isPending} size="sm">
            <Save className="h-4 w-4 mr-1" />
            保存汇报明细
          </Button>
        </div>
      )}
    </div>
  );
}

const activeCustomerColumns = [
  {
    key: "customerName",
    header: "客户",
    render: (c: CrmReportCustomerItem) => {
      const view = c.customerView;
      return (
        <div>
          <Link href={`/crm/customers/${c.profileId}`} className="text-primary hover:underline text-sm">
            {view?.name || c.customerName}
          </Link>
          <div className="text-[11px] text-muted-foreground">{view?.customerCode || c.customerCode}</div>
        </div>
      );
    },
  },
  { key: "organization", header: "机构", render: (c: CrmReportCustomerItem) => c.organization || "-" },
  { key: "stage", header: "阶段", render: (c: CrmReportCustomerItem) => c.stage ? <StageBadge stage={c.stage} /> : "-" },
  { key: "importance", header: "重要度", render: (c: CrmReportCustomerItem) => c.importance ? <ImportanceBadge importance={c.importance} /> : "-" },
  { key: "personCategory", header: "分类", render: (c: CrmReportCustomerItem) => c.personCategory ? <PersonCategoryBadge category={c.personCategory} /> : "-" },
  { key: "weeklyVisitCount", header: "拜访", align: "center" as const },
  { key: "lastVisitAt", header: "最近拜访", render: (c: CrmReportCustomerItem) => c.lastVisitAt ? new Date(c.lastVisitAt).toLocaleDateString("zh-CN") : "—" },
  { key: "latestDemand", header: "需求摘要", render: (c: CrmReportCustomerItem) => c.latestDemand || "-" },
  { key: "hasOrderThisWeek", header: "下单", align: "center" as const, render: (c: CrmReportCustomerItem) => c.hasOrderThisWeek ? <Badge variant="default" className="text-xs">是</Badge> : <span className="text-muted-foreground">—</span> },
];
