"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, AlertTriangle, ExternalLink, Search, Loader2 } from "lucide-react";
import { useState } from "react";

interface FieldMeta {
  source: "text" | "search" | "project_context";
  confidence: number;
  reviewRequired?: boolean;
  reason?: string;
}

interface Source {
  kind: "search_result";
  title?: string;
  url?: string;
  snippet?: string;
}

interface EntityCandidate {
  id: string;
  name: string;
  [key: string]: unknown;
}

interface EntityValue {
  id?: string;
  name: string;
  matched: boolean;
  candidates?: EntityCandidate[];
  [key: string]: unknown;
}

interface DraftData {
  fields: Record<string, unknown>;
  fieldMeta?: Record<string, FieldMeta>;
  sources?: Source[];
}

interface DraftPreviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: DraftData;
  summary?: string;
  warnings?: string[];
  fieldLabels: Record<string, string>;
  onApply: (fields: Record<string, unknown>) => void | Promise<void>;
}

const SOURCE_LABELS: Record<string, string> = {
  text: "文本",
  search: "搜索",
  project_context: "项目上下文",
};

function confidenceColor(c: number): string {
  if (c >= 0.8) return "bg-green-500";
  if (c >= 0.5) return "bg-yellow-500";
  return "bg-red-500";
}

function confidenceLabel(c: number): string {
  if (c >= 0.8) return "高";
  if (c >= 0.5) return "中";
  return "低";
}

function isEntityValue(v: unknown): v is EntityValue {
  return typeof v === "object" && v !== null && "matched" in v && "name" in v;
}

function getDisplayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (isEntityValue(value)) return value.name;
  return String(value);
}

