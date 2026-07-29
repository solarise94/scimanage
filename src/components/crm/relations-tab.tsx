"use client";

/**
 * RelationsTab — customer relationship network panel.
 *
 * Extracted verbatim from the standalone customer detail page
 * (`src/app/crm/customers/[profileId]/page.tsx`) so it can be reused inside
 * the Agent embedded CustomerResourceView.  Query key, mutations and layout
 * are unchanged from the original inlined component.
 *
 * Optional navigation hook: when `onNavigateCustomer` is provided (embedded
 * mode), the other-customer link inside `RelationCard` delegates to it
 * instead of using a Next.js `<Link>` — this lets the click push onto the
 * Agent resource history instead of leaving the workspace.  When omitted
 * (standalone page) the original `<Link>` behavior is preserved.
 */

import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RelationTypeBadge } from "@/components/crm/badges";
import { RelationFormDialog } from "@/components/crm/relation-form-dialog";
import { CrmEmptyState } from "@/components/crm/empty-state";
import { RELATION_STRENGTH_LABELS } from "@/lib/crm/constants";
import { crmKeys } from "@/lib/crm/query-keys";
import type { CrmRelationItem } from "@/lib/crm/types";
import { toast } from "sonner";
import { Network } from "lucide-react";

export interface RelationsTabProps {
  profileId: string;
  customerName: string;
  /**
   * Embedded-mode hook: called when the user clicks another customer inside a
   * relation card.  When omitted, the card renders a normal Next.js `<Link>`.
   */
  onNavigateCustomer?: (customerId: string) => void;
}

export function RelationsTab({ profileId, customerName, onNavigateCustomer }: RelationsTabProps) {
  const { data: session } = useSession();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: crmKeys.relations(profileId),
    queryFn: async () => {
      const res = await fetch(`/api/crm/relations?profileId=${profileId}`);
      return res.json();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async ({ id }: { id: string; otherId: string }) => {
      const res = await fetch(`/api/crm/relations/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("删除失败");
    },
    onSuccess: async (_data, { otherId }) => {
      toast.success("关系已删除");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: crmKeys.relations(profileId) }),
        queryClient.invalidateQueries({ queryKey: crmKeys.relations(otherId) }),
        queryClient.invalidateQueries({ queryKey: crmKeys.relationsAll() }),
      ]);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const relations: CrmRelationItem[] = data?.relations || [];
  const endpointId = (r: CrmRelationItem, side: "from" | "to") =>
    side === "from"
      ? (r.fromProfileId ?? r.fromCustomer?.id)
      : (r.toProfileId ?? r.toCustomer?.id);
  const referred = relations.filter(
    (r) => r.type === "REFERRED" && endpointId(r, "from") === profileId,
  );
  const referredBy = relations.filter(
    (r) => r.type === "REFERRED" && endpointId(r, "to") === profileId,
  );
  const others = relations.filter((r) => r.type !== "REFERRED");

  const canDelete = session?.user?.role === "ADMIN" || session?.user?.role === "USER";

  function RelationCard({ relation, otherCustomer }: { relation: CrmRelationItem; otherCustomer: { id: string; name: string; customerCode: string; organization?: string | null } }) {
    const nameNode = (
      <span className="block truncate text-sm font-medium text-primary hover:underline">
        {otherCustomer.name}
      </span>
    );
    return (
      <Card key={relation.id}>
        <CardContent className="p-3 sm:pt-4 sm:flex sm:items-start sm:justify-between sm:gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            {onNavigateCustomer ? (
              <button
                type="button"
                onClick={() => onNavigateCustomer(otherCustomer.id)}
                className="block w-full text-left"
                title={otherCustomer.name}
              >
                {nameNode}
              </button>
            ) : (
              <Link href={`/crm/customers/${otherCustomer.id}`} className="block truncate text-sm font-medium text-primary hover:underline">
                {otherCustomer.name}
              </Link>
            )}
            <div className="text-xs text-muted-foreground truncate">
              {otherCustomer.customerCode}
              {otherCustomer.organization ? ` · ${otherCustomer.organization}` : ""}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <RelationTypeBadge type={relation.type} />
              {relation.strength && (
                <span className="text-xs bg-muted px-1.5 py-0.5 rounded shrink-0 whitespace-nowrap">{RELATION_STRENGTH_LABELS[relation.strength] || relation.strength}</span>
              )}
            </div>
            {relation.notes && <p className="text-xs text-muted-foreground break-words">{relation.notes}</p>}
            <p className="text-xs text-muted-foreground">
              {relation.introducedAt && `${new Date(relation.introducedAt).toLocaleDateString("zh-CN")} · `}
              {relation.createdByUser.name} 创建于 {new Date(relation.createdAt).toLocaleDateString("zh-CN")}
            </p>
          </div>
          {canDelete && (
            <Button variant="ghost" size="sm" className="mt-3 w-full sm:mt-0 sm:w-auto text-danger hover:text-danger/80" onClick={() => deleteMutation.mutate({ id: relation.id, otherId: otherCustomer.id })} disabled={deleteMutation.isPending}>
              删除
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  if (isLoading) return <p className="text-sm text-muted-foreground">加载中...</p>;

  return (
    <div>
      <div className="flex justify-between items-center mb-3">
        <h3 className="font-medium">关系网络</h3>
        <RelationFormDialog currentProfileId={profileId} currentCustomerName={customerName} />
      </div>

      {relations.length === 0 ? (
        <CrmEmptyState icon={Network} title="暂无关系记录" description="点击上方按钮添加第一条关系" />
      ) : (
        <div className="space-y-4">
          {referred.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-2">介绍了 ({referred.length})</h4>
              <div className="space-y-2">
                {referred.map((r) => <RelationCard key={r.id} relation={r} otherCustomer={r.toCustomer} />)}
              </div>
            </div>
          )}
          {referredBy.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-2">被介绍 ({referredBy.length})</h4>
              <div className="space-y-2">
                {referredBy.map((r) => <RelationCard key={r.id} relation={r} otherCustomer={r.fromCustomer} />)}
              </div>
            </div>
          )}
          {others.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-2">其他关系 ({others.length})</h4>
              <div className="space-y-2">
                {others.map((r) => {
                  const other = endpointId(r, "from") === profileId ? r.toCustomer : r.fromCustomer;
                  return <RelationCard key={r.id} relation={r} otherCustomer={other} />;
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
