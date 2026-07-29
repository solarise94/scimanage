"use client";

import { Fragment, useMemo, useState } from "react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { Loader2, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { motion } from "motion/react";
import { useMediaQuery } from "@/hooks/use-media-query";
import { EmptyState } from "@/components/ui/empty-state";
import { MoneyText } from "@/components/ui/money-text";
import { CardContent } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";

type ColumnAlign = "left" | "right" | "center";
type SortDir = "asc" | "desc";

export interface DataTableColumn<T> {
  key: string;
  header: string;
  /** 表头原生 tooltip（title 属性）；用于解释排序口径等细节，如「按合同金额排序，覆盖金额不参与排序」 */
  headerTitle?: string;
  align?: ColumnAlign;
  width?: string;
  className?: string;
  render?: (row: T, index: number) => React.ReactNode;
  money?: boolean;
  /** 是否允许点击表头进行前端排序 */
  sortable?: boolean;
  /** 自定义排序取值；未提供时优先取 money 列的数值，再尝试取 key 对应字段 */
  sortValue?: (row: T) => string | number | null | undefined;
}

export interface DataTablePagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  data: T[];
  keyExtractor: (row: T, index: number) => string;
  isLoading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: React.ReactNode;
  renderEmpty?: React.ReactNode;
  onRowClick?: (row: T) => void;
  expandedRowKey?: string | null;
  renderExpanded?: (row: T) => React.ReactNode;
  onRowToggleExpand?: (row: T) => void;
  pagination?: DataTablePagination;
  showPageJumper?: boolean;
  renderMobileCard?: (row: T, rowIndex: number) => React.ReactNode;
  className?: string;
  /** 受控排序键（服务端排序时使用） */
  sortKey?: string | null;
  /** 受控排序方向（服务端排序时使用） */
  sortDir?: SortDir;
  /** 排序变化回调；提供时表头点击触发外部排序，组件内部不再对 data 做内存排序 */
  onSortChange?: (key: string, dir: SortDir) => void;
}

const listVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.03 } },
};

const rowVariants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.25 } },
};

function getSortValue<T>(row: T, col: DataTableColumn<T>): string | number | null | undefined {
  if (col.sortValue) return col.sortValue(row);
  if (col.money) {
    const raw = (row as Record<string, unknown>)[col.key];
    return typeof raw === "number" ? raw : undefined;
  }
  const raw = (row as Record<string, unknown>)[col.key];
  if (typeof raw === "number" || typeof raw === "string") return raw;
  return undefined;
}

function renderCell<T>(row: T, rowIndex: number, col: DataTableColumn<T>): React.ReactNode {
  if (col.render) {
    return col.render(row, rowIndex);
  }
  if (col.money) {
    const raw = ((row as Record<string, unknown>)[col.key] as number) ?? 0;
    return <MoneyText value={raw} className="tabular-nums" />;
  }
  return String(((row as Record<string, unknown>)[col.key] as string) ?? "-");
}

function DefaultMobileCard<T>({
  row,
  rowIndex,
  columns,
  onRowClick,
  onRowToggleExpand,
}: {
  row: T;
  rowIndex: number;
  columns: DataTableColumn<T>[];
  onRowClick?: (row: T) => void;
  onRowToggleExpand?: (row: T) => void;
}) {
  const [titleCol, ...restCols] = columns;
  const titleNode = titleCol ? renderCell(row, rowIndex, titleCol) : null;

  const handleClick = () => {
    if (onRowToggleExpand) {
      onRowToggleExpand(row);
    } else {
      onRowClick?.(row);
    }
  };

  return (
    <motion.div
      layout
      variants={rowVariants}
      className={cn(
        "rounded-lg border bg-card text-card-foreground shadow-sm",
        (onRowClick || onRowToggleExpand) && "cursor-pointer hover:bg-muted/30 transition-colors"
      )}
      onClick={handleClick}
    >
      <CardContent className="p-4 space-y-2">
        <div className="text-sm font-medium truncate">{titleNode}</div>
        {restCols.map((col) => (
          <div key={col.key} className="flex justify-between gap-2 text-sm">
            <span className="text-muted-foreground text-xs shrink-0">{col.header}</span>
            <span className="truncate">{renderCell(row, rowIndex, col)}</span>
          </div>
        ))}
      </CardContent>
    </motion.div>
  );
}

function PaginationBar({
  pagination,
  showPageJumper,
}: {
  pagination: DataTablePagination;
  showPageJumper?: boolean;
}) {
  // 薄封装：转调独立 Pagination 组件（data-table 内部继续用，外部新代码可直接用 Pagination）。
  return <Pagination {...pagination} showPageJumper={showPageJumper} />;
}

