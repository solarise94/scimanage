"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Plus, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OrganizationSelect } from "@/components/organization-select";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";
import { toast } from "sonner";

export interface CustomerSelectOption {
  /** Profile 主键（与 id 相同）。 */
  profileId: string;
  /** @deprecated 与 profileId 相同 */
  id: string;
  customerCode: string;
  name: string;
  organization: string | null;
  organizationId: string | null;
  principal: string | null;
  wechat: string | null;
  address: string | null;
  representativeId: string | null;
  representativeName: string | null;
}

interface CustomerSelectProps {
  value: string;
  displayValue?: string;
  onChange: (
    profileId: string | null,
    name: string,
    organization?: string | null,
    organizationId?: string | null,
    customer?: CustomerSelectOption | null,
  ) => void;
  quickCreateDefaults?: {
    name?: string;
    principal?: string;
    wechat?: string;
    organization?: string;
    organizationId?: string;
    address?: string;
  };
  /** When true, fetches only customers within the user's CRM scope. Use in CRM relation dialogs to match POST /api/crm/relations gate. */
  crmScopeOnly?: boolean;
}

export function CustomerSelect({ value, displayValue, onChange, quickCreateDefaults, crmScopeOnly }: CustomerSelectProps) {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [quickName, setQuickName] = useState("");
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  // U2：快速新建客户也必须选机构。内嵌机构选择器状态，默认带入 quickCreateDefaults。
  const [quickOrgId, setQuickOrgId] = useState("");
  const [quickOrgName, setQuickOrgName] = useState("");
  const isMobile = useMediaQuery("(max-width: 767px)");
  // A1：缓存已选客户（按 id 索引），避免清空搜索后当前结果集变化导致 trigger label 丢失。
  const [selectedCache, setSelectedCache] = useState<Record<string, { id: string; name: string; customerCode: string }>>({});

  // REPRESENTATIVE cannot create customers at all. REGIONAL_MANAGER cannot
  // quick-add in CRM-scoped contexts because the new customer would have no CRM
  // profile, and subsequent CRM operations (profile create, relation create) will 403.
  const isReadOnly = session?.user?.role === "REPRESENTATIVE" || (crmScopeOnly && session?.user?.role === "REGIONAL_MANAGER");

  useEffect(() => {
    if (isComposing) return;
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, 200);
    return () => window.clearTimeout(timer);
  }, [isComposing, search]);

  const listUrl = (() => {
    const params = new URLSearchParams();
    if (crmScopeOnly) params.set("crmScope", "true");
    if (debouncedSearch) params.set("search", debouncedSearch);
    params.set("limit", debouncedSearch ? "20" : "100");
    const qs = params.toString();
    return `/api/customers/list${qs ? `?${qs}` : ""}`;
  })();

  const { data } = useQuery<{ customers: CustomerSelectOption[] }>({
    queryKey: ["customers-list", crmScopeOnly ? "crm" : "all", debouncedSearch],
    queryFn: async () => {
      const res = await fetch(listUrl, { headers: { "x-customer-api-caller": "customer-select" } });
      if (!res.ok) throw new Error("Failed to load customers");
      return res.json();
    },
    enabled: open,
  });

  const quickCreateMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-customer-api-caller": "customer-select" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "创建失败");
      return data.customer as CustomerSelectOption;
    },
    onSuccess: (customer) => {
      toast.success(`客户 "${customer.name}" 已创建`);
      onChange(customer.profileId, customer.name, customer.organization, customer.organizationId, customer);
      setQuickName("");
      setQuickOrgId("");
      setQuickOrgName("");
      setShowQuickAdd(false);
      setSearch("");
      setDebouncedSearch("");
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ["customers-list"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const custs = data?.customers || [];
  const selected = custs.find((c) => c.profileId === value || c.id === value);

  const handleSelect = (cust: CustomerSelectOption | null) => {
    if (cust) {
      setSelectedCache((prev) => ({
        ...prev,
        [cust.profileId]: { id: cust.profileId, name: cust.name, customerCode: cust.customerCode },
      }));
      onChange(cust.profileId, cust.name, cust.organization, cust.organizationId, cust);
    } else {
      onChange(null, "");
    }
    setSearch("");
    setIsComposing(false);
    setDebouncedSearch("");
    setOpen(false);
  };

  const handleQuickCreate = () => {
    const name = quickName.trim();
    if (!name) return;
    // U2：机构必填——必须有已选机构 id，或一个可自动建机构的机构名。两者皆空则拒绝。
    const orgId = quickOrgId || quickCreateDefaults?.organizationId || "";
    const orgName = quickOrgName.trim() || quickCreateDefaults?.organization?.trim() || "";
    if (!orgId && !orgName) {
      toast.error("请先选择或填写客户单位（机构必填）");
      return;
    }
    quickCreateMutation.mutate({
      name,
      principal: (quickCreateDefaults?.principal || undefined) as string | undefined,
      wechat: (quickCreateDefaults?.wechat || undefined) as string | undefined,
      organization: (orgName || undefined) as string | undefined,
      organizationId: (orgId || undefined) as string | undefined,
      address: (quickCreateDefaults?.address || undefined) as string | undefined,
      organizationRawInput: (orgName || undefined) as string | undefined,
      autoCreateOrganization: true,
    });
  };

  // 打开快速新建时带入默认机构，便于在订单/草稿流里一键复用买方单位。
  const openQuickAdd = () => {
    setQuickOrgId(quickCreateDefaults?.organizationId || "");
    setQuickOrgName(quickCreateDefaults?.organization || "");
    setShowQuickAdd(true);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setSearch("");
      setIsComposing(false);
      setDebouncedSearch("");
    }
  };

  const cached = value ? selectedCache[value] : undefined;
  const triggerLabel = selected
    ? `${selected.name} (${selected.customerCode})`
    : cached
      ? `${cached.name} (${cached.customerCode})`
      : displayValue || "选择客户...";

  const trigger = (
    <Button
      variant="outline"
      role="combobox"
      aria-expanded={open}
      className="w-full justify-between"
    >
      <span className="truncate">{triggerLabel}</span>
      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
    </Button>
  );

  const listContent = (
    <Command className={isMobile ? "min-h-0 flex-1" : undefined} shouldFilter={false}>
      <div className="relative px-2 pt-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 mt-1 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          inputMode="search"
          autoComplete="off"
          aria-label="搜索客户"
          placeholder="搜索客户..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={(event) => {
            setSearch(event.currentTarget.value);
            setIsComposing(false);
          }}
          className="h-9 pl-8 text-sm"
        />
      </div>
      <CommandList className={isMobile ? "min-h-0 flex-1" : undefined}>
        <CommandEmpty>
          <div className="py-2 text-center text-sm text-muted-foreground">
            {isReadOnly ? "未找到客户" : "未找到客户，可快速添加"}
          </div>
        </CommandEmpty>
        <CommandGroup>
          <CommandItem
            onSelect={() => handleSelect(null)}
          >
            <Check className={cn("mr-2 h-4 w-4", !value ? "opacity-100" : "opacity-0")} />
            不选择客户
          </CommandItem>
          {custs.map((c) => (
            <CommandItem
              key={c.id}
              value={[
                c.id,
                c.customerCode,
                c.name,
                c.organization,
                c.principal,
                c.wechat,
                c.representativeName,
              ].filter(Boolean).join(" ")}
              onSelect={() => handleSelect(c)}
            >
              <Check className={cn("mr-2 h-4 w-4", value === c.id ? "opacity-100" : "opacity-0")} />
              <div className="flex flex-col">
                <span>{c.name} <span className="text-xs text-muted-foreground">({c.customerCode})</span></span>
                {c.organization && <span className="text-xs text-muted-foreground">{c.organization}</span>}
                {(c.principal || c.wechat) && (
                  <span className="text-xs text-muted-foreground">
                    {[c.principal, c.wechat].filter(Boolean).join(" / ")}
                  </span>
                )}
                {c.representativeName && (
                  <span className="text-xs text-blue-600">代表: {c.representativeName}</span>
                )}
              </div>
            </CommandItem>
          ))}
        </CommandGroup>
        {!isReadOnly && (
          <CommandGroup>
            {showQuickAdd ? (
              <div className="flex flex-col gap-2 p-2">
                <Input
                  placeholder="客户姓名"
                  value={quickName}
                  onChange={(e) => setQuickName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && quickName.trim()) {
                      e.preventDefault();
                      handleQuickCreate();
                    }
                    if (e.key === "Escape") setShowQuickAdd(false);
                  }}
                  className="h-8 text-sm"
                  autoFocus={!isMobile}
                />
                <div>
                  <label className="text-xs text-muted-foreground">单位（必填）</label>
                  <OrganizationSelect
                    value={quickOrgId}
                    displayValue={quickOrgName}
                    onChange={(id, canonicalName) => {
                      setQuickOrgId(id || "");
                      setQuickOrgName(canonicalName || "");
                    }}
                  />
                </div>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 shrink-0"
                    onClick={() => setShowQuickAdd(false)}
                  >
                    取消
                  </Button>
                  <Button
                    size="sm"
                    className="h-8 shrink-0"
                    disabled={!quickName.trim() || (!quickOrgId && !quickOrgName.trim()) || quickCreateMutation.isPending}
                    onClick={handleQuickCreate}
                  >
                    {quickCreateMutation.isPending ? "..." : "添加"}
                  </Button>
                </div>
              </div>
            ) : (
              <CommandItem onSelect={openQuickAdd}>
                <Plus className="mr-2 h-4 w-4" />
                快速添加客户
              </CommandItem>
            )}
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  );

  if (isMobile) {
    return (
      <>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between"
          onClick={() => setOpen(true)}
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
        <Sheet open={open} onOpenChange={handleOpenChange}>
          <SheetContent side="bottom" className="max-h-[85dvh] flex flex-col p-0">
            <SheetHeader className="px-4 pt-4 pb-2">
              <SheetTitle>选择客户</SheetTitle>
            </SheetHeader>
            {listContent}
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger render={trigger} />
      <PopoverContent className="w-full p-0" align="start">
        {listContent}
      </PopoverContent>
    </Popover>
  );
}
