"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormSheet } from "@/components/ui/form-sheet";
import { toast } from "sonner";

interface ProjectItem {
  id: string;
  name: string;
  customer?: { id: string; name: string } | null;
}

interface ProjectBindDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string;
  onBound: () => void;
}

export function ProjectBindDialog({ open, onOpenChange, orderId, onBound }: ProjectBindDialogProps) {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [binding, setBinding] = useState(false);

  const { data, isLoading } = useQuery<{ projects: ProjectItem[] }>({
    queryKey: ["projects", "search", search],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      params.set("pageSize", "20");
      const res = await fetch(`/api/projects?${params}`);
      if (!res.ok) throw new Error("Failed to fetch projects");
      return res.json();
    },
    enabled: open,
  });

  async function handleBind() {
    if (!selectedId) return;
    setBinding(true);
    try {
      const res = await fetch(`/api/orders/${orderId}/project-links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: selectedId }),
      });
      if (!res.ok) throw new Error("关联失败");
      toast.success("项目关联成功");
      onBound();
      onOpenChange(false);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "关联失败");
    } finally {
      setBinding(false);
    }
  }

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title="关联项目" desktopMaxW="sm:max-w-md">
      <div className="space-y-4">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="搜索项目名称..."
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {isLoading ? (
          <div className="flex justify-center py-4"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : (
          <div className="max-h-64 overflow-y-auto space-y-1">
            {(data?.projects || []).map((proj) => (
              <button
                key={proj.id}
                type="button"
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                  selectedId === proj.id
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted"
                }`}
                onClick={() => setSelectedId(proj.id)}
              >
                <div className="font-medium">{proj.name}</div>
                {proj.customer && (
                  <div className="text-xs opacity-70">{proj.customer.name}</div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 mt-6">
        <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
        <Button onClick={handleBind} disabled={!selectedId || binding}>
          {binding ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
          确认关联
        </Button>
      </div>
    </FormSheet>
  );
}
