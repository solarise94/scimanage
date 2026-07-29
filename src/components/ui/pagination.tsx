"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMediaQuery } from "@/hooks/use-media-query";

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /** 桌面端显示「跳至 X 页」输入框；移动端自动隐藏。 */
  showPageJumper?: boolean;
}

/**
 * 独立分页器。从 data-table.tsx 的 PaginationBar 提取复用。
 * 自行判断移动端（useMediaQuery），调用方无需传 isMobile。
 *
 * 知情：useMediaQuery 首帧恒 false（SSR 无 matchMedia），移动端首帧按桌面渲染一帧——
 * 继承自 DataTable 原实现，非本次新引入问题。
 */
export function Pagination({ page, total, totalPages, onPageChange, showPageJumper }: PaginationProps) {
  const isMobile = useMediaQuery("(max-width: 767px)");

  const commitInput = (raw: string) => {
    const next = parseInt(raw, 10);
    if (Number.isNaN(next)) return;
    const clamped = Math.min(Math.max(next, 1), totalPages);
    if (clamped !== page) {
      onPageChange(clamped);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 pt-4">
      <Button
        variant="outline"
        size="icon"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        aria-label="上一页"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>

      <span className="text-sm text-muted-foreground">
        {isMobile ? (
          <>第 {page} / {totalPages} 页</>
        ) : (
          <>第 {page} / {totalPages} 页（共 {total} 条）</>
        )}
      </span>

      <div className="flex items-center gap-2">
        {showPageJumper && !isMobile && totalPages > 1 && (
          <div className="flex items-center gap-1.5">
            <span className="text-sm text-muted-foreground">跳至</span>
            <Input
              key={page}
              type="number"
              min={1}
              max={totalPages}
              defaultValue={page}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  commitInput(e.currentTarget.value);
                }
              }}
              onBlur={(e) => commitInput(e.currentTarget.value)}
              className="h-8 w-16 text-center"
            />
          </div>
        )}
        <Button
          variant="outline"
          size="icon"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages || totalPages <= 0}
          aria-label="下一页"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
