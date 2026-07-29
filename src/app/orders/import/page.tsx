"use client";

import { useState, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { SimpleTable } from "@/components/ui/simple-table";

const DEFAULT_SOURCE = "OTHER_IMPORT";

const CATEGORY_OPTIONS = [
  { value: "SERVICE", label: "服务" },
  { value: "PRODUCT", label: "商品" },
];

export default function OrderImportPage() {
  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-4">
      <Suspense fallback={<div className="text-muted-foreground">加载中...</div>}>
        <ImportContent />
      </Suspense>
    </div>
  );
}

function ImportContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status } = useSession();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [source] = useState(searchParams.get("source") || DEFAULT_SOURCE);
  const [sourceRemark, setSourceRemark] = useState("");
  const [rawText, setRawText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"text" | "file">("text");
  const [category, setCategory] = useState("SERVICE");

  const [step, setStep] = useState<"input" | "preview">("input");
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [aiResult, setAiResult] = useState<Record<string, unknown> | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [columnMapping, setColumnMapping] = useState<Record<string, string> | null>(null);

  if (status === "loading") return <div className="text-muted-foreground">加载中...</div>;
  if (status === "unauthenticated") { router.push("/login"); return null; }

  const isFormData = (p: unknown): p is FormData => p instanceof FormData;

  const buildPayload = (): FormData | Record<string, unknown> => {
    if (mode === "file" && file) {
      const form = new FormData();
      form.set("source", source);
      if (sourceRemark) form.set("sourceRemark", sourceRemark);
      form.set("category", category);
      form.set("file", file);
      if (columnMapping) form.set("columnMapping", JSON.stringify(columnMapping));
      return form;
    }
    const payload: Record<string, unknown> = { source, rawText, category };
    if (sourceRemark) payload.sourceRemark = sourceRemark;
    if (columnMapping) payload.columnMapping = columnMapping;
    return payload;
  };

  const openFilePicker = () => {
    setMode("file");
    window.requestAnimationFrame(() => {
      const input = fileInputRef.current;
      if (input) {
        input.value = "";
        input.click();
      }
    });
  };

  const handlePreview = async () => {
    setLoading(true);
    setError("");
    setPreview(null);
    try {
      const payload = buildPayload();
      const res = await fetch("/api/orders/import/preview", {
        method: "POST",
        ...(isFormData(payload) ? { body: payload } : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
      });
      const d = await res.json();
      if (res.ok) { setPreview(d); setStep("preview"); }
      else setError(d.error || "预览失败");
    } catch (e) {
      setError(`请求失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setLoading(false); }
  };

  const handleAiNormalize = async () => {
    setAiLoading(true);
    setError("");
    try {
      const payload = buildPayload();
      const res = await fetch("/api/orders/import/ai-normalize", {
        method: "POST",
        ...(isFormData(payload) ? { body: payload } : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
      });
      const d = await res.json();
      if (res.ok) setAiResult(d);
      else setError(d.error || "AI 规范化失败");
    } catch (e) {
      setError(`AI 请求失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setAiLoading(false); }
  };

  // 新流程：不再客户端逐批 auto-commit。创建「导入确认会话」后跳转确认页，
  // 由用户逐行确认 CRM 归属再一次性提交（先确认、后落库）。
  const handleCreateSession = async () => {
    setLoading(true);
    setError("");
    try {
      const payload = buildPayload();
      const res = await fetch("/api/orders/import/sessions", {
        method: "POST",
        ...(isFormData(payload) ? { body: payload } : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
      });
      const d = await res.json();
      if (res.ok && d.sessionId) {
        router.push(`/orders/import/${d.sessionId}`);
      } else {
        setError(d.error || "创建确认会话失败");
        setLoading(false);
      }
    } catch (e) {
      setError(`请求失败: ${e instanceof Error ? e.message : String(e)}`);
      setLoading(false);
    }
  };

  const handleDownloadTemplate = async () => {
    try {
      const res = await fetch("/api/orders/import/template");
      if (!res.ok) throw new Error("下载失败");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "order-import-template.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch { setError("模板下载失败"); }
  };

  const resetForm = () => {
    setStep("input");
    setPreview(null);
    setAiResult(null);
    setColumnMapping(null);
    setError("");
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <Link href="/orders" className="text-sm text-muted-foreground hover:underline">&larr; 返回订单列表</Link>
          <h1 className="text-xl font-bold">导入订单列表</h1>
        </div>
        <Button variant="outline" size="sm" onClick={handleDownloadTemplate}>下载模板</Button>
      </div>

      {error && <Card className="p-3 text-sm text-danger bg-danger-bg whitespace-pre-wrap">{error}</Card>}

      {step === "input" && (
        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">来源备注:</span>
            <Input
              className="w-64"
              placeholder="例如：客户转发表格、平台后台导出、合作方提供"
              value={sourceRemark}
              onChange={(e) => setSourceRemark(e.target.value)}
            />
            <span className="text-xs text-muted-foreground">仅作为备注展示，不影响系统去重和导入匹配</span>
          </div>

          <div className="flex gap-2">
            <Button variant={mode === "text" ? "default" : "outline"} size="sm" onClick={() => setMode("text")}>粘贴文本</Button>
            <Button variant={mode === "file" ? "default" : "outline"} size="sm" onClick={openFilePicker}>上传文件</Button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.txt,.tsv,.xlsx,text/csv,text/plain"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="hidden"
          />

          {mode === "text" ? (
            <textarea className="w-full border rounded p-3 text-sm font-mono h-64" value={rawText} onChange={(e) => setRawText(e.target.value)} placeholder="粘贴 CSV/TSV 内容..." />
          ) : (
            <div className="space-y-2">
              <Button type="button" variant="outline" size="sm" onClick={openFilePicker}>重新选择文件</Button>
              {file && <div className="text-sm text-muted-foreground mt-1">已选择: {file.name} ({(file.size / 1024).toFixed(1)} KB)</div>}
            </div>
          )}

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">分类:</span>
              <Select value={category} onValueChange={(v) => setCategory(v || "SERVICE")}>
                <SelectTrigger className="w-24 h-7 text-xs">
                  <span>{CATEGORY_OPTIONS.find((m) => m.value === category)?.label || category}</span>
                </SelectTrigger>
                <SelectContent>
                  {CATEGORY_OPTIONS.map((m) => (<SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Button onClick={handlePreview} disabled={loading || (mode === "text" ? !rawText.trim() : !file)}>
            {loading ? "解析中..." : "预览数据"}
          </Button>
        </Card>
      )}

      {step === "preview" && preview && (
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">数据预览</h2>
            <div className="flex gap-2">
              {(preview.suggestedMode as string) === "AI_NORMALIZE" && (
                <Badge variant="secondary" className="border-warning-border text-warning">建议 AI 规范化</Badge>
              )}
              {(preview.suggestedMode as string) === "DIRECT" && (
                <Badge variant="secondary" className="border-success-border text-success">可直接导入</Badge>
              )}
            </div>
          </div>

          <div className="text-sm text-muted-foreground grid grid-cols-3 gap-2">
            <div>行数: <span className="font-medium">{preview.rowCount as number}</span></div>
            <div>识别列: <span className="font-medium">{(preview.format as Record<string, unknown>)?.headerHits as number || 0}</span></div>
            <div>解析错误: <span className="font-medium">{preview.errorCount as number}</span></div>
          </div>

          <div className="text-xs text-muted-foreground bg-muted/40 rounded p-2">
            下一步将创建「导入确认会话」：系统会对每一行做客户匹配（高置信自动建议 / 歧义 / 未匹配），
            你在确认页逐行确认归属后再统一导入。导入前不会写入任何订单或客户。
          </div>

          {((preview.previewRows as Array<Record<string, unknown>>)?.length ?? 0) > 0 && (
            (() => {
              const previewRows = (preview.previewRows as Array<Record<string, unknown>>) || [];
              const previewColumns = previewRows.length > 0
                ? Object.keys(previewRows[0]).slice(0, 8).map((k) => ({
                    key: k,
                    header: k,
                    render: (r: Record<string, unknown>) => String(r[k] ?? ""),
                  }))
                : [];
              return (
                <SimpleTable
                  className="text-xs"
                  columns={previewColumns}
                  data={previewRows.slice(0, 5)}
                  keyExtractor={(_, i) => String(i)}
                  emptyTitle="无预览数据"
                />
              );
            })()
          )}

          {(preview.suggestedMode as string) === "AI_NORMALIZE" && (
            <div className="space-y-2">
              <Button variant="outline" size="sm" onClick={handleAiNormalize} disabled={aiLoading}>
                {aiLoading ? "AI 处理中..." : "AI 规范化表头"}
              </Button>
              {aiResult && (
                <Card className="p-3 bg-muted/30 space-y-2">
                  {(aiResult.needsChunking as boolean) && (
                    <p className="text-xs text-warning">
                      该文件列数较多（{aiResult.rawColumns as number} 列），已拆分为 {(aiResult.chunks as Array<unknown>)?.length} 个分块，请逐块发送给 AI 处理后合并。
                    </p>
                  )}
                  {(aiResult.prompt as string) && (
                    <>
                      <p className="text-xs font-medium">将以下 prompt 发送给 AI 获取列映射 JSON：</p>
                      <pre className="text-xs whitespace-pre-wrap max-h-40 overflow-y-auto bg-background rounded p-2">{(aiResult.prompt as string).slice(0, 2000)}{(aiResult.prompt as string).length > 2000 ? "\n...(已截断)" : ""}</pre>
                    </>
                  )}
                  {(aiResult.chunks as Array<Record<string, unknown>>)?.map((chunk, i) => (
                    <details key={i} className="text-xs">
                      <summary className="cursor-pointer font-medium">分块 {i + 1}（{chunk.columns as number} 列）</summary>
                      <pre className="whitespace-pre-wrap max-h-32 overflow-y-auto bg-background rounded p-2 mt-1">{(chunk.prompt as string)?.slice(0, 1500)}{(chunk.prompt as string)?.length > 1500 ? "\n...(已截断)" : ""}</pre>
                    </details>
                  ))}
                  <div className="space-y-1">
                    <p className="text-xs font-medium">粘贴 AI 返回的列映射 JSON：</p>
                    <textarea
                      className="w-full border rounded p-2 text-xs font-mono h-20"
                      placeholder={`{"原始列名": "标准字段名", ...}`}
                      value={columnMapping ? JSON.stringify(columnMapping, null, 2) : ""}
                      onChange={(e) => {
                        try { setColumnMapping(JSON.parse(e.target.value) as Record<string, string>); } catch { /* invalid JSON while typing */ }
                      }}
                    />
                    {columnMapping && (
                      <p className="text-xs text-success">已加载 {Object.keys(columnMapping).length} 个列映射</p>
                    )}
                  </div>
                </Card>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="outline" onClick={resetForm}>返回修改</Button>
            <Button onClick={handleCreateSession} disabled={loading}>
              {loading ? "创建会话中..." : `进入确认页 (${preview.rowCount} 行)`}
            </Button>
          </div>
        </Card>
      )}

      <div className="text-sm text-muted-foreground">
        提示：导入采用「先确认、后落库」。预览解析无误后进入确认页，逐行确认客户归属（或新建客户），
        系统再一次性创建订单并写回 CRM 归属。
      </div>
    </>
  );
}
