"use client";

import { useState } from "react";
import { Building2, Check, Loader2, Sparkles, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

export interface OrganizationDraftPreview {
  canonicalName: string;
  address: string | null;
  aliases: string[];
  sites: Array<{ siteName: string; address: string | null }>;
  confidence: number;
}

interface CandidateItem {
  organizationId: string;
  canonicalName: string;
  siteName: string | null;
  address: string | null;
  confidence: number;
}

interface Props {
  query: string;
  onApply: (draft: OrganizationDraftPreview) => void;
  disabled?: boolean;
  mode?: "create" | "supplement";
}

export function OrganizationAiFillPlugin({ query, onApply, disabled, mode = "create" }: Props) {
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<OrganizationDraftPreview | null>(null);
  const [candidates, setCandidates] = useState<CandidateItem[]>([]);

  async function handleDraft() {
    if (!query.trim()) {
      toast.error("请先输入机构名称");
      return;
    }

    setLoading(true);
    setDraft(null);
    setCandidates([]);
    try {
      const res = await fetch("/api/organizations/ai-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim(), mode }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "AI 预填失败");
        return;
      }

      if (data.kind === "existing") {
        toast.info(`主数据已存在：${data.organization.canonicalName}`);
        return;
      }

      if (data.kind === "candidates") {
        setCandidates(data.candidates || []);
        toast.info("主数据中有近似匹配，请先确认是否需要新建");
        return;
      }

      setDraft(data.draftPreview);
    } catch {
      toast.error("网络错误");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm">
          <div className="font-medium">AI 预填插件</div>
          <div className="text-muted-foreground text-xs">
            {mode === "supplement" ? "只生成补充草稿，不会覆盖已有信息" : "只生成草稿，不会自动建档或提交复核"}
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={disabled || loading || !query.trim()} onClick={handleDraft}>
          {loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
          AI 预填
        </Button>
      </div>

      {candidates.length > 0 && (
        <div className="space-y-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3 text-sm">
          <div className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400 font-medium">
            <AlertTriangle className="h-4 w-4" />
            主数据中已有近似机构，请确认后再决定是否新建
          </div>
          <div className="space-y-1">
            {candidates.map((c) => (
              <div key={c.organizationId} className="flex min-w-0 items-center gap-2 text-xs">
                <Building2 className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="min-w-0 break-words">{c.canonicalName}</span>
                {c.siteName && <Badge variant="outline" className="text-[10px] px-1 py-0">{c.siteName}</Badge>}
              </div>
            ))}
          </div>
        </div>
      )}

      {draft && (
        <div className="space-y-2 rounded-md bg-muted/40 p-3 text-sm">
          <div className="flex min-w-0 items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <span className="min-w-0 break-words font-medium">{draft.canonicalName}</span>
            <Badge variant="secondary" className="text-[10px]">
              置信度 {Math.round(draft.confidence * 100)}%
            </Badge>
          </div>
          {draft.address && <div className="break-words text-muted-foreground">{draft.address}</div>}
          {draft.aliases.length > 0 && (
            <div className="break-words text-xs text-muted-foreground">别名：{draft.aliases.join("、")}</div>
          )}
          {draft.sites.length > 0 && (
            <div className="space-y-1 text-xs text-muted-foreground">
              {draft.sites.map((site, idx) => (
                <div key={`${site.siteName}-${idx}`} className="break-words">
                  {site.siteName}
                  {site.address ? ` · ${site.address}` : ""}
                </div>
              ))}
            </div>
          )}
          <Button type="button" size="sm" onClick={() => onApply(draft)}>
            <Check className="mr-1 h-3.5 w-3.5" />
            应用到表单
          </Button>
        </div>
      )}
    </div>
  );
}
