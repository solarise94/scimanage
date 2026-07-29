"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Plus, Building2, Link2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
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

interface OrgOption {
  id: string;
  orgCode: string;
  canonicalName: string;
  address: string | null;
  taxId: string | null;
  availability?: string;
  availabilityLabel?: string;
}

interface RepBinding {
  id: string;
  status: string;
  organizationId: string | null;
  requestedOrganizationName: string | null;
  organization: {
    id: string;
    canonicalName: string;
    address: string | null;
  } | null;
}

type SelectMode = "default" | "rep-bound" | "rep-discover";

interface OrganizationSelectProps {
  value: string;
  displayValue?: string;
  disabled?: boolean;
  mode?: SelectMode;
  onChange: (id: string | null, canonicalName: string, address?: string | null, taxId?: string | null) => void;
  onSearchChange?: (search: string) => void;
}

function OrgList({
  value,
  search,
  onSearchChange,
  orgs,
  onSelect,
  quickName,
  onQuickNameChange,
  showQuickAdd,
  onToggleQuickAdd,
  quickCreateMutation,
  hideQuickAdd,
  disableUnavailable = true,
  autoFocusSearch = true,
}: {
  value: string;
  search: string;
  onSearchChange: (v: string) => void;
  orgs: OrgOption[];
  onSelect: (o: OrgOption) => void;
  quickName: string;
  onQuickNameChange: (v: string) => void;
  showQuickAdd: boolean;
  onToggleQuickAdd: (show: boolean) => void;
  quickCreateMutation: {
    isPending: boolean;
    mutate: (name: string) => void;
  };
  hideQuickAdd?: boolean;
  autoFocusSearch?: boolean;
  disableUnavailable?: boolean;
}) {
  const isUnavailable = (o: OrgOption): boolean =>
    o.availability !== undefined && o.availability !== "" && o.availability !== "AVAILABLE";
  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="p-3 border-b">
        <Input
          placeholder="搜索单位..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="h-9 text-sm"
          autoFocus={autoFocusSearch}
        />
      </div>
      <div className="flex-1 overflow-y-auto min-w-0">
        <button
          type="button"
          className="w-full text-left px-3 py-2.5 text-sm hover:bg-accent flex items-center gap-2 min-w-0"
          onClick={() => onSelect({ id: "", orgCode: "", canonicalName: "", address: null, taxId: null } as OrgOption)}
        >
          <Check className={cn("h-4 w-4 shrink-0", !value ? "opacity-100" : "opacity-0")} />
          <span>不选择单位</span>
        </button>
        {orgs.map((o) => (
          <button
            key={o.id}
            type="button"
            disabled={disableUnavailable && isUnavailable(o)}
            className={cn(
              "w-full text-left px-3 py-2.5 text-sm flex items-center gap-2 min-w-0",
              disableUnavailable && isUnavailable(o)
                ? "opacity-50 cursor-not-allowed"
                : "hover:bg-accent"
            )}
            onClick={() => (!disableUnavailable || !isUnavailable(o)) && onSelect(o)}
          >
            <Check className={cn("h-4 w-4 shrink-0", value === o.id ? "opacity-100" : "opacity-0")} />
            <div className="flex flex-col min-w-0 flex-1">
              <span className="truncate">{o.canonicalName} <span className="text-xs text-muted-foreground">({o.orgCode})</span></span>
              {o.address && <span className="text-xs text-muted-foreground truncate">{o.address}</span>}
            </div>
            {o.availabilityLabel && (
              <Badge variant={o.availability === "AVAILABLE" ? "outline" : "secondary"} className="shrink-0 text-[10px]">
                {o.availabilityLabel}
              </Badge>
            )}
          </button>
        ))}
        {orgs.length === 0 && search && (
          <div className="px-3 py-4 text-center text-sm text-muted-foreground">
            未找到匹配单位
          </div>
        )}
      </div>
      {!hideQuickAdd && (
        <div className="border-t p-3">
          {showQuickAdd ? (
            <div className="flex items-center gap-2">
              <Input
                placeholder="单位名称"
                value={quickName}
                onChange={(e) => onQuickNameChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && quickName.trim()) {
                    e.preventDefault();
                    quickCreateMutation.mutate(quickName.trim());
                  }
                  if (e.key === "Escape") onToggleQuickAdd(false);
                }}
                className="h-9 text-sm"
                autoFocus
              />
              <Button
                size="sm"
                className="h-9 shrink-0"
                disabled={!quickName.trim() || quickCreateMutation.isPending}
                onClick={() => quickName.trim() && quickCreateMutation.mutate(quickName.trim())}
              >
                {quickCreateMutation.isPending ? "..." : "添加"}
              </Button>
            </div>
          ) : (
            <button
              type="button"
              className="flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-accent rounded-sm w-full"
              onClick={() => onToggleQuickAdd(true)}
            >
              <Plus className="h-4 w-4" />
              快速添加单位
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function normalizeOrgName(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

function RepOrgList({
  value,
  displayValue,
  search,
  onSearchChange,
  bindings,
  onSelect,
  onUseRawName,
  onRequestBinding,
  requestPending,
  isLoading,
  loadError,
  autoFocusSearch = true,
}: {
  value: string;
  displayValue?: string;
  search: string;
  onSearchChange: (v: string) => void;
  bindings: RepBinding[];
  onSelect: (binding: RepBinding) => void;
  onUseRawName: (name: string) => void;
  onRequestBinding: (name: string) => void;
  requestPending: boolean;
  isLoading: boolean;
  loadError: string | null;
  autoFocusSearch?: boolean;
}) {
  const trimmedSearch = search.trim();
  const normalizedSearch = normalizeOrgName(trimmedSearch);

  const activeBindings = bindings.filter((binding) => binding.status === "ACTIVE" && binding.organization);
  const pendingBindings = bindings.filter((binding) => binding.status === "PENDING");
  const filteredActiveBindings = trimmedSearch
    ? activeBindings.filter((binding) => normalizeOrgName(binding.organization?.canonicalName || "").includes(normalizedSearch))
    : activeBindings;

  const exactActiveBinding = trimmedSearch
    ? activeBindings.find((binding) => normalizeOrgName(binding.organization?.canonicalName || "") === normalizedSearch)
    : null;
  const exactPendingBinding = trimmedSearch
    ? pendingBindings.find((binding) => normalizeOrgName(binding.organization?.canonicalName || binding.requestedOrganizationName || "") === normalizedSearch)
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b p-3">
        <Input
          placeholder="搜索已绑定单位或输入新单位"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="h-9 text-sm"
          autoFocus={autoFocusSearch}
        />
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-accent"
          onClick={() => onUseRawName("")}
        >
          <Check className={cn("h-4 w-4 shrink-0", !value && !(displayValue || "").trim() ? "opacity-100" : "opacity-0")} />
          <span>不选择单位</span>
        </button>
        {filteredActiveBindings.map((binding) => {
          const organization = binding.organization;
          if (!organization) return null;
          return (
            <button
              key={binding.id}
              type="button"
              className="flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-accent"
              onClick={() => onSelect(binding)}
            >
              <Check className={cn("h-4 w-4 shrink-0", value === organization.id ? "opacity-100" : "opacity-0")} />
              <div className="flex min-w-0 flex-col">
                <span className="truncate">{organization.canonicalName}</span>
                {organization.address && (
                  <span className="truncate text-xs text-muted-foreground">{organization.address}</span>
                )}
              </div>
            </button>
          );
        })}
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 px-3 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>正在加载已绑定单位...</span>
          </div>
        ) : null}
        {loadError ? (
          <div className="px-3 py-4 text-center text-sm text-destructive">
            {loadError}
          </div>
        ) : null}
        {!isLoading && !loadError && filteredActiveBindings.length === 0 && (
          <div className="px-3 py-4 text-center text-sm text-muted-foreground">
            {trimmedSearch ? "未找到已绑定单位" : "暂无已绑定单位"}
          </div>
        )}
        {!isLoading && !loadError && pendingBindings.length > 0 && !trimmedSearch && (
          <div className="border-t px-3 py-3">
            <p className="mb-2 text-xs text-muted-foreground">待审核绑定</p>
            <div className="space-y-2">
              {pendingBindings.slice(0, 4).map((binding) => (
                <div key={binding.id} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-sm">
                  <span className="truncate">{binding.organization?.canonicalName || binding.requestedOrganizationName || "未命名单位"}</span>
                  <Badge variant="secondary">审核中</Badge>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="border-t p-3">
        {trimmedSearch ? (
          <div className="space-y-2">
            {exactPendingBinding ? (
              <div className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning">
                该单位的绑定申请已提交，正在等待审核。
              </div>
            ) : null}
            {!exactActiveBinding ? (
              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="justify-start"
                  onClick={() => onUseRawName(trimmedSearch)}
                >
                  直接使用“{trimmedSearch}”
                </Button>
                <Button
                  type="button"
                  className="justify-start"
                  disabled={requestPending || !!exactPendingBinding}
                  onClick={() => onRequestBinding(trimmedSearch)}
                >
                  {requestPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
                  申请绑定“{trimmedSearch}”
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">已在上方已绑定机构中找到精确匹配，可直接选择。</p>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            只能搜索自己已绑定的机构。若未找到，可输入名称后提交绑定申请。
          </p>
        )}
      </div>
    </div>
  );
}

function OrgCommand({
  value,
  search,
  onSearchChange,
  orgs,
  onSelect,
  quickName,
  onQuickNameChange,
  showQuickAdd,
  onToggleQuickAdd,
  quickCreateMutation,
  hideQuickAdd,
  disableUnavailable = true,
}: {
  value: string;
  search: string;
  onSearchChange: (v: string) => void;
  orgs: OrgOption[];
  onSelect: (o: OrgOption) => void;
  quickName: string;
  onQuickNameChange: (v: string) => void;
  showQuickAdd: boolean;
  onToggleQuickAdd: (show: boolean) => void;
  quickCreateMutation: { isPending: boolean; mutate: (name: string) => void };
  hideQuickAdd?: boolean;
  disableUnavailable?: boolean;
}) {
  const isUnavailable = (o: OrgOption): boolean =>
    o.availability !== undefined && o.availability !== "" && o.availability !== "AVAILABLE";
  return (
    <Command shouldFilter={false} className="flex flex-col min-h-0 flex-1">
      <CommandInput
        placeholder="搜索单位..."
        value={search}
        onValueChange={onSearchChange}
      />
      <CommandList>
        <CommandEmpty>未找到匹配单位</CommandEmpty>
        <CommandItem
          value="__none__"
          onSelect={() => onSelect({ id: "", orgCode: "", canonicalName: "", address: null, taxId: null } as OrgOption)}
        >
          <Check className={cn("h-4 w-4 shrink-0", !value ? "opacity-100" : "opacity-0")} />
          <span>不选择单位</span>
        </CommandItem>
        {orgs.map((o) => (
          <CommandItem
            key={o.id}
            value={o.id}
            disabled={disableUnavailable && isUnavailable(o)}
            onSelect={() => onSelect(o)}
          >
            <Check className={cn("h-4 w-4 shrink-0", value === o.id ? "opacity-100" : "opacity-0")} />
            <div className="flex flex-col min-w-0 flex-1">
              <span className="truncate">
                {o.canonicalName} <span className="text-xs text-muted-foreground">({o.orgCode})</span>
              </span>
              {o.address && <span className="text-xs text-muted-foreground truncate">{o.address}</span>}
            </div>
            {o.availabilityLabel && (
              <Badge variant={o.availability === "AVAILABLE" ? "outline" : "secondary"} className="shrink-0 text-[10px]">
                {o.availabilityLabel}
              </Badge>
            )}
          </CommandItem>
        ))}
      </CommandList>
      {!hideQuickAdd && (
        <div className="border-t p-3">
          {showQuickAdd ? (
            <div className="flex items-center gap-2">
              <Input
                placeholder="单位名称"
                value={quickName}
                onChange={(e) => onQuickNameChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && quickName.trim()) {
                    e.preventDefault();
                    quickCreateMutation.mutate(quickName.trim());
                  }
                  if (e.key === "Escape") onToggleQuickAdd(false);
                }}
                className="h-9 text-sm"
                autoFocus
              />
              <Button
                size="sm"
                className="h-9 shrink-0"
                disabled={!quickName.trim() || quickCreateMutation.isPending}
                onClick={() => quickName.trim() && quickCreateMutation.mutate(quickName.trim())}
              >
                {quickCreateMutation.isPending ? "..." : "添加"}
              </Button>
            </div>
          ) : (
            <button
              type="button"
              className="flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-accent rounded-sm w-full"
              onClick={() => onToggleQuickAdd(true)}
            >
              <Plus className="h-4 w-4" />
              快速添加单位
            </button>
          )}
        </div>
      )}
    </Command>
  );
}

function RepOrgCommand({
  value,
  displayValue,
  search,
  onSearchChange,
  bindings,
  onSelect,
  onUseRawName,
  onRequestBinding,
  requestPending,
  isLoading,
  loadError,
}: {
  value: string;
  displayValue?: string;
  search: string;
  onSearchChange: (v: string) => void;
  bindings: RepBinding[];
  onSelect: (binding: RepBinding) => void;
  onUseRawName: (name: string) => void;
  onRequestBinding: (name: string) => void;
  requestPending: boolean;
  isLoading: boolean;
  loadError: string | null;
}) {
  const trimmedSearch = search.trim();
  const normalizedSearch = normalizeOrgName(trimmedSearch);

  const activeBindings = bindings.filter((binding) => binding.status === "ACTIVE" && binding.organization);
  const pendingBindings = bindings.filter((binding) => binding.status === "PENDING");
  const filteredActiveBindings = trimmedSearch
    ? activeBindings.filter((binding) => normalizeOrgName(binding.organization?.canonicalName || "").includes(normalizedSearch))
    : activeBindings;

  const exactActiveBinding = trimmedSearch
    ? activeBindings.find((binding) => normalizeOrgName(binding.organization?.canonicalName || "") === normalizedSearch)
    : null;
  const exactPendingBinding = trimmedSearch
    ? pendingBindings.find((binding) => normalizeOrgName(binding.organization?.canonicalName || binding.requestedOrganizationName || "") === normalizedSearch)
    : null;

  return (
    <Command shouldFilter={false} className="flex min-h-0 flex-1 flex-col">
      <CommandInput
        placeholder="搜索已绑定单位或输入新单位"
        value={search}
        onValueChange={onSearchChange}
      />
      <CommandList>
        {loadError ? (
          <CommandEmpty>
            <span className="text-destructive">{loadError}</span>
          </CommandEmpty>
        ) : isLoading ? (
          <CommandEmpty>正在加载已绑定单位...</CommandEmpty>
        ) : (
          <CommandEmpty>{trimmedSearch ? "未找到已绑定单位" : "暂无已绑定单位"}</CommandEmpty>
        )}
        <CommandItem value="__none__" onSelect={() => onUseRawName("")}>
          <Check className={cn("h-4 w-4 shrink-0", !value && !(displayValue || "").trim() ? "opacity-100" : "opacity-0")} />
          <span>不选择单位</span>
        </CommandItem>
        {filteredActiveBindings.map((binding) => {
          const organization = binding.organization;
          if (!organization) return null;
          return (
            <CommandItem key={binding.id} value={organization.id} onSelect={() => onSelect(binding)}>
              <Check className={cn("h-4 w-4 shrink-0", value === organization.id ? "opacity-100" : "opacity-0")} />
              <div className="flex min-w-0 flex-col">
                <span className="truncate">{organization.canonicalName}</span>
                {organization.address && (
                  <span className="truncate text-xs text-muted-foreground">{organization.address}</span>
                )}
              </div>
            </CommandItem>
          );
        })}
        {!isLoading && !loadError && pendingBindings.length > 0 && !trimmedSearch && (
          <CommandGroup heading="待审核绑定">
            {pendingBindings.slice(0, 4).map((binding) => (
              <div key={binding.id} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-sm">
                <span className="truncate">
                  {binding.organization?.canonicalName || binding.requestedOrganizationName || "未命名单位"}
                </span>
                <Badge variant="secondary">审核中</Badge>
              </div>
            ))}
          </CommandGroup>
        )}
      </CommandList>
      <div className="border-t p-3">
        {trimmedSearch ? (
          <div className="space-y-2">
            {exactPendingBinding ? (
              <div className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning">
                该单位的绑定申请已提交，正在等待审核。
              </div>
            ) : null}
            {!exactActiveBinding ? (
              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="justify-start"
                  onClick={() => onUseRawName(trimmedSearch)}
                >
                  直接使用“{trimmedSearch}”
                </Button>
                <Button
                  type="button"
                  className="justify-start"
                  disabled={requestPending || !!exactPendingBinding}
                  onClick={() => onRequestBinding(trimmedSearch)}
                >
                  {requestPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
                  申请绑定“{trimmedSearch}”
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">已在上方已绑定机构中找到精确匹配，可直接选择。</p>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            只能搜索自己已绑定的机构。若未找到，可输入名称后提交绑定申请。
          </p>
        )}
      </div>
    </Command>
  );
}

export function OrganizationSelect({ value, displayValue, disabled, mode = "default", onChange, onSearchChange }: OrganizationSelectProps) {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [quickName, setQuickName] = useState("");
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const isMobile = useMediaQuery("(max-width: 767px)");

  const isRep = session?.user?.role === "REPRESENTATIVE";
  const isRepDiscover = mode === "rep-discover";

  const {
    data: repBindingsData,
    isLoading: repBindingsLoading,
    error: repBindingsQueryError,
  } = useQuery<{ bindings: RepBinding[] }>({
    queryKey: ["representative-organizations", "self"],
    queryFn: async () => {
      const res = await fetch("/api/crm/representative-organizations");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load representative organizations");
      return data;
    },
    enabled: isRep && open,
  });

  const { data } = useQuery<{ organizations: OrgOption[] }>({
    queryKey: ["organizations-list", search],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      const res = await fetch(`/api/organizations/list?${params}`);
      if (!res.ok) throw new Error("Failed to load organizations");
      return res.json();
    },
    enabled: (!isRep || isRepDiscover) && open,
  });

  const quickCreateMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch("/api/organizations/quick-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canonicalName: name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "创建失败");
      return { org: data.organization as OrgOption, created: data.created as boolean };
    },
    onSuccess: ({ org, created }) => {
      if (created) {
        toast.success(`单位 "${org.canonicalName}" 已创建`);
      } else {
        toast.info(`已存在同名单位：${org.canonicalName}`);
      }
      onChange(org.id, org.canonicalName, org.address, org.taxId);
      setQuickName("");
      setShowQuickAdd(false);
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ["organizations-list"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const requestBindingMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch("/api/crm/representative-organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canonicalName: name }),
      });
      const data = await res.json();
      if (!res.ok) {
        const error = data.error || "申请绑定失败";
        const err = new Error(error) as Error & { status?: number; payload?: unknown };
        err.status = res.status;
        err.payload = data;
        throw err;
      }
      return data as { binding?: RepBinding };
    },
    onSuccess: (data, requestedName) => {
      const bindingName = data.binding?.organization?.canonicalName || data.binding?.requestedOrganizationName || requestedName;
      toast.success(`已提交“${bindingName}”的绑定申请`);
      onChange(null, bindingName);
      setOpen(false);
      setSearch("");
      onSearchChange?.("");
      queryClient.invalidateQueries({ queryKey: ["representative-organizations"] });
      queryClient.invalidateQueries({ queryKey: ["representative-organizations", "self"] });
    },
    onError: (err: Error & { status?: number; payload?: { binding?: RepBinding } }) => {
      if (err.status === 409) {
        const existingName = err.payload?.binding?.organization?.canonicalName || err.payload?.binding?.requestedOrganizationName || search.trim();
        toast.info(`“${existingName}”已有绑定申请或绑定记录`);
        onChange(null, existingName);
        setOpen(false);
        setSearch("");
        onSearchChange?.("");
        queryClient.invalidateQueries({ queryKey: ["representative-organizations"] });
        queryClient.invalidateQueries({ queryKey: ["representative-organizations", "self"] });
        return;
      }
      toast.error(err.message);
    },
  });

  const orgs = data?.organizations || [];
  const selected = orgs.find((o) => o.id === value);
  const repBindings = repBindingsData?.bindings || [];
  const repBindingsError = repBindingsQueryError instanceof Error ? repBindingsQueryError.message : null;
  const selectedRepBinding = repBindings.find((binding) => binding.organizationId === value && binding.organization);

  const handleSearchValueChange = (nextValue: string) => {
    setSearch(nextValue);
    onSearchChange?.(nextValue);
  };

  const handleSelect = (o: OrgOption) => {
    onChange(o.id || null, o.canonicalName, o.address, o.taxId);
    setOpen(false);
    setSearch("");
    onSearchChange?.("");
    setShowQuickAdd(false);
    setQuickName("");
  };

  const handleOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v) {
      setSearch("");
      onSearchChange?.("");
      setShowQuickAdd(false);
      setQuickName("");
    }
  };

  if (disabled) {
    return (
      <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm bg-muted/50">
        <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
        <span>{displayValue || "未选择单位"}</span>
      </div>
    );
  }

  if (isRep && !isRepDiscover) {
    const repDesktopTrigger = (
      <Button
        variant="outline"
        role="combobox"
        aria-expanded={open}
        className="w-full justify-between"
      >
        <span className="truncate">
          {selectedRepBinding?.organization?.canonicalName || displayValue || "选择或输入单位..."}
        </span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </Button>
    );

    const repMobileTrigger = (
      <Button
        variant="outline"
        role="combobox"
        aria-expanded={open}
        className="w-full justify-between"
        onClick={() => setOpen(true)}
      >
        <span className="truncate">
          {selectedRepBinding?.organization?.canonicalName || displayValue || "选择或输入单位..."}
        </span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </Button>
    );

    const repList = (
        <RepOrgList
          value={value}
          displayValue={displayValue}
          search={search}
          onSearchChange={handleSearchValueChange}
          bindings={repBindings}
          onSelect={(binding) => {
            const organization = binding.organization;
          if (!organization) return;
          onChange(organization.id, organization.canonicalName, organization.address, null);
          setOpen(false);
          setSearch("");
      onSearchChange?.("");
        }}
        onUseRawName={(name) => {
          onChange(null, name);
          setOpen(false);
          setSearch("");
      onSearchChange?.("");
        }}
        onRequestBinding={(name) => requestBindingMutation.mutate(name)}
        requestPending={requestBindingMutation.isPending}
        isLoading={repBindingsLoading}
        loadError={repBindingsError}
        autoFocusSearch={!isMobile}
      />
    );

    if (isMobile) {
      return (
        <>
          {repMobileTrigger}
          <Sheet open={open} onOpenChange={handleOpenChange}>
            <SheetContent side="bottom" className="max-h-[85dvh] flex flex-col p-0">
              <SheetHeader className="px-4 pt-4 pb-2">
                <SheetTitle>选择单位</SheetTitle>
              </SheetHeader>
              {repList}
            </SheetContent>
          </Sheet>
        </>
      );
    }

    return (
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger render={repDesktopTrigger} />
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0 max-h-[400px]" align="start">
          <RepOrgCommand
            value={value}
            displayValue={displayValue}
            search={search}
            onSearchChange={handleSearchValueChange}
            bindings={repBindings}
            onSelect={(binding) => {
              const organization = binding.organization;
              if (!organization) return;
              onChange(organization.id, organization.canonicalName, organization.address, null);
              setOpen(false);
              setSearch("");
              onSearchChange?.("");
            }}
            onUseRawName={(name) => {
              onChange(null, name);
              setOpen(false);
              setSearch("");
              onSearchChange?.("");
            }}
            onRequestBinding={(name) => requestBindingMutation.mutate(name)}
            requestPending={requestBindingMutation.isPending}
            isLoading={repBindingsLoading}
            loadError={repBindingsError}
          />
        </PopoverContent>
      </Popover>
    );
  }

  const desktopTrigger = (
    <Button
      variant="outline"
      role="combobox"
      aria-expanded={open}
      className="w-full justify-between"
    >
      <span className="truncate">
        {selected ? `${selected.canonicalName} (${selected.orgCode})` : displayValue || "选择单位..."}
      </span>
      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
    </Button>
  );

  const mobileTrigger = (
    <Button
      variant="outline"
      role="combobox"
      aria-expanded={open}
      className="w-full justify-between"
      onClick={() => setOpen(true)}
    >
      <span className="truncate">
        {selected ? `${selected.canonicalName} (${selected.orgCode})` : displayValue || "选择单位..."}
      </span>
      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
    </Button>
  );

  if (isMobile) {
    return (
      <>
        {mobileTrigger}
        <Sheet open={open} onOpenChange={handleOpenChange}>
          <SheetContent side="bottom" className="max-h-[85dvh] flex flex-col p-0">
            <SheetHeader className="px-4 pt-4 pb-2">
              <SheetTitle>选择单位</SheetTitle>
            </SheetHeader>
            <OrgList
              value={value}
              search={search}
              onSearchChange={handleSearchValueChange}
              orgs={orgs}
              onSelect={handleSelect}
              quickName={quickName}
              onQuickNameChange={setQuickName}
              showQuickAdd={showQuickAdd}
              onToggleQuickAdd={(v) => setShowQuickAdd(v)}
              quickCreateMutation={{
                isPending: quickCreateMutation.isPending,
                mutate: (name: string) => quickCreateMutation.mutate(name),
              }}
              hideQuickAdd={isRepDiscover}
              disableUnavailable={!isRepDiscover}
              autoFocusSearch={false}
            />
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger render={desktopTrigger} />
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0 max-h-[400px]" align="start">
        <OrgCommand
          value={value}
          search={search}
          onSearchChange={handleSearchValueChange}
          orgs={orgs}
          onSelect={handleSelect}
          quickName={quickName}
          onQuickNameChange={setQuickName}
          showQuickAdd={showQuickAdd}
          onToggleQuickAdd={(v) => setShowQuickAdd(v)}
          quickCreateMutation={{
            isPending: quickCreateMutation.isPending,
            mutate: (name: string) => quickCreateMutation.mutate(name),
          }}
          hideQuickAdd={isRepDiscover}
          disableUnavailable={!isRepDiscover}
        />
      </PopoverContent>
    </Popover>
  );
}
