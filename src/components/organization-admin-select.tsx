"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronsUpDown, Loader2, AlertTriangle, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

interface AdminOrgOption {
  id: string;
  orgCode: string;
  canonicalName: string;
  address: string | null;
  siteCount: number;
}

interface OrganizationAdminSelectProps {
  value: string;
  onChange: (org: AdminOrgOption | null) => void;
  excludeIds?: string[];
  placeholder?: string;
  disabled?: boolean;
}

interface AdminOrgCommandProps {
  value: string;
  search: string;
  onSearchChange: (v: string) => void;
  orgs: AdminOrgOption[];
  isLoading: boolean;
  loadError: string | null;
  limited: boolean;
  total: number | null;
  totalIsExact: boolean;
  onSelect: (org: AdminOrgOption) => void;
  onRefetch: () => void;
  summaryErrorMsg: string | null;
  onClear: () => void;
  onRefetchSummary: () => void;
}

function limitedHint(orgsLength: number, total: number | null, totalIsExact: boolean): string {
  if (totalIsExact && total != null) {
    return `搜索结果较多，仅展示前 ${orgsLength} 条（共 ${total} 条）。请缩小关键词以精确查找。`;
  }
  return `结果较多，仅展示前 ${orgsLength} 条，请缩小关键词。`;
}

