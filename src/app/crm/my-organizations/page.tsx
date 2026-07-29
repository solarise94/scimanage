"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2, Loader2, Send, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { OrganizationSelect } from "@/components/organization-select";
import { MobileActionDock, MobileActionButton } from "@/components/ui/mobile-action-dock";
import { toast } from "sonner";

interface RepBinding {
  id: string;
  status: string;
  organizationId: string | null;
  requestedOrganizationName: string | null;
  reviewNote: string | null;
  createdAt: string;
  organization: {
    id: string;
    canonicalName: string;
    address: string | null;
  } | null;
}

interface BindingResponse {
  binding?: RepBinding;
  warningCodes?: string[];
}

function describeBindingWarnings(warningCodes: string[] | undefined): string | null {
  if (!warningCodes || warningCodes.length === 0) return null;
  if (warningCodes.includes("ORG_BOUND_BY_OTHER_REP")) {
    return "该机构当前已由其他代表负责，已同步通知地区经理。";
  }
  if (warningCodes.includes("ORG_PENDING_BY_OTHER_REP")) {
    return "该机构已有其他代表提交过绑定申请，已同步通知地区经理。";
  }
  if (warningCodes.includes("ORG_NAME_PENDING_BY_OTHER_REP")) {
    return "已有其他代表提交过同名新机构申请，已同步通知地区经理。";
  }
  return null;
}

export default function MyOrganizationsPage() {
  const { status } = useSession();
  const router = useRouter();

  if (status === "unauthenticated") {
    router.push("/login");
    return null;
  }
  if (status === "loading") return <div className="p-4 md:p-8">加载中...</div>;

  return <MyOrganizations />;
}

function MyOrganizations() {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const [selectedOrgId, setSelectedOrgId] = useState<string>("");
  const [selectedOrgName, setSelectedOrgName] = useState("");
  const [searchText, setSearchText] = useState("");
  const [showRejected, setShowRejected] = useState(false);

  const isRep = session?.user?.role === "REPRESENTATIVE";

  const { data, isLoading } = useQuery<{ bindings: RepBinding[] }>({
    queryKey: ["representative-organizations", "self"],
    queryFn: async () => {
      const res = await fetch("/api/crm/representative-organizations");
      if (!res.ok) throw new Error("加载失败");
      return res.json();
    },
    enabled: isRep,
  });

  const requestMutation = useMutation({
    mutationFn: async (payload: { organizationId?: string; canonicalName?: string }) => {
      const res = await fetch("/api/crm/representative-organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        const err = new Error(json.error || "申请失败") as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return json as BindingResponse;
    },
    onSuccess: (data) => {
      toast.success("绑定申请已提交，等待审核");
      const warningText = describeBindingWarnings(data.warningCodes);
      if (warningText) {
        toast.info(warningText);
      }
      setSelectedOrgId("");
      setSelectedOrgName("");
      setSearchText("");
      queryClient.invalidateQueries({ queryKey: ["representative-organizations", "self"] });
    },
    onError: (err: Error & { status?: number }) => {
      if (err.status === 409) {
        toast.info("该单位已有绑定申请或绑定记录");
      } else {
        toast.error(err.message);
      }
    },
  });

  if (!isRep) {
    return <div className="p-4 md:p-8">此页面仅对代表开放。</div>;
  }

  const bindings = data?.bindings || [];
  const active = bindings.filter((b) => b.status === "ACTIVE");
  const pending = bindings.filter((b) => b.status === "PENDING");
  const rejected = bindings.filter((b) => b.status === "REJECTED");

  const canSubmit =
    (!!selectedOrgName.trim() || !!searchText.trim()) && !requestMutation.isPending;
  const handleSubmit = () => {
    if (selectedOrgId) {
      requestMutation.mutate({ organizationId: selectedOrgId });
    } else if (selectedOrgName.trim()) {
      requestMutation.mutate({ canonicalName: selectedOrgName.trim() });
    } else if (searchText.trim()) {
      requestMutation.mutate({ canonicalName: searchText.trim() });
    }
  };

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-2xl pb-28 md:pb-8">
      <div>
        <h1 className="text-xl md:text-2xl font-bold">我的单位</h1>
        <p className="text-sm text-muted-foreground mt-1">
          管理已绑定的单位，或申请绑定新单位
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <div className="flex-1">
            <OrganizationSelect
              value={selectedOrgId}
              displayValue={selectedOrgName || undefined}
              mode="rep-discover"
              onChange={(id, name) => {
                setSelectedOrgId(id || "");
                setSelectedOrgName(name);
              }}
              onSearchChange={setSearchText}
            />
          </div>
          <Button
            className="hidden md:inline-flex"
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {requestMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            <span className="ml-2">申请绑定</span>
          </Button>
        </div>
        {!selectedOrgId && searchText.trim() && (
          <div className="rounded-md border border-dashed p-3 text-sm">
            <p className="text-muted-foreground">
              未找到匹配单位「{searchText.trim()}」
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              disabled={requestMutation.isPending}
              onClick={() => requestMutation.mutate({ canonicalName: searchText.trim() })}
            >
              {requestMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              ) : (
                <Send className="h-3.5 w-3.5 mr-1" />
              )}
              提报新机构并申请绑定
            </Button>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          加载中...
        </div>
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">
              已绑定 ({active.length})
            </h2>
            {active.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无已绑定单位</p>
            ) : (
              <div className="grid gap-2">
                {active.map((b) => (
                  <Card key={b.id}>
                    <CardContent className="flex items-center gap-3 p-3">
                      <Building2 className="h-5 w-5 text-muted-foreground shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate">
                          {b.organization?.canonicalName || b.requestedOrganizationName}
                        </p>
                        {b.organization?.address && (
                          <p className="text-xs text-muted-foreground truncate">
                            {b.organization.address}
                          </p>
                        )}
                      </div>
                      <Badge variant="default">已绑定</Badge>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </section>

          {pending.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">
                待审核 ({pending.length})
              </h2>
              <div className="grid gap-2">
                {pending.map((b) => (
                  <Card key={b.id}>
                    <CardContent className="flex items-center gap-3 p-3">
                      <Building2 className="h-5 w-5 text-muted-foreground shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate">
                          {b.organization?.canonicalName || b.requestedOrganizationName || "未命名"}
                        </p>
                      </div>
                      <Badge variant="secondary">审核中</Badge>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          )}

          {rejected.length > 0 && (
            <section className="space-y-3">
              <button
                type="button"
                className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
                onClick={() => setShowRejected(!showRejected)}
              >
                <ChevronDown className={`h-4 w-4 transition-transform ${showRejected ? "rotate-180" : ""}`} />
                已拒绝 ({rejected.length})
              </button>
              {showRejected && (
                <div className="grid gap-2">
                  {rejected.map((b) => (
                    <Card key={b.id} className="border-destructive/30">
                      <CardContent className="flex items-start gap-3 p-3">
                        <Building2 className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <p className="font-medium truncate">
                            {b.organization?.canonicalName || b.requestedOrganizationName || "未命名"}
                          </p>
                          {b.reviewNote && (
                            <p className="text-xs text-destructive mt-1">
                              拒绝原因: {b.reviewNote}
                            </p>
                          )}
                        </div>
                        <Badge variant="destructive">已拒绝</Badge>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}

      <MobileActionDock
        primary={
          <MobileActionButton disabled={!canSubmit} onClick={handleSubmit}>
            {requestMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            <span className="ml-2">申请绑定</span>
          </MobileActionButton>
        }
      />
    </div>
  );
}
