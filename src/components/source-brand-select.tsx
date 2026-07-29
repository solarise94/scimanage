"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
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

interface BrandOption {
  id: string;
  name: string;
  isDefault: boolean;
}

interface SourceBrandSelectProps {
  value: string; // current brand text (may be a legacy value not in the list)
  onChange: (name: string) => void;
}

export function SourceBrandSelect({ value, onChange }: SourceBrandSelectProps) {
  const [open, setOpen] = useState(false);
  const isMobile = useMediaQuery("(max-width: 767px)");

  const { data } = useQuery<{ brands: BrandOption[] }>({
    queryKey: ["source-brands"],
    queryFn: async () => {
      const res = await fetch("/api/source-brands");
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });

  const brands = data?.brands || [];
  const isInList = brands.some((b) => b.name === value);

  const triggerLabel = value
    ? (isInList ? value : `历史：${value}`)
    : "选择品牌...";

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
    <Command className={isMobile ? "min-h-0 flex-1" : undefined}>
      <CommandInput placeholder="搜索品牌..." />
      <CommandList className={isMobile ? "min-h-0 flex-1" : undefined}>
        <CommandEmpty>
          <div className="py-2 text-center text-sm text-muted-foreground">未找到品牌</div>
        </CommandEmpty>
        <CommandGroup>
          <CommandItem
            onSelect={() => { onChange(""); setOpen(false); }}
          >
            <Check className={cn("mr-2 h-4 w-4", !value ? "opacity-100" : "opacity-0")} />
            不选择品牌
          </CommandItem>
          {brands.map((b) => (
            <CommandItem
              key={b.id}
              onSelect={() => { onChange(b.name); setOpen(false); }}
            >
              <Check className={cn("mr-2 h-4 w-4", value === b.name ? "opacity-100" : "opacity-0")} />
              <span>{b.name}{b.isDefault ? " (默认)" : ""}</span>
            </CommandItem>
          ))}
          {/* Legacy value option */}
          {value && !isInList && (
            <CommandItem
              onSelect={() => setOpen(false)}
            >
              <Check className="mr-2 h-4 w-4 opacity-100" />
              <span className="text-muted-foreground">保留当前: {value}</span>
            </CommandItem>
          )}
        </CommandGroup>
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
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="bottom" className="max-h-[85dvh] flex flex-col p-0">
            <SheetHeader className="px-4 pt-4 pb-2">
              <SheetTitle>选择品牌</SheetTitle>
            </SheetHeader>
            {listContent}
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent className="w-full p-0" align="start">
        {listContent}
      </PopoverContent>
    </Popover>
  );
}
