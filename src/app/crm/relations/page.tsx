"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectDisplay, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { RelationTypeBadge } from "@/components/crm/badges";
import { CRM_RELATION_TYPES, RELATION_TYPE_LABELS, RELATION_STRENGTH_LABELS } from "@/lib/crm/constants";
import { crmKeys } from "@/lib/crm/query-keys";
import { RelationCreateDialog } from "@/components/crm/relation-create-dialog";
import type { CrmRelationItem } from "@/lib/crm/types";
import { Trash2, Filter, Network, ArrowRight } from "lucide-react";
import { CrmEmptyState } from "@/components/crm/empty-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/confirm-dialog";
import Link from "next/link";
import { useState } from "react";
import { useMediaQuery } from "@/hooks/use-media-query";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";

export default function CrmRelationsPage() {
  const { status } = useSession();
  const router = useRouter();

  if (status === "unauthenticated") { router.push("/login"); return null; }
  if (status === "loading") return <PageShell><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></PageShell>;

  return <RelationsList />;
}

function RelationsList() {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const { confirm } = useConfirm();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: [...crmKeys.relationsAll(), search, typeFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (typeFilter) params.set("type", typeFilter);
      const res = await fetch(`/api/crm/relations?${params}`);
      return res.json();
    },
  });

  const relations: CrmRelationItem[] = data?.relations || [];

  const deleteMutation = useMutation({
    mutationFn: async (relationId: string) => {
      const res = await fetch(`/api/crm/relations/${relationId}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "删除失败");
      }
    },
    onSuccess: () => {
      toast.success("关系已删除");
      queryClient.invalidateQueries({ queryKey: crmKeys.relationsAll() });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const canDelete = session?.user?.role === "ADMIN" || session?.user?.role === "USER";
  const isMobile = useMediaQuery("(max-width: 767px)");

  const FilterPanel = (
    <div className="space-y-4">
      <Input
        placeholder="搜索客户名/编号/单位..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v === "ALL" ? "" : (v || ""))}>
        <SelectTrigger><SelectDisplay label="类型" valueLabel={!typeFilter || typeFilter === "ALL" ? "全部类型" : RELATION_TYPE_LABELS[typeFilter] || "未知"} placeholder="全部类型" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">全部类型</SelectItem>
          {CRM_RELATION_TYPES.map((t) => (
            <SelectItem key={t} value={t}>{RELATION_TYPE_LABELS[t]}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <PageShell>
      <PageHeader
        title="关系管理"
        backHref="/crm"
        actions={
          <div className="flex items-center gap-2">
            {isMobile && (
              <Sheet>
                <SheetTrigger render={<Button variant="outline" size="sm"><Filter className="h-4 w-4 mr-1" />筛选</Button>} />
                <SheetContent side="top" className="h-auto max-h-[50dvh]">
                  <SheetHeader><SheetTitle>筛选条件</SheetTitle></SheetHeader>
                  <div className="mt-4">{FilterPanel}</div>
                </SheetContent>
              </Sheet>
            )}
            <RelationCreateDialog />
          </div>
        }
      />

      {!isMobile && <div className="flex gap-3 flex-wrap">{FilterPanel}</div>}

      {isLoading ? (
        <Skeleton className="h-8 w-48" />
      ) : relations.length === 0 ? (
        <CrmEmptyState icon={Network} title="暂无关系记录" />
      ) : (
        <div className="space-y-2">
          {relations.map((r) => (
            <Card key={r.id}>
              <CardContent className={isMobile ? "p-3" : "pt-4"}>
                <div className={cn(isMobile ? "relative" : "flex items-start gap-2")}>
                  <div className={cn("min-w-0", isMobile ? "pr-10" : "flex-1")}>
                    {isMobile ? (
                      <div className="space-y-1">
                        {r.fromHasCrm ? (
                          <Link href={`/crm/customers/${r.fromProfileId ?? r.fromCustomer.id}`} className="text-sm font-medium text-primary hover:underline truncate block">
                            {r.fromCustomer.name}
                          </Link>
                        ) : (
                          <span className="text-sm font-medium truncate block">{r.fromCustomer.name}</span>
                        )}
                        <div className="flex items-center gap-2 flex-wrap">
                          <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                          {r.toHasCrm ? (
                            <Link href={`/crm/customers/${r.toProfileId ?? r.toCustomer.id}`} className="min-w-0 flex-1 text-sm font-medium text-primary hover:underline truncate">
                              {r.toCustomer.name}
                            </Link>
                          ) : (
                            <span className="min-w-0 flex-1 text-sm font-medium truncate">{r.toCustomer.name}</span>
                          )}
                          <RelationTypeBadge type={r.type} />
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 flex-wrap">
                        {r.fromHasCrm ? (
                          <Link href={`/crm/customers/${r.fromProfileId ?? r.fromCustomer.id}`} className="text-sm font-medium text-primary hover:underline truncate max-w-[180px]">
                            {r.fromCustomer.name}
                          </Link>
                        ) : (
                          <span className="text-sm font-medium truncate max-w-[180px]">{r.fromCustomer.name}</span>
                        )}
                        <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                        {r.toHasCrm ? (
                          <Link href={`/crm/customers/${r.toProfileId ?? r.toCustomer.id}`} className="text-sm font-medium text-primary hover:underline truncate max-w-[180px]">
                            {r.toCustomer.name}
                          </Link>
                        ) : (
                          <span className="text-sm font-medium truncate max-w-[180px]">{r.toCustomer.name}</span>
                        )}
                        <RelationTypeBadge type={r.type} />
                      </div>
                    )}
                    <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
                      {r.strength && (
                        <span className="bg-muted px-1.5 py-0.5 rounded">{RELATION_STRENGTH_LABELS[r.strength] || r.strength}</span>
                      )}
                      <span>{r.createdByUser.name}</span>
                      <span>·</span>
                      <span>{new Date(r.createdAt).toLocaleDateString("zh-CN")}</span>
                    </div>
                    {r.notes && <p className={cn("text-xs text-muted-foreground mt-1", isMobile && "line-clamp-1")}>{r.notes}</p>}
                  </div>
                  {canDelete && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "text-destructive hover:text-destructive shrink-0 h-8 w-8 p-0",
                        isMobile && "absolute top-0 right-0"
                      )}
                      disabled={deleteMutation.isPending}
                      onClick={async () => {
                        const ok = await confirm({
                          title: "删除关系",
                          description: "确认删除此关系？",
                          variant: "destructive",
                        });
                        if (ok) deleteMutation.mutate(r.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </PageShell>
  );
}