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

interface RepOption {
  id: string;
  name: string;
  email: string;
}

interface RepresentativeSelectProps {
  value: string; // representativeId
  displayValue?: string; // representative name (for fallback)
  onChange: (id: string | null, name: string) => void;
}

export function RepresentativeSelect({ value, displayValue, onChange }: RepresentativeSelectProps) {
  const [open, setOpen] = useState(false);
  const isMobile = useMediaQuery("(max-width: 767px)");

  const { data } = useQuery<{ representatives: RepOption[] }>({
    queryKey: ["representatives-list"],
    queryFn: async () => {
      const res = await fetch("/api/representatives/list");
      if (!res.ok) throw new Error("Failed to load representatives");
      return res.json();
    },
  });

  const reps = data?.representatives || [];
  const selected = reps.find((r) => r.id === value);

  const triggerLabel = selected ? selected.name : displayValue || "选择代表...";

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
      <CommandInput placeholder="搜索代表..." />
      <CommandList className={isMobile ? "min-h-0 flex-1" : undefined}>
        <CommandEmpty>
          <div className="py-2 text-center text-sm text-muted-foreground">
            未找到代表，请联系管理员在代表管理中添加
          </div>
        </CommandEmpty>
        <CommandGroup>
          <CommandItem
            onSelect={() => {
              onChange(null, "");
              setOpen(false);
            }}
          >
            <Check className={cn("mr-2 h-4 w-4", !value ? "opacity-100" : "opacity-0")} />
            不选择代表
          </CommandItem>
          {reps.map((rep) => (
            <CommandItem
              key={rep.id}
              onSelect={() => {
                onChange(rep.id, rep.name);
                setOpen(false);
              }}
            >
              <Check className={cn("mr-2 h-4 w-4", value === rep.id ? "opacity-100" : "opacity-0")} />
              <div className="flex flex-col">
                <span>{rep.name}</span>
                <span className="text-xs text-muted-foreground">{rep.email}</span>
              </div>
            </CommandItem>
          ))}
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
              <SheetTitle>选择代表</SheetTitle>
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
