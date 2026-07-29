"use client";

import { useState, useCallback, useMemo } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import * as XLSX from "xlsx";
import { Loader2, Upload, ArrowLeft, ArrowRight, Check, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/ui/page-header";
import { MoneyText } from "@/components/ui/money-text";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { toast } from "sonner";
import { formatLocalDateInput, getTodayLocalDateInput } from "@/lib/finance/date-input";
import { PageShell } from "@/components/ui/page-shell";
import { centsToYuan } from "@/lib/finance/money";

// ─── Types ──────────────────────────────────────────────────────

interface RawRow {
  cells: (string | number | null)[];
  rowIndex: number;
}

interface ParsedRow {
  id: string;
  rowIndex: number;
  payerName: string;
  amount: number;
  date: string; // ISO date string YYYY-MM-DD
  remark: string;
}

/** OCR 预览行：允许字段不完整，人工补齐后再匹配 */
interface ImagePreviewRow {
  id: string;
  rowIndex: number;
  fileName: string;
  payerName: string;
  /** 元，字符串便于编辑；空表示未识别 */
  amount: string;
  /** YYYY-MM-DD，空表示未识别，禁止默认今天 */
  date: string;
  remark: string;
  ocrError?: string;
}

interface MatchCombination {
  invoiceIds: string[];
  /** 单位：分 */
  amounts: number[];
  /** 单位：分 */
  sum: number;
  count: number;
  crossOrder: boolean;
  orderBreakdown: Array<{ orderId: string; sum: number }>;
}

interface MatchApiResponse {
  status: "MATCHED" | "NO_EXACT_MATCH";
  reason?: "SUM_SHORTFALL" | "NO_SUBSET_EQUALS";
  organization?: { id: string; canonicalName: string };
  candidateInvoices?: Array<{
    id: string;
    invoiceNo: string | null;
    totalAmount: number;
    outstanding: number;
    issuedAt: string | null;
    orderId: string | null;
    buyerOrganizationName: string;
  }>;
  combinations?: MatchCombination[];
  nearestBelow?: { sum: number; delta: number; count: number };
  nearestAbove?: { sum: number; delta: number; count: number };
  heuristicReference?: {
    invoiceIds: string[];
    amounts: number[];
    sum: number;
    count: number;
    method: "GREEDY_LARGEST_FIRST";
    note: string;
  };
  degraded?: boolean;
  diagnosticScopeNote?: string;
}

type QueueItemStatus =
  | "pending"
  | "resolving"
  | "matched"
  | "unmatched"
  | "confirming"
  | "confirmed"
  | "error";

interface QueueItem extends ParsedRow {
  status: QueueItemStatus;
  error?: string;
  organizationId?: string;
  organizationName?: string;
  matchResult?: MatchApiResponse;
  selectedCombination?: MatchCombination;
}

interface OrgOption {
  id: string;
  canonicalName: string;
}

// ─── Column mapping helpers ─────────────────────────────────────

const FIELD_LABELS: Record<string, string> = {
  payerName: "付款单位",
  amount: "金额",
  date: "到款日期",
  remark: "备注",
};

const FIELD_KEYWORDS: Record<string, string[]> = {
  payerName: ["付款", "对方户名", "户名", "单位", "客户", "payer", "name"],
  amount: ["金额", "收入", "收款", "amount", "credit", "转入"],
  date: ["日期", "时间", "date", "time"],
  remark: ["备注", "摘要", "用途", "remark", "note", "用途"],
};

function guessColumnMapping(headers: string[]): Record<string, number | null> {
  const mapping: Record<string, number | null> = {
    payerName: null,
    amount: null,
    date: null,
    remark: null,
  };
  const used = new Set<number>();
  for (const [field, keywords] of Object.entries(FIELD_KEYWORDS)) {
    for (let i = 0; i < headers.length; i++) {
      if (used.has(i)) continue;
      const h = String(headers[i] ?? "").toLowerCase();
      if (keywords.some((k) => h.includes(k))) {
        mapping[field] = i;
        used.add(i);
        break;
      }
    }
  }
  return mapping;
}

function parseAmount(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const cleaned = String(v).replace(/,/g, "").replace(/\s+/g, "").trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function excelSerialToDate(serial: number): Date | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 500000) return null;
  const parsed = XLSX.SSF.parse_date_code(serial);
  if (!parsed) return null;
  return new Date(
    parsed.y,
    parsed.m - 1,
    parsed.d,
    parsed.H ?? 0,
    parsed.M ?? 0,
    parsed.S ?? 0,
  );
}