function AdminOrgCommand({
  value,
  search,
  onSearchChange,
  orgs,
  isLoading,
  loadError,
  limited,
  total,
  totalIsExact,
  onSelect,
  onRefetch,
  summaryErrorMsg,
  onClear,
  onRefetchSummary,
}: AdminOrgCommandProps) {
  return (
    <Command shouldFilter={false} className="flex min-h-0 flex-1 flex-col">
      <CommandInput
        placeholder="输入机构名称、编码或别名搜索..."
        value={search}
        onValueChange={onSearchChange}
      />
      <CommandList>
        {!search && <CommandEmpty>输入关键词搜索机构</CommandEmpty>}
        {search && isLoading && <CommandEmpty>搜索中...</CommandEmpty>}
        {search && loadError && (
          <CommandEmpty>
            <div className="space-y-2">
              <p className="text-sm text-destructive">{loadError}</p>
              <Button variant="outline" size="sm" onClick={onRefetch}>重试</Button>
            </div>
          </CommandEmpty>
        )}
        {search && !isLoading && !loadError && orgs.length === 0 && <CommandEmpty>未找到匹配机构</CommandEmpty>}
        <CommandGroup>
          {orgs.map((org) => (
            <CommandItem key={org.id} value={org.id} onSelect={() => onSelect(org)}>
              <Building2 className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
              <div className="flex flex-col min-w-0 flex-1">
                <span className="truncate font-medium">
                  {org.canonicalName}{" "}
                  <span className="text-xs text-muted-foreground font-normal">({org.orgCode})</span>
                </span>
                {org.address && <span className="text-xs text-muted-foreground truncate">{org.address}</span>}
                {org.siteCount > 0 && <span className="text-xs text-muted-foreground">{org.siteCount} 个院区/分支</span>}
              </div>
              {value === org.id && <span className="text-xs text-primary font-medium shrink-0">已选</span>}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
      {search && limited && (
        <div className="flex items-start gap-2 px-3 py-2 text-xs text-warning border-t border-warning-border bg-warning-bg">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{limitedHint(orgs.length, total, totalIsExact)}</span>
        </div>
      )}
      {value && (
        <div className="border-t p-3 space-y-2">
          {summaryErrorMsg && (
            <div className="text-center">
              <p className="text-xs text-destructive mb-1.5">{summaryErrorMsg}</p>
              <Button variant="outline" size="sm" className="w-full" onClick={onRefetchSummary}>重试加载</Button>
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-muted-foreground"
            onClick={onClear}
          >
            清除选择
          </Button>
        </div>
      )}
    </Command>
  );
}

export function OrganizationAdminSelect({
  value,
  onChange,
  excludeIds,
  placeholder = "搜索并选择机构...",
  disabled,
}: OrganizationAdminSelectProps) {
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setHighlightedId(null);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const {
    data,
    isLoading,
    error,
    refetch,
  } = useQuery<{
    organizations: AdminOrgOption[];
    total: number | null;
    totalIsExact?: boolean;
    limited: boolean;
  }>({
    queryKey: ["organizations-list-admin", debouncedSearch, excludeIds],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("admin", "1");
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (excludeIds?.length) params.set("excludeIds", excludeIds.join(","));
      const res = await fetch(`/api/organizations/list?${params}`);
      if (!res.ok) throw new Error("搜索机构失败");
      return res.json();
    },
    enabled: open && debouncedSearch.length > 0,
    staleTime: 30_000,
  });

  const orgs = useMemo(() => data?.organizations || [], [data?.organizations]);
  const limited = data?.limited || false;
  const total = data?.total ?? null;
  const totalIsExact = data?.totalIsExact === true;
  const loadError = error instanceof Error ? error.message : null;

  // Compute active index from highlighted id (falls to -1 if id not in current results)
  const activeIndex = highlightedId ? orgs.findIndex((o) => o.id === highlightedId) : -1;

  // Fetch selected org summary for trigger display
  const {
    data: summaryData,
    isLoading: summaryLoading,
    error: summaryError,
    refetch: refetchSummary,
  } = useQuery<AdminOrgOption>({
    queryKey: ["organization-admin-summary", value],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${value}`);
      if (!res.ok) throw new Error("加载机构信息失败");
      const json = await res.json();
      return {
        id: json.organization.id,
        orgCode: json.organization.orgCode,
        canonicalName: json.organization.canonicalName,
        address: json.organization.address,
        siteCount: json.organization.sites?.length ?? 0,
      };
    },
    enabled: !!value,
    staleTime: 60_000,
  });

  const handleSelect = useCallback((org: AdminOrgOption) => {
    setHighlightedId(null);
    onChange(org);
    setOpen(false);
    setSearch("");
    setDebouncedSearch("");
  }, [onChange]);

  const handleClear = useCallback(() => {
    setHighlightedId(null);
    onChange(null);
    setSearch("");
    setDebouncedSearch("");
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [onChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (orgs.length === 0) return;

    const currentIdx = activeIndex;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = currentIdx < orgs.length - 1 ? currentIdx + 1 : 0;
      setHighlightedId(orgs[next]?.id || null);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = currentIdx > 0 ? currentIdx - 1 : orgs.length - 1;
      setHighlightedId(orgs[next]?.id || null);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (currentIdx >= 0 && currentIdx < orgs.length) {
        handleSelect(orgs[currentIdx]);
      }
    }
  }, [orgs, activeIndex, handleSelect]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (activeIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll("[data-org-item]");
      const item = items[activeIndex] as HTMLElement | undefined;
      item?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  const summaryErrorMsg = summaryError instanceof Error ? summaryError.message : null;

  const displayValue = (() => {
    if (summaryData) return `${summaryData.canonicalName} (${summaryData.orgCode})`;
    if (summaryLoading) return "加载中...";
    if (summaryErrorMsg) return `加载失败 (${value})`;
    if (value) return value;
    return undefined;
  })();

  const triggerContent = (
    <span className="truncate">
      {displayValue || placeholder}
    </span>
  );

  const trigger = (
    <Button
      variant="outline"
      role="combobox"
      aria-expanded={open}
      disabled={disabled}
      className={cn("w-full justify-between", disabled && "bg-muted/50")}
    >
      {triggerContent}
      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
    </Button>
  );

  const searchInput = (
    <div className="p-3 border-b">
      <Input
        ref={inputRef}
        placeholder="输入机构名称、编码或别名搜索..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={handleKeyDown}
        className="h-9 text-sm"
        autoFocus={!isMobile}
      />
    </div>
  );

  const resultsList = (
    <div className="flex-1 overflow-y-auto min-w-0" ref={listRef}>
      {!debouncedSearch && (
        <div className="px-3 py-6 text-center text-sm text-muted-foreground">
          输入关键词搜索机构
        </div>
      )}

      {debouncedSearch && isLoading && (
        <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          搜索中...
        </div>
      )}

      {debouncedSearch && loadError && (
        <div className="px-3 py-4 text-center">
          <p className="text-sm text-destructive mb-2">{loadError}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            重试
          </Button>
        </div>
      )}

      {debouncedSearch && !isLoading && !loadError && orgs.length === 0 && (
        <div className="px-3 py-6 text-center text-sm text-muted-foreground">
          未找到匹配机构
        </div>
      )}

      {debouncedSearch && !loadError && orgs.map((org, index) => (
        <button
          key={org.id}
          type="button"
          data-org-item
          className={cn(
            "w-full text-left px-3 py-2.5 text-sm flex items-start gap-2 min-w-0",
            index === activeIndex ? "bg-accent" : "hover:bg-accent"
          )}
          onClick={() => handleSelect(org)}
          onMouseEnter={() => setHighlightedId(org.id)}
        >
          <Building2 className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
          <div className="flex flex-col min-w-0 flex-1">
            <span className="truncate font-medium">
              {org.canonicalName}{" "}
              <span className="text-xs text-muted-foreground font-normal">({org.orgCode})</span>
            </span>
            {org.address && (
              <span className="text-xs text-muted-foreground truncate">{org.address}</span>
            )}
            {org.siteCount > 0 && (
              <span className="text-xs text-muted-foreground">
                {org.siteCount} 个院区/分支
              </span>
            )}
          </div>
          {value === org.id && (
            <span className="text-xs text-primary font-medium shrink-0">已选</span>
          )}
        </button>
      ))}

      {debouncedSearch && !loadError && limited && (
        <div className="flex items-start gap-2 px-3 py-2 text-xs text-warning border-t border-warning-border bg-warning-bg">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{limitedHint(orgs.length, total, totalIsExact)}</span>
        </div>
      )}
    </div>
  );

  const clearButton = value && (
    <div className="border-t p-3 space-y-2">
      {summaryErrorMsg && (
        <div className="text-center">
          <p className="text-xs text-destructive mb-1.5">{summaryErrorMsg}</p>
          <Button variant="outline" size="sm" className="w-full" onClick={() => refetchSummary()}>
            重试加载
          </Button>
        </div>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="w-full text-muted-foreground"
        onClick={handleClear}
      >
        清除选择
      </Button>
    </div>
  );

  const content = (
    <div className="flex min-h-0 flex-1 flex-col">
      {searchInput}
      {resultsList}
      {clearButton}
    </div>
  );

  if (isMobile) {
    return (
      <>
        {trigger}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="bottom" className="max-h-[85dvh] flex flex-col p-0">
            <SheetHeader className="px-4 pt-4 pb-2">
              <SheetTitle>选择机构</SheetTitle>
            </SheetHeader>
            {content}
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0 max-h-[400px]" align="start">
        <AdminOrgCommand
          value={value}
          search={search}
          onSearchChange={(v) => { setSearch(v); setHighlightedId(null); }}
          orgs={orgs}
          isLoading={isLoading}
          loadError={loadError}
          limited={limited}
          total={total}
          totalIsExact={totalIsExact}
          onSelect={handleSelect}
          onRefetch={refetch}
          summaryErrorMsg={summaryErrorMsg}
          onClear={handleClear}
          onRefetchSummary={refetchSummary}
        />
      </PopoverContent>
    </Popover>
  );
}