export function DataTable<T>({
  columns,
  data,
  keyExtractor,
  isLoading,
  emptyTitle,
  emptyDescription,
  emptyAction,
  renderEmpty,
  onRowClick,
  expandedRowKey,
  renderExpanded,
  onRowToggleExpand,
  pagination,
  showPageJumper,
  renderMobileCard,
  className,
  sortKey,
  sortDir,
  onSortChange,
}: DataTableProps<T>) {
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [internalSortKey, setInternalSortKey] = useState<string | null>(null);
  const [internalSortDir, setInternalSortDir] = useState<SortDir>("asc");

  const isControlledSort = sortKey !== undefined;
  const activeSortKey = isControlledSort ? sortKey : internalSortKey;
  const activeSortDir = isControlledSort ? sortDir ?? "asc" : internalSortDir;

  // 统一三态循环：none → asc → desc → none。受控（服务端排序）与非受控（前端排序）
  // 行为一致；清除排序时 key 传空串，消费者可据此回退默认排序（或由 API 兜底）。
  const handleSort = (key: string) => {
    let nextKey = key;
    let nextDir: SortDir = "asc";
    if (activeSortKey === key && activeSortDir !== "asc") {
      // 当前已是 desc，第三次点击清除排序
      nextKey = "";
      nextDir = "asc";
    } else if (activeSortKey === key) {
      // 当前 asc → desc
      nextDir = "desc";
    }
    if (onSortChange) {
      onSortChange(nextKey, nextDir);
    }
    if (!isControlledSort) {
      setInternalSortKey(nextKey || null);
      setInternalSortDir(nextDir);
    }
  };

  const sortedData = useMemo(() => {
    if (onSortChange) return data;
    if (!internalSortKey) return data;
    const col = columns.find((c) => c.key === internalSortKey);
    if (!col || (!col.sortable && !col.money)) return data;
    const dir = internalSortDir === "asc" ? 1 : -1;
    return [...data].sort((a, b) => {
      const av = getSortValue(a, col);
      const bv = getSortValue(b, col);
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * dir;
      }
      return String(av ?? "").localeCompare(String(bv ?? ""), "zh-CN") * dir;
    });
  }, [data, internalSortKey, internalSortDir, columns, onSortChange]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <>
        {renderEmpty ?? (
          <EmptyState
            title={emptyTitle}
            description={emptyDescription}
            action={emptyAction}
          />
        )}
      </>
    );
  }

  const alignClass = (align?: ColumnAlign) =>
    align === "right"
      ? "text-right"
      : align === "center"
        ? "text-center"
        : "text-left";

  const handleRowClick = (row: T) => {
    if (onRowToggleExpand) {
      onRowToggleExpand(row);
    } else {
      onRowClick?.(row);
    }
  };

  if (isMobile && !renderMobileCard) {
    return (
      <div className={cn("space-y-3", className)}>
        <motion.div
          variants={listVariants}
          initial="hidden"
          animate="show"
          className="space-y-3"
        >
          {sortedData.map((row, rowIndex) => {
            const rowKey = keyExtractor(row, rowIndex);
            return (
              <DefaultMobileCard
                key={rowKey}
                row={row}
                rowIndex={rowIndex}
                columns={columns}
                onRowClick={onRowClick}
                onRowToggleExpand={onRowToggleExpand}
              />
            );
          })}
        </motion.div>
        {pagination && (
          <PaginationBar
            pagination={pagination}
            showPageJumper={showPageJumper}
          />
        )}
      </div>
    );
  }

  if (isMobile && renderMobileCard) {
    return (
      <div className={cn("space-y-3", className)}>
        <motion.div
          variants={listVariants}
          initial="hidden"
          animate="show"
          className="space-y-3"
        >
          {sortedData.map((row, rowIndex) => {
            const rowKey = keyExtractor(row, rowIndex);
            return (
              <Fragment key={rowKey}>
                {renderMobileCard(row, rowIndex)}
              </Fragment>
            );
          })}
        </motion.div>
        {pagination && (
          <PaginationBar
            pagination={pagination}
            showPageJumper={showPageJumper}
          />
        )}
      </div>
    );
  }

  return (
    <div className={cn("space-y-4", className)}>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 sticky top-0">
            <tr className="border-b">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    "py-2.5 px-3 font-medium text-muted-foreground whitespace-nowrap",
                    (col.sortable || col.money) && "cursor-pointer select-none hover:bg-muted/60",
                    alignClass(col.align),
                    col.className
                  )}
                  style={col.width ? { width: col.width } : undefined}
                  onClick={() => (col.sortable || col.money) && handleSort(col.key)}
                  title={col.headerTitle}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.header}
                    {(col.sortable || col.money) &&
                      (activeSortKey === col.key ? (
                        activeSortDir === "asc" ? (
                          <ArrowUp className="h-3.5 w-3.5" />
                        ) : (
                          <ArrowDown className="h-3.5 w-3.5" />
                        )
                      ) : (
                        <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground/60" />
                      ))}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <motion.tbody variants={listVariants} initial="hidden" animate="show">
            {sortedData.map((row, rowIndex) => {
              const rowKey = keyExtractor(row, rowIndex);
              const isExpanded = expandedRowKey === rowKey;
              return (
                <Fragment key={rowKey}>
                  <motion.tr
                    layout
                    variants={rowVariants}
                    transition={{ layout: { duration: 0.3 } }}
                    className={cn(
                      "border-b transition-colors",
                      (onRowClick || onRowToggleExpand) && "hover:bg-muted/50 cursor-pointer"
                    )}
                    onClick={() => handleRowClick(row)}
                  >
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={cn(
                          "py-2.5 px-3",
                          alignClass(col.align),
                          col.className
                        )}
                      >
                        {renderCell(row, rowIndex, col)}
                      </td>
                    ))}
                  </motion.tr>
                  {renderExpanded && (
                    <tr className="border-b">
                      <td colSpan={columns.length} className="p-0">
                        <div
                          className="grid bg-muted/30 transition-[grid-template-rows] duration-200 ease-out"
                          style={{ gridTemplateRows: isExpanded ? "1fr" : "0fr" }}
                        >
                          <div className="overflow-hidden">
                            <div
                              className="py-3 px-3 transition-opacity duration-200"
                              style={{ opacity: isExpanded ? 1 : 0 }}
                            >
                              {renderExpanded(row)}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </motion.tbody>
        </table>
      </div>
      {pagination && (
        <PaginationBar
          pagination={pagination}
          showPageJumper={showPageJumper}
        />
      )}
    </div>
  );
}