export function DraftPreview({ open, onOpenChange, draft, summary, warnings, fieldLabels, onApply }: DraftPreviewProps) {
  const [showSources, setShowSources] = useState(false);
  // Track user selections for entity candidate fields
  const [entitySelections, setEntitySelections] = useState<Record<string, string>>({});
  // Track which unmatched entities the user wants to auto-create
  const [createFlags, setCreateFlags] = useState<Record<string, boolean>>({});
  const [applying, setApplying] = useState(false);

  const fields = draft.fields;
  const meta = draft.fieldMeta || {};
  const sources = draft.sources || [];
  const fieldKeys = Object.keys(fields);

  // Default: unmatched entities with no candidates default to "create"
  const getCreateFlag = (key: string): boolean => {
    if (key in createFlags) return createFlags[key];
    const val = fields[key];
    if (isEntityValue(val) && !val.matched && (!val.candidates || val.candidates.length === 0)) {
      return true;
    }
    return false;
  };

  const handleApply = async () => {
    setApplying(true);
    try {
      const merged = { ...fields };
      for (const [key, selectedId] of Object.entries(entitySelections)) {
        if (selectedId === "__create__") {
          // User chose "新建" from candidate list — keep all entity fields, override matched/shouldCreate
          const val = merged[key];
          if (isEntityValue(val)) {
            merged[key] = { ...val, matched: false, shouldCreate: true };
          }
        } else {
          const val = merged[key];
          if (isEntityValue(val) && val.candidates) {
            const selected = val.candidates.find((c) => c.id === selectedId);
            if (selected) {
              merged[key] = { ...selected, matched: true };
            }
          }
        }
      }
      // Mark unmatched entities (no candidates) with create flag
      for (const key of fieldKeys) {
        const val = merged[key];
        if (isEntityValue(val) && !val.matched && !val.id) {
          if (!(key in entitySelections)) {
            (val as EntityValue & { shouldCreate?: boolean }).shouldCreate = getCreateFlag(key);
          }
        }
      }
      await onApply(merged);
      onOpenChange(false);
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!applying) onOpenChange(v); }}>
      <DialogContent className="max-w-lg max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle>AI 草稿预览</DialogTitle>
        </DialogHeader>

        <div className="-mx-4 min-h-0 overflow-y-auto overscroll-contain px-4 pb-1" style={{ WebkitOverflowScrolling: "touch" }}>
        <div className="space-y-2">
        {summary && <p className="text-sm text-muted-foreground">{summary}</p>}

        {warnings && warnings.length > 0 && (
          <div className="space-y-1">
            {warnings.map((w, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs text-amber-600">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                {w}
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2">
          {fieldKeys.map((key) => {
            const value = fields[key];
            const m = meta[key];
            const label = fieldLabels[key] || key;
            const entity = isEntityValue(value) ? value : null;

            return (
              <div key={key} className="py-1.5 border-b last:border-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-muted-foreground">{label}</span>
                      {entity?.matched && (
                        <Badge variant="outline" className="text-[10px] px-1 py-0 text-green-600 border-green-300">已匹配</Badge>
                      )}
                      {entity && !entity.matched && !entity.candidates?.length && (
                        <Badge variant="outline" className="text-[10px] px-1 py-0 text-amber-600 border-amber-300">未匹配</Badge>
                      )}
                      {!entity && m?.reviewRequired && (
                        <AlertTriangle className="h-3 w-3 text-amber-500" />
                      )}
                    </div>
                    <p className="text-sm break-all">
                      {getDisplayValue(value) || <span className="text-muted-foreground italic">空</span>}
                    </p>
                    {entity?.matched && entity.id && (
                      <p className="text-[10px] text-muted-foreground">
                        {(entity as EntityValue & { address?: string }).address || (entity as EntityValue & { organization?: string }).organization || ""}
                      </p>
                    )}
                  </div>
                  {m && (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Badge variant="outline" className="text-[10px] px-1 py-0">
                        {SOURCE_LABELS[m.source] || m.source}
                      </Badge>
                      <div className="flex items-center gap-1" title={`置信度: ${Math.round(m.confidence * 100)}%`}>
                        <div className={`h-1.5 w-1.5 rounded-full ${confidenceColor(m.confidence)}`} />
                        <span className="text-[10px] text-muted-foreground">{confidenceLabel(m.confidence)}</span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Entity candidate selection */}
                {entity && !entity.matched && entity.candidates && entity.candidates.length > 0 && (
                  <div className="mt-1.5 space-y-1 pl-2 border-l-2 border-amber-200">
                    <p className="text-[10px] text-muted-foreground">请选择匹配项：</p>
                    {entity.candidates.map((c) => (
                      <label key={c.id} className="flex items-start gap-1.5 cursor-pointer text-xs hover:bg-muted/50 rounded px-1 py-0.5">
                        <input
                          type="radio"
                          name={`entity-${key}`}
                          value={c.id}
                          checked={entitySelections[key] === c.id}
                          onChange={() => setEntitySelections((prev) => ({ ...prev, [key]: c.id }))}
                          className="mt-0.5"
                        />
                        <div>
                          <span className="font-medium">{c.name}</span>
                          {(c as EntityCandidate & { address?: string }).address && (
                            <span className="text-muted-foreground ml-1">{(c as EntityCandidate & { address?: string }).address}</span>
                          )}
                          {(c as EntityCandidate & { organization?: string }).organization && (
                            <span className="text-muted-foreground ml-1">({(c as EntityCandidate & { organization?: string }).organization})</span>
                          )}
                        </div>
                      </label>
                    ))}
                    <label className="flex items-start gap-1.5 cursor-pointer text-xs hover:bg-muted/50 rounded px-1 py-0.5 text-muted-foreground">
                      <input
                        type="radio"
                        name={`entity-${key}`}
                        value=""
                        checked={!entitySelections[key]}
                        onChange={() => setEntitySelections((prev) => { const n = { ...prev }; delete n[key]; return n; })}
                        className="mt-0.5"
                      />
                      <span>保留原文 &quot;{entity.name}&quot;</span>
                    </label>
                    <label className="flex items-start gap-1.5 cursor-pointer text-xs hover:bg-muted/50 rounded px-1 py-0.5 text-blue-600">
                      <input
                        type="radio"
                        name={`entity-${key}`}
                        value="__create__"
                        checked={entitySelections[key] === "__create__"}
                        onChange={() => setEntitySelections((prev) => ({ ...prev, [key]: "__create__" }))}
                        className="mt-0.5"
                      />
                      <span>都不是，新建 &quot;{entity.name}&quot;</span>
                    </label>
                  </div>
                )}

                {/* Unmatched entity — offer to create */}
                {entity && !entity.matched && (!entity.candidates || entity.candidates.length === 0) && (
                  <div className="mt-1.5 pl-2 border-l-2 border-amber-200">
                    <label className="flex items-start gap-1.5 cursor-pointer text-xs hover:bg-muted/50 rounded px-1 py-0.5">
                      <input
                        type="checkbox"
                        checked={getCreateFlag(key)}
                        onChange={(e) => setCreateFlags((prev) => ({ ...prev, [key]: e.target.checked }))}
                        className="mt-0.5"
                      />
                      <span>
                        新建{fieldLabels[key] || key}：<strong>{entity.name}</strong>
                      </span>
                    </label>
                    {!getCreateFlag(key) && (
                      <p className="text-[10px] text-muted-foreground pl-5">不勾选则需要在表单中手动选择</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {sources.length > 0 && (
          <div>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setShowSources(!showSources)}
            >
              {showSources ? "收起" : "展开"}参考来源 ({sources.length})
            </button>
            {showSources && (
              <div className="mt-1.5 space-y-1.5">
                {sources.map((s, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <Search className="h-3 w-3 mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <span className="font-medium">{s.title || "搜索结果"}</span>
                      {s.url && (
                        <a href={s.url} target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex items-center text-blue-500 hover:underline">
                          <ExternalLink className="h-2.5 w-2.5" />
                        </a>
                      )}
                      {s.snippet && <p className="mt-0.5 line-clamp-2">{s.snippet}</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={applying}>
            取消
          </Button>
          <Button size="sm" onClick={handleApply} disabled={applying}>
            {applying ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="mr-1.5 h-3.5 w-3.5" />}
            {applying ? "创建中..." : "应用到表单"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