function parseDateString(s: string): Date | null {
  const trimmed = s.trim();
  // 2024-05-01 / 2024/05/01 / 2024-05-01 14:30
  const m = trimmed.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
    return new Date(y, mo - 1, d, h || 0, mi || 0, se || 0);
  }
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDate(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : formatLocalDateInput(v);
  if (typeof v === "number") {
    const d = excelSerialToDate(v);
    return d ? formatLocalDateInput(d) : null;
  }
  const d = parseDateString(String(v));
  return d ? formatLocalDateInput(d) : null;
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Page ─────────────────────────────────────────────────────────

export default function BankFlowImportPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }
  if (!session) {
    router.push("/login");
    return null;
  }
  if (session.user.role !== "ADMIN" && session.user.role !== "USER") {
    router.push("/finance/order-receivables");
    return null;
  }

  return <BankFlowImportContent />;
}

function BankFlowImportContent() {
  const router = useRouter();
  const [step, setStep] = useState<"upload" | "review" | "done">("upload");
  const [importMode, setImportMode] = useState<"excel" | "images">("excel");

  const [rawSheetRows, setRawSheetRows] = useState<unknown[][]>([]);
  const [mapping, setMapping] = useState<Record<string, number | null>>({
    payerName: null,
    amount: null,
    date: null,
    remark: null,
  });
  const [hasHeader, setHasHeader] = useState(true);
  const [imagePreviewRows, setImagePreviewRows] = useState<ImagePreviewRow[]>([]);
  const [ocrRunning, setOcrRunning] = useState(false);

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [processing, setProcessing] = useState(false);

  function looksLikeHeader(row: unknown[]): boolean {
    if (!row || row.length === 0) return false;
    const joined = row
      .map((c) => String(c ?? "").toLowerCase())
      .join(" ");
    return Object.values(FIELD_KEYWORDS)
      .flat()
      .some((kw) => joined.includes(kw));
  }

  const displayHeaders = useMemo<string[]>(() => {
    if (!hasHeader || rawSheetRows.length === 0) return [];
    return rawSheetRows[0].map((h) => String(h ?? "").trim());
  }, [rawSheetRows, hasHeader]);

  const rawRows = useMemo<RawRow[]>(() => {
    const start = hasHeader ? 1 : 0;
    const rows: RawRow[] = [];
    for (let i = start; i < rawSheetRows.length; i++) {
      const cells = rawSheetRows[i] as (string | number | null)[];
      if (!cells || cells.every((c) => c == null || String(c).trim() === "")) continue;
      rows.push({ cells, rowIndex: i + 1 });
    }
    return rows;
  }, [rawSheetRows, hasHeader]);

  const previewColumns = useMemo<DataTableColumn<RawRow>[]>(() => {
    const headers = displayHeaders.length > 0
      ? displayHeaders
      : rawRows[0]?.cells.map((_, i) => `列 ${i + 1}`) ?? [];
    return [
      { key: "rowIndex", header: "行号", align: "center" },
      ...headers.map((h, i) => ({
        key: `col-${i}`,
        header: h,
        render: (r: RawRow) => String(r.cells[i] ?? ""),
      })),
    ];
  }, [displayHeaders, rawRows]);

  const parsedRows = useMemo<ParsedRow[]>(() => {
    const rows: ParsedRow[] = [];
    for (const raw of rawRows) {
      const payerName = mapping.payerName != null ? String(raw.cells[mapping.payerName] ?? "").trim() : "";
      const amount = mapping.amount != null ? parseAmount(raw.cells[mapping.amount]) : null;
      const date = mapping.date != null ? parseDate(raw.cells[mapping.date]) : null;
      const remark = mapping.remark != null ? String(raw.cells[mapping.remark] ?? "").trim() : "";
      if (!payerName || amount == null) continue;
      rows.push({
        id: generateId(),
        rowIndex: raw.rowIndex,
        payerName,
        amount,
        date: date ?? getTodayLocalDateInput(),
        remark,
      });
    }
    return rows;
  }, [rawRows, mapping]);

  const applyHeaderMode = useCallback((withHeader: boolean) => {
    setHasHeader(withHeader);
    const headers = withHeader && rawSheetRows.length > 0
      ? rawSheetRows[0].map((h) => String(h ?? "").trim())
      : [];
    setMapping(headers.length > 0 ? guessColumnMapping(headers) : { payerName: null, amount: null, date: null, remark: null });
  }, [rawSheetRows]);

  const handleFile = useCallback(async (file: File) => {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, { header: 1, defval: null });
    if (json.length === 0) {
      toast.error("文件为空");
      return;
    }

    const detectedHeader = looksLikeHeader(json[0] as unknown[]);
    setRawSheetRows(json as unknown[][]);
    setHasHeader(detectedHeader);
    const headers = detectedHeader ? json[0].map((h) => String(h ?? "").trim()) : [];
    setMapping(headers.length > 0 ? guessColumnMapping(headers) : { payerName: null, amount: null, date: null, remark: null });
  }, []);

  const runAutoMatchRows = useCallback(async (rows: ParsedRow[]) => {
    if (rows.length === 0) return;
    // 核销日期必须明确，禁止空日期静默写库
    const invalidDate = rows.find((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date));
    if (invalidDate) {
      toast.error(`第 ${invalidDate.rowIndex} 行到款日期无效，请补齐 YYYY-MM-DD 后再匹配`);
      return;
    }
    setProcessing(true);
    const initialQueue: QueueItem[] = rows.map((r) => ({ ...r, status: "resolving" }));
    setQueue(initialQueue);
    setStep("review");

    for (let i = 0; i < initialQueue.length; i++) {
      const row = initialQueue[i];
      setQueue((prev) => prev.map((item) => (item.id === row.id ? { ...item, status: "resolving" } : item)));

      try {
        // Resolve organization
        const resolveRes = await fetch("/api/organizations/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: row.payerName }),
        });
        const resolveData = await resolveRes.json();
        if (!resolveRes.ok || !resolveData.organizationId) {
          setQueue((prev) =>
            prev.map((item) =>
              item.id === row.id
                ? {
                    ...item,
                    status: "unmatched",
                    error: resolveData.status === "candidate" ? "请从候选机构中确认" : "未解析到机构",
                    organizationId: undefined,
                    organizationName: undefined,
                  }
                : item,
            ),
          );
          continue;
        }

        const orgId = resolveData.organizationId;
        const orgName = resolveData.canonicalName;

        // Match invoices
        const matchRes = await fetch("/api/finance/payment-vouchers/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId: orgId, amount: row.amount, receivedAt: row.date }),
        });
        const matchData: MatchApiResponse = await matchRes.json();
        if (!matchRes.ok || matchData.status !== "MATCHED" || !matchData.combinations || matchData.combinations.length === 0) {
          setQueue((prev) =>
            prev.map((item) =>
              item.id === row.id
                ? {
                    ...item,
                    status: "unmatched",
                    error: matchData.reason === "SUM_SHORTFALL" ? "候选金额不足" : "无精确匹配组合",
                    organizationId: orgId,
                    organizationName: orgName,
                    matchResult: matchData,
                  }
                : item,
            ),
          );
          continue;
        }

        setQueue((prev) =>
          prev.map((item) =>
            item.id === row.id
              ? {
                  ...item,
                  status: "matched",
                  organizationId: orgId,
                  organizationName: orgName,
                  matchResult: matchData,
                  selectedCombination: matchData.combinations![0],
                }
              : item,
          ),
        );
      } catch {
        setQueue((prev) =>
          prev.map((item) => (item.id === row.id ? { ...item, status: "error", error: "请求失败" } : item)),
        );
      }
    }

    setProcessing(false);
  }, []);

  const runAutoMatch = useCallback(async () => {
    await runAutoMatchRows(parsedRows);
  }, [parsedRows, runAutoMatchRows]);

  const handleImageFiles = useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).slice(0, 10);
    setOcrRunning(true);
    setImagePreviewRows([]);
    try {
      const form = new FormData();
      // 必须用 files 字段触发批量契约（即使只 1 张，失败也返回 results[]）
      for (const f of files) form.append("files", f);
      const res = await fetch("/api/finance/payment-vouchers/ocr", {
        method: "POST",
        body: form,
      });
      let data: Record<string, unknown> = {};
      try {
        data = await res.json();
      } catch {
        data = {};
      }
      type OcrItem = {
        fileName: string;
        ok: boolean;
        fields?: {
          payerName: string | null;
          amountYuan: number | null;
          receivedAt: string | null;
          remark: string | null;
        };
        error?: string;
      };

      let normalized: OcrItem[] = Array.isArray(data.results)
        ? (data.results as OcrItem[])
        : [];

      // 兜底：旧扁平成功 / 502 单文件错误 → 仍生成可编辑预览行
      if (normalized.length === 0) {
        if (data.fields && typeof data.fields === "object") {
          normalized = [{
            fileName: String(data.fileName || files[0]?.name || "image"),
            ok: true,
            fields: data.fields as OcrItem["fields"],
          }];
        } else {
          const errMsg = typeof data.error === "string" ? data.error : (res.ok ? "OCR 无结果" : `OCR 失败 (${res.status})`);
          toast.error(errMsg);
          normalized = files.map((f) => ({
            fileName: f.name || "unknown",
            ok: false,
            error: errMsg,
          }));
        }
      } else if (!res.ok) {
        toast.warning(typeof data.error === "string" ? data.error : "部分 OCR 失败，请人工补齐");
      }

      // 全部进入可编辑预览（含失败/缺字段），日期缺失保持空串，绝不默认今天
      const rows: ImagePreviewRow[] = normalized.map((r, idx) => {
        if (!r.ok || !r.fields) {
          return {
            id: generateId(),
            rowIndex: idx + 1,
            fileName: r.fileName || `file-${idx + 1}`,
            payerName: "",
            amount: "",
            date: "",
            remark: r.fileName || "",
            ocrError: r.error || "OCR 失败",
          };
        }
        const amount =
          r.fields.amountYuan != null && r.fields.amountYuan > 0
            ? String(r.fields.amountYuan)
            : "";
        return {
          id: generateId(),
          rowIndex: idx + 1,
          fileName: r.fileName || `file-${idx + 1}`,
          payerName: (r.fields.payerName || "").trim(),
          amount,
          date: r.fields.receivedAt || "",
          remark: r.fields.remark || r.fileName || "",
          ocrError:
            !r.fields.payerName || r.fields.amountYuan == null || !r.fields.receivedAt
              ? "字段不完整，请人工补齐"
              : undefined,
        };
      });
      setImagePreviewRows(rows);
      const incomplete = rows.filter(
        (r) => r.ocrError || !r.payerName.trim() || !r.amount || !r.date,
      ).length;
      if (rows.length === 0) {
        toast.error("未识别到回单");
      } else if (incomplete > 0) {
        toast.warning(`已载入 ${rows.length} 张，其中 ${incomplete} 张需人工补齐后再匹配`);
      } else {
        toast.success(`识别成功 ${rows.length} 张回单，请确认后自动匹配`);
      }
    } catch {
      toast.error("批量 OCR 请求失败");
    } finally {
      setOcrRunning(false);
    }
  }, []);

  const confirmItem = useCallback(async (item: QueueItem): Promise<boolean> => {
    if (!item.selectedCombination || !item.organizationId) return false;
    setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "confirming" } : q)));

    // match 返回分；receipts POST 契约为元
    const allocations = item.selectedCombination.invoiceIds.map((invoiceId, idx) => ({
      invoiceId,
      amount: centsToYuan(item.selectedCombination!.amounts[idx]),
    }));

    try {
      const res = await fetch("/api/finance/receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: item.amount,
          receivedAt: item.date,
          source: "BANK",
          remark: item.remark || `批量导入：付款单位=${item.payerName}, 命中 ${allocations.length} 张发票`,
          organizationId: item.organizationId,
          allocations,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "error", error: data.error || "核销失败" } : q)));
        return false;
      }
      setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "confirmed" } : q)));
      toast.success(`第 ${item.rowIndex} 行核销成功`);
      return true;
    } catch {
      setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "error", error: "网络错误" } : q)));
      return false;
    }
  }, []);

  const confirmAllMatched = useCallback(async () => {
    const matched = queue.filter((q) => q.status === "matched");
    if (matched.length === 0) return;
    setProcessing(true);
    let failedCount = 0;
    for (const item of matched) {
      const ok = await confirmItem(item);
      if (!ok) failedCount += 1;
    }
    setProcessing(false);

    if (failedCount > 0) {
      toast.error(`${failedCount} 行核销失败，请留在复核页查看失败明细`);
      return;
    }
    setStep("done");
  }, [queue, confirmItem]);

  const matchedCount = queue.filter((q) => q.status === "matched").length;
  const confirmedCount = queue.filter((q) => q.status === "confirmed").length;
  const unmatchedCount = queue.filter((q) => q.status === "unmatched" || q.status === "error").length;

  const columnOptions = useMemo(() => {
    if (displayHeaders.length > 0) {
      return displayHeaders.map((h, i) => ({ value: String(i), label: h || `列 ${i + 1}` }));
    }
    return rawRows[0]?.cells.map((_, i) => ({ value: String(i), label: `列 ${i + 1}` })) ?? [];
  }, [displayHeaders, rawRows]);

  return (
    <PageShell>
      <PageHeader
        title="银行流水批量导入"
        description="上传银行流水 Excel，或批量回单图片 OCR 预填后匹配发票组合，人工复核后批量核销"
        backHref="/finance/order-receivables"
      />

      {step === "upload" && (
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={importMode === "excel" ? "default" : "outline"}
              onClick={() => setImportMode("excel")}
            >
              Excel / CSV
            </Button>
            <Button
              type="button"
              size="sm"
              variant={importMode === "images" ? "default" : "outline"}
              onClick={() => setImportMode("images")}
            >
              回单图片 OCR
            </Button>
          </div>

          {importMode === "excel" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Upload className="h-4 w-4" />
                  上传文件
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Input
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFile(file);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  支持 CSV、Excel 格式。文件第一行可为表头，系统会尝试自动识别“付款单位/对方户名”“金额/收入”“日期”“备注/摘要”列。
                </p>

                {rawRows.length > 0 && (
                  <div className="space-y-4 pt-2">
                    <div className="flex items-center gap-2 text-sm">
                      <Checkbox
                        id="hasHeader"
                        checked={hasHeader}
                        onCheckedChange={(checked) => applyHeaderMode(Boolean(checked))}
                      />
                      <Label htmlFor="hasHeader" className="font-normal cursor-pointer">第一行是表头</Label>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      {( ["payerName", "amount", "date", "remark"] as const ).map((field) => (
                        <div key={field} className="space-y-1">
                          <Label className="text-xs">{FIELD_LABELS[field]}</Label>
                          <Select
                            value={mapping[field] != null ? String(mapping[field]) : ""}
                            onValueChange={(v) =>
                              setMapping((m) => ({ ...m, [field]: v === "" || v == null ? null : parseInt(v, 10) }))
                            }
                          >
                            <SelectTrigger className="h-9 text-xs">
                              <SelectValue placeholder="-- 选择列 --" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="">-- 选择列 --</SelectItem>
                              {columnOptions.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>

                    <DataTable
                      columns={previewColumns}
                      data={rawRows.slice(0, 5)}
                      keyExtractor={(r) => String(r.rowIndex)}
                      emptyTitle="暂无预览数据"
                      className="text-xs"
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {importMode === "images" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Upload className="h-4 w-4" />
                  上传回单图片
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Input
                  type="file"
                  accept="image/jpeg,image/png,application/pdf,.jpg,.jpeg,.png,.pdf"
                  multiple
                  disabled={ocrRunning}
                  onChange={(e) => {
                    void handleImageFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  使用智谱 GLM-OCR 识别付款单位/金额/日期（JPG/PNG/PDF）。单次最多 10 张；结果可编辑补齐，缺日期不会默认今天。需配置 ZHIPU_API_KEY。
                </p>
                {ocrRunning && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> 识别中…
                  </div>
                )}
                {imagePreviewRows.length > 0 && (
                  <div className="space-y-3">
                    {imagePreviewRows.map((row) => {
                      const amountNum = parseFloat(row.amount);
                      const ready =
                        !!row.payerName.trim() &&
                        Number.isFinite(amountNum) &&
                        amountNum > 0 &&
                        /^\d{4}-\d{2}-\d{2}$/.test(row.date);
                      return (
                        <div
                          key={row.id}
                          className="rounded-md border p-3 space-y-2 text-sm"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium">#{row.rowIndex} {row.fileName}</span>
                            {ready ? (
                              <Badge className="bg-success-bg text-success">可匹配</Badge>
                            ) : (
                              <Badge variant="destructive">{row.ocrError || "请补齐字段"}</Badge>
                            )}
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2">
                            <div className="space-y-1">
                              <Label className="text-xs">付款单位 *</Label>
                              <Input
                                value={row.payerName}
                                placeholder="必填"
                                onChange={(e) =>
                                  setImagePreviewRows((prev) =>
                                    prev.map((r) =>
                                      r.id === row.id ? { ...r, payerName: e.target.value, ocrError: undefined } : r,
                                    ),
                                  )
                                }
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">金额(元) *</Label>
                              <Input
                                type="number"
                                step="0.01"
                                value={row.amount}
                                placeholder="必填"
                                onChange={(e) =>
                                  setImagePreviewRows((prev) =>
                                    prev.map((r) =>
                                      r.id === row.id ? { ...r, amount: e.target.value, ocrError: undefined } : r,
                                    ),
                                  )
                                }
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">到款日期 *</Label>
                              <Input
                                type="date"
                                value={row.date}
                                onChange={(e) =>
                                  setImagePreviewRows((prev) =>
                                    prev.map((r) =>
                                      r.id === row.id ? { ...r, date: e.target.value, ocrError: undefined } : r,
                                    ),
                                  )
                                }
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">备注</Label>
                              <Input
                                value={row.remark}
                                onChange={(e) =>
                                  setImagePreviewRows((prev) =>
                                    prev.map((r) =>
                                      r.id === row.id ? { ...r, remark: e.target.value } : r,
                                    ),
                                  )
                                }
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {importMode === "excel" && parsedRows.length > 0 && (
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => router.push("/finance/order-receivables")}>取消</Button>
              <Button onClick={runAutoMatch} disabled={processing}>
                {processing ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <ArrowRight className="h-4 w-4 mr-1" />}
                自动匹配 ({parsedRows.length} 行)
              </Button>
            </div>
          )}

          {importMode === "images" && imagePreviewRows.length > 0 && (
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => router.push("/finance/order-receivables")}>取消</Button>
              <Button
                onClick={() => {
                  const ready: ParsedRow[] = [];
                  const blocked: number[] = [];
                  for (const row of imagePreviewRows) {
                    const amount = parseFloat(row.amount);
                    if (
                      !row.payerName.trim() ||
                      !Number.isFinite(amount) ||
                      amount <= 0 ||
                      !/^\d{4}-\d{2}-\d{2}$/.test(row.date)
                    ) {
                      blocked.push(row.rowIndex);
                      continue;
                    }
                    ready.push({
                      id: row.id,
                      rowIndex: row.rowIndex,
                      payerName: row.payerName.trim(),
                      amount,
                      date: row.date,
                      remark: row.remark,
                    });
                  }
                  if (ready.length === 0) {
                    toast.error("没有可匹配的行：请补齐付款单位、金额、到款日期");
                    return;
                  }
                  if (blocked.length > 0) {
                    toast.warning(`已跳过未补齐的 ${blocked.length} 行（#${blocked.join(", #")}），仅匹配完整行`);
                  }
                  void runAutoMatchRows(ready);
                }}
                disabled={processing || ocrRunning}
              >
                {processing ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <ArrowRight className="h-4 w-4 mr-1" />}
                自动匹配完整行
              </Button>
            </div>
          )}
        </div>
      )}

      {step === "review" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2 text-sm">
              <Badge className="bg-success-bg text-success">已匹配 {matchedCount}</Badge>
              <Badge variant="secondary">已确认 {confirmedCount}</Badge>
              <Badge variant="destructive">待处理 {unmatchedCount}</Badge>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setStep("upload")}>
                <ArrowLeft className="h-4 w-4 mr-1" /> 重新上传
              </Button>
              {matchedCount > 0 && (
                <Button size="sm" onClick={confirmAllMatched} disabled={processing}>
                  <Check className="h-4 w-4 mr-1" />
                  批量确认 {matchedCount} 行
                </Button>
              )}
            </div>
          </div>

          <DataTable
            columns={[
              { key: "rowIndex", header: "行号", align: "center" },
              {
                key: "payerName",
                header: "付款单位",
                render: (item) => (
                  <div className="space-y-1">
                    <p>{item.payerName}</p>
                    {item.organizationName && (
                      <p className="text-xs text-muted-foreground">{item.organizationName}</p>
                    )}
                    {item.status === "unmatched" && !item.organizationId && (
                      <ManualOrgPicker
                        onSelect={(org) => {
                          setQueue((prev) =>
                            prev.map((q) =>
                              q.id === item.id
                                ? { ...q, organizationId: org.id, organizationName: org.canonicalName, error: undefined }
                                : q,
                            ),
                          );
                        }}
                      />
                    )}
                  </div>
                ),
              },
              {
                key: "amount",
                header: "金额",
                align: "right",
                render: (item) => <MoneyText value={item.amount} />,
              },
              { key: "date", header: "日期", render: (item) => item.date },
              {
                key: "status",
                header: "状态",
                align: "center",
                render: (item) => <StatusBadge status={item.status} />,
              },
              {
                key: "match",
                header: "匹配结果",
                render: (item) => <MatchPreview item={item} />,
              },
              {
                key: "actions",
                header: "操作",
                align: "center",
                render: (item) => (
                  <div className="flex items-center justify-center gap-2">
                    {item.status === "matched" && (
                      <Button size="sm" onClick={() => confirmItem(item)} disabled={processing}>
                        确认核销
                      </Button>
                    )}
                    {item.status === "unmatched" && item.organizationId && (
                      <Button size="sm" variant="outline" onClick={() => rerunMatch(item.id, item.organizationId!, item.amount, item.date, setQueue)} disabled={processing}>
                        重新匹配
                      </Button>
                    )}
                    {item.status === "confirmed" && <Check className="h-4 w-4 text-success" />}
                  </div>
                ),
              },
            ]}
            data={queue}
            keyExtractor={(item) => item.id}
          />
        </div>
      )}

      {step === "done" && (
        <div className="text-center py-12 space-y-4">
          <Check className="h-12 w-12 text-success mx-auto" />
          <h2 className="text-xl font-semibold">批量导入完成</h2>
          <p className="text-muted-foreground">已成功确认 {confirmedCount} 笔回款核销。</p>
          <div className="flex items-center justify-center gap-2">
            <Button variant="outline" onClick={() => router.push("/finance/order-receivables")}>返回回款工作台</Button>
            <Button onClick={() => { setStep("upload"); setQueue([]); setRawSheetRows([]); }}>继续导入</Button>
          </div>
        </div>
      )}
    </PageShell>
  );
}

// ─── Sub-components ───────────────────────────────────────────────

const STATUS_BADGE_META: Record<QueueItemStatus, { label: string; className: string; variant?: React.ComponentProps<typeof Badge>["variant"] }> = {
  pending: { label: "待处理", className: "", variant: "outline" },
  resolving: { label: "解析中", className: "", variant: "secondary" },
  matched: { label: "已匹配", className: "bg-success-bg text-success" },
  unmatched: { label: "未匹配", className: "", variant: "destructive" },
  confirming: { label: "确认中", className: "", variant: "secondary" },
  confirmed: { label: "已确认", className: "bg-success-bg text-success", variant: "outline" },
  error: { label: "失败", className: "", variant: "destructive" },
};

function StatusBadge({ status }: { status: QueueItemStatus }) {
  const meta = STATUS_BADGE_META[status];
  return (
    <Badge variant={meta.variant} className={meta.className}>
      {meta.label}
    </Badge>
  );
}

function MatchPreview({ item }: { item: QueueItem }) {
  if (item.status === "confirmed") return <span className="text-xs text-muted-foreground">已核销</span>;
  if (item.error) return <span className="text-xs text-destructive">{item.error}</span>;
  if (!item.selectedCombination) return <span className="text-xs text-muted-foreground">-</span>;
  const combo = item.selectedCombination;
  return (
    <div className="text-xs space-y-0.5">
      <p className="font-medium">
        <MoneyText value={combo.sum} unit="cents" /> / {combo.count} 张发票
      </p>
      {combo.crossOrder && <p className="text-warning">跨订单</p>}
      {item.matchResult?.degraded && (
        <p className="text-warning">
          已降级
          {item.matchResult.heuristicReference ? "（含贪心参考）" : ""}
        </p>
      )}
    </div>
  );
}

async function rerunMatch(
  id: string,
  organizationId: string,
  amount: number,
  date: string,
  setQueue: React.Dispatch<React.SetStateAction<QueueItem[]>>,
) {
  setQueue((prev) => prev.map((q) => (q.id === id ? { ...q, status: "resolving", error: undefined } : q)));
  try {
    const res = await fetch("/api/finance/payment-vouchers/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId, amount, receivedAt: date }),
    });
    const data: MatchApiResponse = await res.json();
    if (!res.ok || data.status !== "MATCHED" || !data.combinations || data.combinations.length === 0) {
      setQueue((prev) =>
        prev.map((q) =>
          q.id === id
            ? { ...q, status: "unmatched", error: data.reason === "SUM_SHORTFALL" ? "候选金额不足" : "无精确匹配组合", matchResult: data }
            : q,
        ),
      );
      return;
    }
    setQueue((prev) =>
      prev.map((q) =>
        q.id === id
          ? { ...q, status: "matched", matchResult: data, selectedCombination: data.combinations![0] }
          : q,
      ),
    );
  } catch {
    setQueue((prev) => prev.map((q) => (q.id === id ? { ...q, status: "error", error: "匹配请求失败" } : q)));
  }
}

function ManualOrgPicker({ onSelect }: { onSelect: (org: OrgOption) => void }) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<OrgOption[]>([]);
  const [loading, setLoading] = useState(false);

  const doSearch = useCallback(async (q: string) => {
    if (!q) { setResults([]); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/organizations/list?search=${encodeURIComponent(q)}`);
      const data = await res.json();
      setResults(Array.isArray(data.organizations) ? data.organizations.slice(0, 5) : []);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div className="mt-1">
      <div className="relative">
        <Search className="absolute left-2 top-1.5 h-3 w-3 text-muted-foreground" />
        <Input
          placeholder="搜索机构..."
          className="h-7 pl-7 text-xs"
          value={search}
          onChange={(e) => { setSearch(e.target.value); doSearch(e.target.value); }}
        />
        {loading && <Loader2 className="absolute right-2 top-1.5 h-3 w-3 animate-spin text-muted-foreground" />}
      </div>
      {results.length > 0 && (
        <div className="border rounded-md mt-1 bg-popover">
          {results.map((o) => (
            <button
              key={o.id}
              type="button"
              className="w-full text-left px-2 py-1 text-xs hover:bg-accent"
              onClick={() => { onSelect(o); setResults([]); setSearch(""); }}
            >
              {o.canonicalName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
