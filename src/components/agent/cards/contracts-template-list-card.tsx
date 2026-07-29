"use client";

import { FileText, Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";

interface TemplateItem {
  id?: string;
  name?: string;
  category?: string;
  isDefault?: boolean;
  fileName?: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  SEQUENCING: "测序服务",
  ANALYSIS: "分析服务",
  DELIVERY_NOTE: "交货单",
  OTHER: "其他",
};

function categoryLabel(category: string | undefined): string {
  if (!category) return "-";
  return CATEGORY_LABEL[category] ?? category;
}

/**
 * Template list card for `contracts.list_templates`.
 */
export function ContractsTemplateListCard({ descriptor }: AgentCardProps) {
  const props = descriptor.props;
  const templates = Array.isArray(props.templates)
    ? (props.templates as TemplateItem[])
    : Array.isArray(props.items)
      ? (props.items as TemplateItem[])
      : [];

  return (
    <CardShell title="合同模板列表" state={descriptor.state}>
      <div className="flex items-center gap-2 rounded-xl bg-muted/30 px-3 py-2">
        <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="text-sm font-medium">{templates.length} 个模板</div>
      </div>

      {templates.length > 0 ? (
        <div className="mt-3 divide-y divide-border/40 overflow-hidden rounded-lg border border-border/40">
          {templates.map((tpl) => (
            <div key={tpl.id ?? tpl.name} className="flex items-center justify-between gap-2 px-3 py-2.5 text-xs">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{tpl.name || "未命名模板"}</span>
                  {tpl.isDefault ? (
                    <Badge
                      variant="outline"
                      className="shrink-0 text-[9px] bg-amber-50 text-amber-700 border-amber-200"
                    >
                      <Star className="h-2.5 w-2.5" />
                      默认
                    </Badge>
                  ) : null}
                </div>
                {tpl.fileName ? (
                  <div className="truncate text-[10px] text-muted-foreground">{tpl.fileName}</div>
                ) : null}
              </div>
              <Badge variant="outline" className="shrink-0 text-[10px] bg-muted/30 text-muted-foreground border-border/40">
                {categoryLabel(tpl.category)}
              </Badge>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 text-[11px] text-muted-foreground">暂无可用模板</div>
      )}
    </CardShell>
  );
}
