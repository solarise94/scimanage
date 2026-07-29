"use client";

import { useState, useEffect, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Search, MapPin, Tag, Building2, Archive, Users, BarChart3,
  Pencil, Link2Off, FolderKanban, ShoppingCart, X,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { CustomerEditDialog } from "@/components/crm/customer-edit-dialog";
import { DataTable } from "@/components/ui/data-table";
import type { DataTableColumn } from "@/components/ui/data-table";
import { STAGE_LABELS, STAGE_COLORS, SITE_TYPE_LABELS } from "@/lib/crm/constants";

interface OrgAlias {
  id: string;
  alias: string;
  aliasType?: string;
}

interface OrgSiteDetail {
  id: string;
  siteName: string;
  siteType: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  _count: { customers: number };
}

interface OrgDetail {
  id: string;
  orgCode: string;
  canonicalName: string;
  normalizedName: string;
  address: string | null;
  taxId: string | null;
  isInvoiceSubject: boolean;
  invoiceAddress: string | null;
  invoicePhone: string | null;
  invoiceBankName: string | null;
  invoiceBankAccount: string | null;
  orgDataSource: string | null;
  taxIdVerifySource: string | null;
  taxIdVerifiedAt: string | null;
  archived: boolean;
  aliases: OrgAlias[];
  sites: OrgSiteDetail[];
  _count: { customers: number };
}

interface OrgCustomerRow {
  id: string;
  name: string;
  customerCode: string | null;
  organization: string | null;
  organizationSiteId: string | null;
  labOrGroup: string | null;
  principal: string | null;
  email: string | null;
  wechat: string | null;
  phone: string | null;
  orgSite: { siteName: string } | null;
  crmProfile: { id: string; stage: string; archived?: boolean } | null;
  _count: { projects: number; orders: number };
}

const PAGE_SIZE = 20;

export default function OrganizationDetailPage() {
  const params = useParams<{ id: string }>();
  const orgId = params.id;
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: session, status } = useSession();
  const { confirm } = useConfirm();

  const [tab, setTab] = useState("customers");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [siteFilter, setSiteFilter] = useState<string>(""); // "" = 全部，否则 siteId
  const [page, setPage] = useState(1);
  const [editCustomer, setEditCustomer] = useState<OrgCustomerRow | null>(null);

  useEffect(() => {
    if (status === "authenticated" && session?.user?.role !== "ADMIN") {
      router.push("/dashboard");
    }
  }, [status, session, router]);

  // 搜索防抖 + 重置分页
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const isAdmin = status === "authenticated" && session?.user?.role === "ADMIN";

  const { data: orgData, isLoading: orgLoading, error: orgError } = useQuery<{ organization: OrgDetail }>({
    queryKey: ["org-detail", orgId],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}`);
      if (res.status === 404) throw new Error("机构不存在");
      if (!res.ok) throw new Error("加载机构失败");
      return res.json();
    },
    enabled: isAdmin && !!orgId,
  });

  const org = orgData?.organization;

  const {
    data: custData,
    isLoading: custLoading,
    refetch: refetchCustomers,
  } = useQuery<{ customers: OrgCustomerRow[]; total: number; page: number; pageSize: number }>({
    queryKey: ["org-customers", orgId, siteFilter, debouncedSearch, page],
    queryFn: async () => {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (siteFilter) qs.set("siteId", siteFilter);
      if (debouncedSearch) qs.set("search", debouncedSearch);
      const res = await fetch(`/api/organizations/${orgId}/customers?${qs.toString()}`);
      if (!res.ok) throw new Error("加载客户列表失败");
      return res.json();
    },
    enabled: isAdmin && !!orgId && tab === "customers",
  });

  const unbindMutation = useMutation({
    mutationFn: async (profileId: string) => {
      const res = await fetch(`/api/customers/${profileId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-customer-api-caller": "admin-organization-detail" },
        body: JSON.stringify({
          organizationId: null,
          organization: null,
          organizationSiteId: null,
          organizationRawInput: null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "解绑失败");
      return data;
    },
    onSuccess: () => {
      toast.success("已解除该客户与机构的绑定");
      refetchCustomers();
      queryClient.invalidateQueries({ queryKey: ["org-detail", orgId] });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const customers = custData?.customers || [];
  const total = custData?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const activeSiteName = useMemo(() => {
    if (!siteFilter) return null;
    return org?.sites.find((s) => s.id === siteFilter)?.siteName || siteFilter;
  }, [siteFilter, org]);

  const customerColumns = useMemo<DataTableColumn<OrgCustomerRow>[]>(
    () => [
      {
        key: "name",
        header: "客户",
        render: (c) => (
          <div>
            <div className="flex items-center gap-2">
              <Link href={`/crm/customers/${c.id}`} className="font-medium hover:underline">
                {c.name}
              </Link>
              {c.crmProfile?.archived && <Badge variant="outline" className="text-[10px]">已归档</Badge>}
            </div>
            {c.customerCode && <div className="text-xs text-muted-foreground font-mono">{c.customerCode}</div>}
          </div>
        ),
      },
      { key: "site", header: "院区", render: (c) => c.orgSite?.siteName || "—" },
      { key: "labOrGroup", header: "课题组", render: (c) => c.labOrGroup || "—" },
      {
        key: "contact",
        header: "联系方式",
        render: (c) => (
          <div className="text-xs text-muted-foreground">
            {c.principal && <div>负责人：{c.principal}</div>}
            {c.phone && <div>{c.phone}</div>}
            {c.wechat && <div>微信：{c.wechat}</div>}
            {!c.principal && !c.phone && !c.wechat && "—"}
          </div>
        ),
      },
      {
        key: "stage",
        header: "CRM 阶段",
        render: (c) =>
          c.crmProfile?.stage ? (
            <Badge className={`text-[10px] ${STAGE_COLORS[c.crmProfile.stage] || ""}`} variant="secondary">
              {STAGE_LABELS[c.crmProfile.stage] || c.crmProfile.stage}
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">无</span>
          ),
      },
      {
        key: "counts",
        header: "项目/订单",
        align: "center",
        render: (c) => (
          <div className="text-xs text-muted-foreground inline-flex items-center justify-center gap-1">
            <span className="inline-flex items-center gap-1">
              <FolderKanban className="h-3 w-3" />{c._count.projects}
            </span>
            <span>/</span>
            <span className="inline-flex items-center gap-1">
              <ShoppingCart className="h-3 w-3" />{c._count.orders}
            </span>
          </div>
        ),
      },
      {
        key: "actions",
        header: "操作",
        align: "right",
        render: (c) => (
          <div className="flex items-center justify-end gap-1">
            <Button variant="ghost" size="sm" title="编辑客户" onClick={() => setEditCustomer(c)}>
              <Pencil className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              title="解除机构绑定"
              className="text-warning"
              disabled={unbindMutation.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: "解除机构绑定",
                  description: `确定将客户 "${c.name}" 从机构 "${org?.canonicalName}" 解绑？解绑后该客户将变为无机构状态，可在「无机构客户治理」中重新分配。`,
                  variant: "destructive",
                });
                if (ok) unbindMutation.mutate(c.id);
              }}
            >
              <Link2Off className="h-3 w-3" />
            </Button>
          </div>
        ),
      },
    ],
    [org?.canonicalName, unbindMutation, confirm]
  );

  if (status === "loading") return null;
  if (!session || session.user.role !== "ADMIN") return null;

  if (orgError) {
    return (
      <PageShell>
        <PageHeader title="机构详情" backHref="/admin/organizations" />
        <EmptyState
          title={orgError instanceof Error ? orgError.message : "加载失败"}
          description="无法加载该机构详情，请返回机构列表重试"
          action={
            <Button variant="outline" size="sm" render={<Link href="/admin/organizations" />}>
              返回机构列表
            </Button>
          }
        />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title={org?.canonicalName || "机构详情"}
        description={org ? `机构编码 ${org.orgCode}` : undefined}
        backHref="/admin/organizations"
        actions={
          org ? (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" render={<Link href={`/crm/customers?organizationId=${org.id}&organizationName=${encodeURIComponent(org.canonicalName)}`} />}>
                <Users className="mr-1.5 h-4 w-4" />CRM 客户
              </Button>
              <Button variant="outline" size="sm" render={<Link href={`/admin/organizations/${org.id}/analytics`} />}>
                <BarChart3 className="mr-1.5 h-4 w-4" />分析
              </Button>
            </div>
          ) : undefined
        }
      />

      {/* 顶部信息卡 */}
      {orgLoading || !org ? (
        <Skeleton className="h-32" />
      ) : (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-semibold">{org.canonicalName}</span>
            <span className="text-xs text-muted-foreground font-mono">{org.orgCode}</span>
            {org.archived && (
              <Badge variant="outline" className="text-xs"><Archive className="h-3 w-3 mr-1" />已归档</Badge>
            )}
            {org.isInvoiceSubject ? (
              <Badge className="text-xs bg-success-bg text-success hover:bg-success-bg">开票主体</Badge>
            ) : (
              <Badge variant="outline" className="text-xs text-warning border-warning-border">待验真</Badge>
            )}
            <Badge variant="secondary" className="text-xs">{org._count.customers} 客户</Badge>
            <Badge variant="secondary" className="text-xs">{org.sites.length} 院区</Badge>
          </div>
          {org.address && (
            <div className="text-sm text-muted-foreground"><MapPin className="h-3 w-3 inline mr-1" />{org.address}</div>
          )}
          {org.taxId && (
            <div className="text-sm text-muted-foreground">税号：<span className="font-mono">{org.taxId}</span></div>
          )}
          {(org.invoiceAddress || org.invoicePhone || org.invoiceBankName || org.invoiceBankAccount) && (
            <div className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground space-y-0.5">
              <div className="font-medium text-foreground">开票信息</div>
              {org.invoiceAddress && <div>地址：{org.invoiceAddress}</div>}
              {org.invoicePhone && <div>电话：{org.invoicePhone}</div>}
              {org.invoiceBankName && <div>开户行：{org.invoiceBankName}</div>}
              {org.invoiceBankAccount && <div>银行账号：{org.invoiceBankAccount}</div>}
            </div>
          )}
          {org.aliases.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <Tag className="h-3 w-3 text-muted-foreground shrink-0" />
              {org.aliases.map((a) => (
                <Badge key={a.id} variant="outline" className="text-xs">{a.alias}</Badge>
              ))}
            </div>
          )}
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as string)}>
        <TabsList>
          <TabsTrigger value="customers">下辖客户{org ? ` (${org._count.customers})` : ""}</TabsTrigger>
          <TabsTrigger value="sites">院区{org ? ` (${org.sites.length})` : ""}</TabsTrigger>
        </TabsList>

        {/* 下辖客户 Tab */}
        <TabsContent value="customers" className="mt-3 space-y-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="搜索客户姓名/编码..." className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            {siteFilter && (
              <Button variant="outline" size="sm" onClick={() => { setSiteFilter(""); setPage(1); }}>
                院区：{activeSiteName}
                <X className="ml-1.5 h-3 w-3" />
              </Button>
            )}
          </div>

          <DataTable
            columns={customerColumns}
            data={customers}
            keyExtractor={(c) => c.id}
            isLoading={custLoading}
            emptyTitle={debouncedSearch || siteFilter ? "未找到匹配的客户" : "该机构下暂无客户"}
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              totalPages,
              onPageChange: setPage,
            }}
          />
        </TabsContent>

        {/* 院区 Tab */}
        <TabsContent value="sites" className="mt-3 space-y-3">
          {orgLoading || !org ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : org.sites.length === 0 ? (
            <EmptyState title="该机构暂无院区/校区" description="可在机构管理中为此机构添加院区或校区" />
          ) : (
            <div className="space-y-2">
              {org.sites.map((s) => (
                <div key={s.id} className="rounded-lg border bg-card p-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="font-medium">{s.siteName}</span>
                      <Badge variant="secondary" className="text-[10px]">{SITE_TYPE_LABELS[s.siteType] || "院区"}</Badge>
                      {Number.isFinite(s.lat as number) && Number.isFinite(s.lng as number) && (
                        <Badge variant="outline" className="text-[10px] text-success border-success-border">已定位</Badge>
                      )}
                    </div>
                    {s.address && <div className="text-xs text-muted-foreground mt-1"><MapPin className="h-3 w-3 inline mr-1" />{s.address}</div>}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSiteFilter(s.id);
                      setPage(1);
                      setTab("customers");
                    }}
                  >
                    <Users className="mr-1.5 h-3.5 w-3.5" />{s._count.customers} 客户
                  </Button>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* 编辑客户弹窗（复用 CRM 编辑组件；非 CRM 客户也安全，CRM 档案为可选） */}
      {editCustomer?.crmProfile?.id && (
        <CustomerEditDialog
          profileId={editCustomer.crmProfile.id}
          initialCustomer={editCustomer}
          open={!!editCustomer}
          canEdit
          onOpenChange={(open) => {
            if (!open) {
              setEditCustomer(null);
              // 编辑弹窗只失效 CRM query keys，这里手动刷新机构维度客户列表
              refetchCustomers();
              queryClient.invalidateQueries({ queryKey: ["org-detail", orgId] });
            }
          }}
        />
      )}
    </PageShell>
  );
}
