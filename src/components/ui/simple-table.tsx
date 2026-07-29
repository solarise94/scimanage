"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { MoneyText } from "@/components/ui/money-text";

type ColumnAlign = "left" | "right" | "center";

export interface SimpleTableColumn<T> {
  key: string;
  header: React.ReactNode;
  align?: ColumnAlign;
  width?: string;
  className?: string;
  render?: (row: T, index: number) => React.ReactNode;
  money?: boolean;
}

export interface SimpleTableProps<T> {
  columns: SimpleTableColumn<T>[];
  data: T[];
  keyExtractor: (row: T, index: number) => string;
  className?: string;
  footer?: React.ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: React.ReactNode;
}

function renderCell<T>(row: T, rowIndex: number, col: SimpleTableColumn<T>): React.ReactNode {
  if (col.render) {
    return col.render(row, rowIndex);
  }
  if (col.money) {
    const raw = ((row as Record<string, unknown>)[col.key] as number) ?? 0;
    return <MoneyText value={raw} className="tabular-nums" />;
  }
  const raw = (row as Record<string, unknown>)[col.key];
  if (raw == null) return "-";
  return String(raw);
}

export function SimpleTable<T>({
  columns,
  data,
  keyExtractor,
  className,
  footer,
  emptyTitle = "暂无数据",
  emptyDescription,
  emptyAction,
}: SimpleTableProps<T>) {
  if (data.length === 0 && !footer) {
    return (
      <EmptyState
        title={emptyTitle}
        description={emptyDescription}
        action={emptyAction}
      />
    );
  }

  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full border-collapse border border-border text-sm">
        <thead className="bg-muted/50">
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                className={cn(
                  "border px-3 py-2 font-medium text-muted-foreground",
                  col.align === "right" && "text-right",
                  col.align === "center" && "text-center",
                  col.className
                )}
                style={{ width: col.width }}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, rowIndex) => (
            <tr key={keyExtractor(row, rowIndex)} className="border-t">
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={cn(
                    "border px-3 py-2 align-top",
                    col.align === "right" && "text-right",
                    col.align === "center" && "text-center",
                    col.className
                  )}
                >
                  {renderCell(row, rowIndex, col)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && (
          <tfoot>
            <tr>
              <td colSpan={columns.length} className="border px-3 py-2">
                {footer}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
      {data.length === 0 && footer && (
        <div className="mt-4">
          <EmptyState
            title={emptyTitle}
            description={emptyDescription}
            action={emptyAction}
          />
        </div>
      )}
    </div>
  );
}
