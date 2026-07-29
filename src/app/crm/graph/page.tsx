"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectDisplay, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { RelationGraph } from "@/components/crm/relation-graph";
import { RelationCreateDialog } from "@/components/crm/relation-create-dialog";
import { RelationTypeBadge } from "@/components/crm/badges";
import {
  CRM_STAGES,
  STAGE_LABELS,
  STAGE_HEX_COLORS,
  CRM_RELATION_TYPES,
  RELATION_TYPE_LABELS,
  RELATION_STRENGTH_LABELS,
} from "@/lib/crm/constants";
import { crmKeys } from "@/lib/crm/query-keys";
import type { CrmRelationItem, CrmCustomerProfileItem } from "@/lib/crm/types";
import { ArrowLeft, Eye, Plus, Filter } from "lucide-react";
import Link from "next/link";
import { useMediaQuery } from "@/hooks/use-media-query";

export default function CrmGraphPage() {
  const { status } = useSession();
  const router = useRouter();

  if (status === "unauthenticated") { router.push("/login"); return null; }
  if (status === "loading") return <div className="p-6">加载中...</div>;

  return <GraphView />;
}

function GraphView() {
  const router = useRouter();
  const { data: session } = useSession();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [graphReady, setGraphReady] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setGraphReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  const [viewMode, setViewMode] = useState<"focus" | "graph">("focus");
  const [stageFilter, setStageFilter] = useState("ALL");
  const [typeFilters, setTypeFilters] = useState<Set<string>>(new Set(CRM_RELATION_TYPES));
  const [clickedNode, setClickedNode] = useState<{ profileId: string; name: string } | null>(null);
  const [nodeDialogOpen, setNodeDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createPrefill, setCreatePrefill] = useState<{ profileId: string; customerName: string } | null>(null);
  const [focusProfileId, setFocusProfileId] = useState<string | null>(null);
  const [customerSearch, setCustomerSearch] = useState("");
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  const { data: relData, isLoading: relLoading } = useQuery<{ relations: CrmRelationItem[] }>({
    queryKey: crmKeys.relationsAll(),
    queryFn: () => fetch("/api/crm/relations").then((r) => r.json()),
  });

  const { data: profData, isLoading: profLoading } = useQuery<{ profiles: CrmCustomerProfileItem[] }>({
    queryKey: [...crmKeys.profiles(), "all-pages"],
    queryFn: async () => {
      const allProfiles: CrmCustomerProfileItem[] = [];
      let page = 1;
      while (true) {
        const res = await fetch(`/api/crm/profiles?page=${page}&pageSize=100`);
        const data = await res.json();
        allProfiles.push(...(data.profiles || []));
        if (!data.totalPages || page >= data.totalPages) break;
        page++;
        if (page > 50) break;
      }
      return { profiles: allProfiles };
    },
  });

  const isLoading = relLoading || profLoading;
  const allRelations = useMemo(() => relData?.relations || [], [relData?.relations]);
  const profiles = profData?.profiles || [];

  const profileStages = new Map<string, string>();
  for (const p of profiles) {
    profileStages.set(p.id, p.stage);
  }

  const canCreateAnyRelation = session?.user?.role === "ADMIN" || session?.user?.role === "USER";

  const relationEndpointId = (r: CrmRelationItem, side: "from" | "to") =>
    side === "from"
      ? (r.fromProfileId ?? r.fromCustomer?.id)
      : (r.toProfileId ?? r.toCustomer?.id);

  const filtered = allRelations.filter((r) => {
    if (!typeFilters.has(r.type)) return false;
    if (stageFilter !== "ALL") {
      const fromStage = profileStages.get(relationEndpointId(r, "from") ?? "");
      const toStage = profileStages.get(relationEndpointId(r, "to") ?? "");
      if (fromStage !== stageFilter && toStage !== stageFilter) return false;
    }
    return true;
  });

  const toggleType = (type: string) => {
    setTypeFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  };

  const customerMap = useMemo(() => {
    const map = new Map<string, { id: string; name: string; customerCode: string; organization?: string | null }>();
    for (const r of allRelations) {
      map.set(r.fromCustomer.id, r.fromCustomer);
      map.set(r.toCustomer.id, r.toCustomer);
    }
    return map;
  }, [allRelations]);

  const searchResults = useMemo(() => {
    if (!customerSearch.trim()) return [];
    const term = customerSearch.trim().toLowerCase();
    return Array.from(customerMap.values()).filter((c) =>
      c.name.toLowerCase().includes(term) || c.customerCode.toLowerCase().includes(term)
    ).slice(0, 10);
  }, [customerMap, customerSearch]);

  const profileIdSet = useMemo(() => new Set(profiles.map((p) => p.id)), [profiles]);

  const focusCustomer = focusProfileId ? customerMap.get(focusProfileId) : null;
  const focusRelations = useMemo(() => {
    if (!focusProfileId) return [];
    return filtered.filter(
      (r) => relationEndpointId(r, "from") === focusProfileId || relationEndpointId(r, "to") === focusProfileId,
    );
  }, [filtered, focusProfileId]);

  const nodeRelations = useMemo(() => {
    if (!clickedNode) return [];
    return filtered.filter(
      (r) =>
        relationEndpointId(r, "from") === clickedNode.profileId ||
        relationEndpointId(r, "to") === clickedNode.profileId,
    );
  }, [filtered, clickedNode]);

  const groupedNodeRelations = useMemo(() => {
    const groups = new Map<string, CrmRelationItem[]>();
    for (const r of nodeRelations) {
      if (!groups.has(r.type)) groups.set(r.type, []);
      groups.get(r.type)!.push(r);
    }
    return groups;
  }, [nodeRelations]);

  const FilterContent = (
    <div className="space-y-4">
      <Select value={stageFilter} onValueChange={(v) => setStageFilter(v || "ALL")}>
        <SelectTrigger className="w-full">
          <SelectDisplay label="阶段" valueLabel={stageFilter === "ALL" ? "全部阶段" : STAGE_LABELS[stageFilter] || "未知"} placeholder="阶段" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">全部阶段</SelectItem>
          {CRM_STAGES.map((s) => (
            <SelectItem key={s} value={s}>{STAGE_LABELS[s]}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="space-y-2">
        <div className="text-sm font-medium">关系类型</div>
        <div className="grid grid-cols-2 gap-2">
          {CRM_RELATION_TYPES.map((t) => (
            <label key={t} className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox checked={typeFilters.has(t)} onCheckedChange={() => toggleType(t)} />
              {RELATION_TYPE_LABELS[t]}
            </label>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Desktop top bar */}
      <div className="hidden md:flex items-center gap-3 p-4 border-b flex-wrap">
        <Link href="/crm">
          <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <h1 className="text-lg font-bold">关系图谱</h1>
        <div className="flex items-center gap-3 flex-wrap flex-1 justify-end">
          <Button size="sm" onClick={() => { setCreatePrefill(null); setCreateDialogOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" />添加关系
          </Button>
          <Select value={stageFilter} onValueChange={(v) => setStageFilter(v || "ALL")}>
            <SelectTrigger className="w-[120px] h-8 text-xs">
              <SelectDisplay label="阶段" valueLabel={stageFilter === "ALL" ? "全部阶段" : STAGE_LABELS[stageFilter] || "未知"} placeholder="阶段" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部阶段</SelectItem>
              {CRM_STAGES.map((s) => (
                <SelectItem key={s} value={s}>{STAGE_LABELS[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2 flex-wrap">
            {CRM_RELATION_TYPES.map((t) => (
              <label key={t} className="flex items-center gap-1 text-xs cursor-pointer">
                <Checkbox checked={typeFilters.has(t)} onCheckedChange={() => toggleType(t)} className="h-3.5 w-3.5" />
                {RELATION_TYPE_LABELS[t]}
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Mobile top bar */}
      <div className="md:hidden flex items-center gap-2 p-3 border-b">
        <Link href="/crm">
          <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <h1 className="text-base font-bold flex-1 truncate">关系图谱</h1>
        <div className="flex items-center gap-1">
          <Button size="sm" onClick={() => { setCreatePrefill(null); setCreateDialogOpen(true); }}>
            <Plus className="h-4 w-4" />
          </Button>
          <Sheet open={filterSheetOpen} onOpenChange={setFilterSheetOpen}>
            <SheetTrigger render={<Button variant="outline" size="sm"><Filter className="h-4 w-4" /></Button>} />
            <SheetContent side="bottom" className="max-h-[80dvh]">
              <SheetHeader><SheetTitle>筛选条件</SheetTitle></SheetHeader>
              <div className="mt-4 flex-1 overflow-y-auto">{FilterContent}</div>
            </SheetContent>
          </Sheet>
          <Button variant="outline" size="sm" onClick={() => setViewMode((v) => v === "focus" ? "graph" : "focus")}>
            {viewMode === "focus" ? "图谱" : "列表"}
          </Button>
        </div>
      </div>

      {/* Desktop graph */}
      <div className="hidden md:flex md:flex-1 md:relative">
        {graphReady && !isMobile && (
          isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">加载中...</div>
          ) : filtered.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">暂无关系数据</div>
          ) : (
            <RelationGraph
              relations={filtered}
              profileStages={profileStages}
              profileIdSet={profileIdSet}
              onNodeClick={(node) => {
                setClickedNode(node);
                setNodeDialogOpen(true);
              }}
            />
          )
        )}
      </div>

      {/* Mobile focus view */}
      {graphReady && isMobile && viewMode === "focus" && (
      <div className="md:hidden flex-1 overflow-y-auto p-3 space-y-3">
        <div className="relative">
          <Input
            placeholder="搜索客户..."
            value={customerSearch}
            onChange={(e) => setCustomerSearch(e.target.value)}
          />
          {customerSearch.trim() && searchResults.length > 0 && (
            <div className="absolute z-10 w-full bg-popover border rounded-md shadow-lg mt-1 max-h-60 overflow-y-auto">
              {searchResults.map((c) => (
                <button
                  key={c.id}
                  className="w-full text-left px-3 py-2 hover:bg-muted text-sm"
                  onClick={() => { setFocusProfileId(c.id); setCustomerSearch(""); }}
                >
                  {c.name} <span className="text-muted-foreground text-xs">({c.customerCode})</span>
                </button>
              ))}
            </div>
          )}
          {customerSearch.trim() && searchResults.length === 0 && (
            <div className="absolute z-10 w-full bg-popover border rounded-md shadow-lg mt-1 p-3 text-sm text-muted-foreground">
              未找到匹配客户
            </div>
          )}
        </div>

        {focusCustomer && (
          <>
            <div className="rounded-lg border bg-card p-3 space-y-1">
              <div className="font-medium text-base">{focusCustomer.name}</div>
              <div className="text-xs text-muted-foreground">
                {focusCustomer.customerCode} · {focusCustomer.organization || "-"}
              </div>
              {(() => {
                const stage = profileStages.get(focusCustomer.id);
                return stage ? (
                  <Badge style={{ backgroundColor: STAGE_HEX_COLORS[stage] || "var(--muted-foreground)", color: "var(--card)" }}>
                    {STAGE_LABELS[stage] || stage}
                  </Badge>
                ) : null;
              })()}
            </div>

            <div className="text-sm text-muted-foreground">
              共 {focusRelations.length} 条关系
              {focusRelations.length === 0 && "（当前筛选条件下）"}
            </div>

            <div className="space-y-2">
              {focusRelations.map((r) => {
                const isFrom = relationEndpointId(r, "from") === focusProfileId;
                const other = isFrom ? r.toCustomer : r.fromCustomer;
                return (
                  <div key={r.id} className="rounded-lg border bg-card p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <span className="font-medium truncate">{other.name}</span>
                      <RelationTypeBadge type={r.type} />
                    </div>
                    <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
                      <span>{isFrom ? "→" : "←"} {other.customerCode}</span>
                      {r.strength && (
                        <span className="bg-muted px-1.5 py-0.5 rounded">
                          {RELATION_STRENGTH_LABELS[r.strength] || r.strength}
                        </span>
                      )}
                    </div>
                    {r.notes && <p className="text-xs text-muted-foreground line-clamp-2">{r.notes}</p>}
                    <div className="flex gap-2">
                      {profileIdSet.has(other.id) ? (
                        <Link href={`/crm/customers/${other.id}`}>
                          <Button variant="outline" size="sm">
                            <Eye className="h-3 w-3 mr-1" />查看客户
                          </Button>
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground self-center">未建 CRM 档案</span>
                      )}
                      {(canCreateAnyRelation || (focusProfileId && profileIdSet.has(focusProfileId))) && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setCreatePrefill({ profileId: focusProfileId!, customerName: focusCustomer.name });
                            setCreateDialogOpen(true);
                          }}
                        >
                          <Plus className="h-3 w-3 mr-1" />添加关系
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {!focusCustomer && (
          <div className="text-center text-sm text-muted-foreground py-12">
            搜索客户以查看其关系图谱
          </div>
        )}
      </div>
      )}

      {/* Mobile graph view */}
      {graphReady && isMobile && viewMode === "graph" && (
      <div className="md:hidden flex-1 relative min-h-[calc(100dvh-9rem)]">
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">加载中...</div>
        ) : filtered.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">暂无关系数据</div>
        ) : (
          <RelationGraph
            relations={filtered}
            profileStages={profileStages}
            profileIdSet={profileIdSet}
            onNodeClick={(node) => {
              setClickedNode(node);
              setNodeDialogOpen(true);
            }}
          />
        )}
      </div>
      )}

      {/* Node click dialog */}
      <Dialog open={nodeDialogOpen} onOpenChange={setNodeDialogOpen}>
        <DialogContent className="sm:max-w-md max-w-[calc(100vw-2rem)]">
          <DialogHeader><DialogTitle>{clickedNode?.name}</DialogTitle></DialogHeader>
          <div className="space-y-3 max-h-[60dvh] overflow-y-auto overscroll-contain">
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1 justify-start"
                onClick={() => {
                  if (clickedNode) router.push(`/crm/customers/${clickedNode.profileId}`);
                  setNodeDialogOpen(false);
                }}
              >
                <Eye className="h-4 w-4 mr-2" />查看客户
              </Button>
              {(canCreateAnyRelation || (clickedNode && profileIdSet.has(clickedNode.profileId))) && (
                <Button
                  variant="outline"
                  className="flex-1 justify-start"
                  onClick={() => {
                    if (clickedNode) {
                      setCreatePrefill({ profileId: clickedNode.profileId, customerName: clickedNode.name });
                      setNodeDialogOpen(false);
                      setCreateDialogOpen(true);
                    }
                  }}
                >
                  <Plus className="h-4 w-4 mr-2" />添加关系
                </Button>
              )}
            </div>
            {nodeRelations.length > 0 && (
              <div className="space-y-3">
                <div className="text-sm font-medium text-muted-foreground">相关客户（{nodeRelations.length}）</div>
                {Array.from(groupedNodeRelations.entries()).map(([type, rels]) => (
                  <div key={type}>
                    <div className="text-xs font-medium text-muted-foreground mb-1">{RELATION_TYPE_LABELS[type]}</div>
                    <div className="space-y-1">
                      {rels.map((r) => {
                        const isFrom = relationEndpointId(r, "from") === clickedNode?.profileId;
                        const other = isFrom ? r.toCustomer : r.fromCustomer;
                        return (
                          <div key={r.id} className="flex items-center justify-between text-sm">
                            {profileIdSet.has(other.id) ? (
                              <Link href={`/crm/customers/${other.id}`} className="text-primary hover:underline truncate" onClick={() => setNodeDialogOpen(false)}>
                                {other.name}
                              </Link>
                            ) : (
                              <span className="text-muted-foreground truncate">{other.name}</span>
                            )}
                            <span className="text-muted-foreground text-xs ml-2 shrink-0">{isFrom ? "→" : "←"}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <RelationCreateDialog
        prefilledA={createPrefill}
        open={createDialogOpen}
        onOpenChange={(v) => { setCreateDialogOpen(v); if (!v) setCreatePrefill(null); }}
      />
    </div>
  );
}
