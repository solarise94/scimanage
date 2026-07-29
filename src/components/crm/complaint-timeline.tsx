"use client";

import { CrmEmptyState } from "@/components/crm/empty-state";
import { COMPLAINT_EVENT_TYPE_LABELS } from "@/lib/crm/constants";
import { Clock } from "lucide-react";

interface ComplaintEvent {
  id: string;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  content: string | null;
  createdBy: { id: string; name: string };
  createdAt: string;
}

export function ComplaintTimeline({ events }: { events: ComplaintEvent[] }) {
  if (events.length === 0) {
    return <CrmEmptyState icon={Clock} title="暂无处理记录" description="状态流转和处理记录会显示在这里" />;
  }

  return (
    <div className="space-y-3">
      {events.map((e, idx) => (
        <div key={e.id} className="relative pl-6 pb-1">
          {/* 竖线 */}
          {idx < events.length - 1 && (
            <div className="absolute left-[7px] top-3 bottom-0 w-px bg-border" />
          )}
          {/* 圆点 */}
          <div className="absolute left-0 top-1.5 h-3.5 w-3.5 rounded-full border-2 border-primary bg-background" />
          <div className="text-sm">
            <span className="font-medium">{COMPLAINT_EVENT_TYPE_LABELS[e.eventType] || e.eventType}</span>
            {e.fromStatus && e.toStatus && (
              <span className="text-xs text-muted-foreground ml-2">
                {e.fromStatus} → {e.toStatus}
              </span>
            )}
          </div>
          {e.content && <p className="text-sm text-muted-foreground break-words mt-0.5">{e.content}</p>}
          <p className="text-xs text-muted-foreground mt-0.5">
            {e.createdBy.name} · {new Date(e.createdAt).toLocaleString("zh-CN")}
          </p>
        </div>
      ))}
    </div>
  );
}
