"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

interface RepresentativeRegionEditorProps {
  representativeId: string;
  // Standalone dialog mode
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSaved?: () => void;
  // Embedded mode: render checkbox list only, parent controls selection
  embedded?: boolean;
  selectedIds?: string[];
  onSelectionChange?: (ids: string[]) => void;
}

function RegionCheckboxList({
  selectedIds,
  onSelectionChange,
}: {
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
}) {
  const { data: regionsData, isLoading } = useQuery<{ regions: { id: string; name: string }[] }>({
    queryKey: ["representative-regions"],
    queryFn: () => fetch("/api/crm/representative-regions").then((r) => r.json()),
  });
  const regions = regionsData?.regions || [];

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        加载地区数据...
      </div>
    );
  }

  if (regions.length === 0) {
    return (
      <div className="text-xs text-muted-foreground space-y-1">
        <p>暂无地区数据</p>
        <Link href="/admin/representative-regions" className="text-primary hover:underline inline-block">
          前往地区管理创建
        </Link>
      </div>
    );
  }

  return (
    <div className="border rounded-md max-h-40 overflow-y-auto p-2 space-y-1">
      {regions.map((r) => (
        <label key={r.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/50 rounded px-1 py-0.5">
          <Checkbox
            checked={selectedIds.includes(r.id)}
            onCheckedChange={(checked) => {
              if (checked) onSelectionChange([...selectedIds, r.id]);
              else onSelectionChange(selectedIds.filter((id) => id !== r.id));
            }}
          />
          {r.name}
        </label>
      ))}
    </div>
  );
}

function StandaloneRegionEditorDialog({
  open,
  onOpenChange,
  onSaved,
  representativeId,
  initialSelectedIds,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSaved?: () => void;
  representativeId: string;
  initialSelectedIds: string[];
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>(initialSelectedIds);

  const mutation = useMutation({
    mutationFn: async (regionIds: string[]) => {
      const res = await fetch(`/api/representatives/${representativeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regionIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "保存失败");
      return data;
    },
    onSuccess: () => {
      toast.success("地区已更新");
      onOpenChange?.(false);
      onSaved?.();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>编辑所属地区</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <RegionCheckboxList
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
          />
        </div>
        <DialogFooter>
          <Button
            type="submit"
            className="w-full"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(selectedIds)}
          >
            {mutation.isPending ? "保存中..." : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RepresentativeRegionEditor({
  representativeId,
  open,
  onOpenChange,
  onSaved,
  embedded = false,
  selectedIds: externalSelectedIds = [],
  onSelectionChange: externalOnSelectionChange,
}: RepresentativeRegionEditorProps) {
  const { data: repDetail, isLoading: loadingInitial } = useQuery<{
    regions?: { id: string; name: string; isPrimary: boolean }[];
  }>({
    queryKey: ["representative-region-editor", representativeId],
    queryFn: async () => {
      const res = await fetch(`/api/crm/representatives/${representativeId}`);
      if (!res.ok) throw new Error("Failed to load representative regions");
      return res.json();
    },
    enabled: !embedded && open,
  });
  const initialSelectedIds = repDetail?.regions?.map((rg) => rg.id) || [];

  // Embedded mode: render just the checkbox list
  if (embedded) {
    return (
      <div className="space-y-2">
        <Label>所属地区</Label>
        <RegionCheckboxList
          selectedIds={externalSelectedIds}
          onSelectionChange={(ids) => externalOnSelectionChange?.(ids)}
        />
      </div>
    );
  }

  // Standalone dialog mode
  if (loadingInitial) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>编辑所属地区</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载当前地区...
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <StandaloneRegionEditorDialog
      open={open}
      onOpenChange={onOpenChange}
      onSaved={onSaved}
      representativeId={representativeId}
      initialSelectedIds={initialSelectedIds}
    />
  );
}
