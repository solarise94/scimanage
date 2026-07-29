"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { Loader2, Search, Check, AlertTriangle, Banknote, ArrowLeft, ArrowRight, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { MoneyText } from "@/components/ui/money-text";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { getTodayLocalDateInput } from "@/lib/finance/date-input";
import { centsToYuan, yuanToCents } from "@/lib/finance/money";

// ─── Types ──────────────────────────────────────────────────────
// match API 金额一律为分；展示用 MoneyText unit="cents"；写入 receipts 前转元。

interface CandidateInvoice {
  id: string;
  invoiceNo: string | null;
  totalAmount: number;
  outstanding: number;
  issuedAt: string | null;
  orderId: string | null;
  buyerOrganizationName: string;
}

interface Combination {
  invoiceIds: string[];
  /** 单位：分 */
  amounts: number[];
  /** 单位：分 */
  sum: number;
  count: number;
  crossOrder: boolean;
  orderBreakdown: Array<{ orderId: string; sum: number }>;
  profileIds?: string[];
  profileId: string | null;
  crossProfile?: boolean;
}

interface MatchResponse {
  status: "MATCHED" | "NO_EXACT_MATCH";
  reason?: "SUM_SHORTFALL" | "NO_SUBSET_EQUALS";
  organization: { id: string; canonicalName: string };
  candidateInvoices: CandidateInvoice[];
  orphanInvoiceCount: number;
  excludedCoveredInvoiceCount: number;
  excludedNonIssuedInvoiceCount: number;
  excludedFullyAllocatedInvoiceCount: number;
  /** 单位：分 */
  candidateTotal: number;
  combinations?: Combination[];
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
  degraded: boolean;
  truncated?: boolean;
  hasMore?: boolean;
  totalCombinations?: number;
  diagnosticScopeNote?: string;
}

type WizardStep = "input" | "matching" | "result";

// ─── Props ──────────────────────────────────────────────────────

interface PaymentVoucherWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

// ─── Component ──────────────────────────────────────────────────

export function PaymentVoucherWizard({ open, onOpenChange, onSuccess }: PaymentVoucherWizardProps) {
  const { data: session } = useSession();

  // Step tracking
  const [step, setStep] = useState<WizardStep>("input");

  // Input fields
  const [organizationId, setOrganizationId] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [orgSearch, setOrgSearch] = useState("");
  const [orgResults, setOrgResults] = useState<Array<{ id: string; canonicalName: string }>>([]);
  const [orgSearching, setOrgSearching] = useState(false);
  const [amount, setAmount] = useState("");
  const [receivedAt, setReceivedAt] = useState(getTodayLocalDateInput());
  const [remark, setRemark] = useState("");

  // Matching state
  const [matchResult, setMatchResult] = useState<MatchResponse | null>(null);
  const [matching, setMatching] = useState(false);
  const [selectedCombination, setSelectedCombination] = useState<Combination | null>(null);

  // Confirmation state
  const [confirming, setConfirming] = useState(false);
  const [confirmResult, setConfirmResult] = useState<{
    receipt: { id: string; amount: number };
    allocations: Array<{ invoiceId: string; orderId: string | null; amount: number; newOutstanding: number }>;
    crossOrder: boolean;
    orderBreakdown: Array<{ orderId: string; sum: number }>;
  } | null>(null);

  // OCR (GLM-OCR) — 仅预填，不自动核销
  const [ocrConfigured, setOcrConfigured] = useState<boolean | null>(null);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrFileName, setOcrFileName] = useState<string | null>(null);
  const ocrInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/finance/payment-vouchers/ocr");
        if (!res.ok) {
          if (!cancelled) setOcrConfigured(false);
          return;
        }
        const data = await res.json();
        if (!cancelled) setOcrConfigured(!!data.configured);
      } catch {
        if (!cancelled) setOcrConfigured(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const combinations = matchResult?.combinations;
  /** 分组键：cross | unbound | profileId，避免未绑定与跨客户混桶 */
  const combinationsByBucket = useMemo(() => {
    if (!combinations) return new Map<string, Combination[]>();
    const map = new Map<string, Combination[]>();
    for (const combo of combinations) {
      let key: string;
      if (combo.crossProfile || (combo.profileIds && combo.profileIds.length > 1)) {
        key = "cross";
      } else if (combo.profileId) {
        key = combo.profileId;
      } else if (combo.profileIds && combo.profileIds.length === 1) {
        key = combo.profileIds[0];
      } else {
        key = "unbound";
      }
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(combo);
    }
    return map;
  }, [combinations]);

  const reset = useCallback(() => {
    setStep("input");
    setOrganizationId("");
    setOrganizationName("");
    setOrgSearch("");
    setOrgResults([]);
    setAmount("");
    setReceivedAt(getTodayLocalDateInput());
    setRemark("");
    setMatchResult(null);
    setSelectedCombination(null);
    setConfirmResult(null);
    setOcrFileName(null);
    setOcrLoading(false);
    if (ocrInputRef.current) ocrInputRef.current.value = "";
  }, []);

  const applyOcrFields = useCallback(
    async (fields: {
      payerName: string | null;
      amountYuan: number | null;
      receivedAt: string | null;
      remark: string | null;
    }, warnings: string[]) => {
      if (fields.amountYuan != null && fields.amountYuan > 0) {
        setAmount(String(fields.amountYuan));
      }
      if (fields.receivedAt) {
        setReceivedAt(fields.receivedAt);
      }
      if (fields.remark) {
        setRemark(fields.remark);
      }
      if (fields.payerName) {
        setOrgSearch(fields.payerName);
        setOrganizationId("");
        setOrganizationName("");
        // 自动搜机构；唯一命中时预选
        try {
          const res = await fetch(
            `/api/organizations/list?search=${encodeURIComponent(fields.payerName)}`,
          );
          if (res.ok) {
            const data = await res.json();
            const list = (data.organizations || []) as Array<{ id: string; canonicalName: string }>;
            const sliced = Array.isArray(list) ? list.slice(0, 10) : [];
            setOrgResults(sliced);
            if (sliced.length === 1) {
              setOrganizationId(sliced[0].id);
              setOrganizationName(sliced[0].canonicalName);
              setOrgSearch(sliced[0].canonicalName);
            } else {
              const exact = sliced.find(
                (o) => o.canonicalName === fields.payerName || o.canonicalName.includes(fields.payerName!),
              );
              if (exact && sliced.length <= 3) {
                setOrganizationId(exact.id);
                setOrganizationName(exact.canonicalName);
                setOrgSearch(exact.canonicalName);
              }
            }
          }
        } catch {
          // ignore org search failure; user can pick manually
        }
      }
      if (warnings.length > 0) {
        toast.warning(`识别完成，请核对：${warnings.join("；")}`);
      } else {
        toast.success("回单识别完成，请核对后匹配");
      }
    },
    [],
  );

  const handleOcrFile = useCallback(
    async (file: File | null) => {
      if (!file) return;
      setOcrLoading(true);
      setOcrFileName(file.name);
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/finance/payment-vouchers/ocr", {
          method: "POST",
          body: form,
        });
        const data = await res.json();
        if (!res.ok) {
          toast.error(data.error || "OCR 识别失败");
          return;
        }
        await applyOcrFields(data.fields || {}, data.warnings || []);
      } catch {
        toast.error("OCR 请求失败");
      } finally {
        setOcrLoading(false);
      }
    },
    [applyOcrFields],
  );

  // ─── Organization Search ────────────────────────────────────

  const searchOrg = useCallback(async (q: string) => {
    if (!q || q.length < 1) { setOrgResults([]); return; }
    setOrgSearching(true);
    try {
      const res = await fetch(`/api/organizations/list?search=${encodeURIComponent(q)}`);
      if (res.ok) {
        const data = await res.json();
        const list = data.organizations || [];
        setOrgResults(Array.isArray(list) ? list.slice(0, 10) : []);
      }
    } catch {
      // ignore
    } finally {
      setOrgSearching(false);
    }
  }, []);

  const selectOrg = useCallback((org: { id: string; canonicalName: string }) => {
    setOrganizationId(org.id);
    setOrganizationName(org.canonicalName);
    setOrgSearch(org.canonicalName);
    setOrgResults([]);
  }, []);

  // ─── Run Match ──────────────────────────────────────────────

  const runMatch = useCallback(async () => {
    if (!organizationId || !amount) return;
    setMatching(true);
    setMatchResult(null);
    setSelectedCombination(null);
    try {
      const amt = parseFloat(amount);
      const res = await fetch("/api/finance/payment-vouchers/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, amount: amt }),
      });
      const data: MatchResponse = await res.json();
      if (!res.ok) {
        toast.error((data as unknown as { error: string }).error || "匹配失败");
        return;
      }
      setMatchResult(data);
      if (data.status === "MATCHED" && data.combinations && data.combinations.length > 0) {
        setSelectedCombination(data.combinations[0]);
      }
      setStep("matching");
    } catch {
      toast.error("匹配请求失败");
    } finally {
      setMatching(false);
    }
  }, [organizationId, amount]);

  // ─── Confirm and Write ──────────────────────────────────────

  const confirm = useCallback(async () => {
    if (!matchResult || !selectedCombination || !session?.user) return;
    setConfirming(true);
    try {
      const amt = parseFloat(amount);
      // match 返回分；receipts POST 契约为元
      const allocations = selectedCombination.invoiceIds.map((invId, i) => ({
        invoiceId: invId,
        amount: centsToYuan(selectedCombination.amounts[i]),
      }));
      const res = await fetch("/api/finance/receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: amt,
          receivedAt,
          source: "BANK",
          remark: remark || `凭证匹配：付款单位=${organizationName}, 命中 ${selectedCombination.count} 张发票`,
          organizationId: matchResult.organization.id,
          allocations,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "核销失败");
        return;
      }
      setConfirmResult(data);
      setStep("result");
      onSuccess?.();
    } catch {
      toast.error("核销请求失败");
    } finally {
      setConfirming(false);
    }
  }, [matchResult, selectedCombination, session, amount, receivedAt, remark, organizationName, onSuccess]);

  // ─── Handlers ───────────────────────────────────────────────

  const handleClose = () => {
    reset();
    onOpenChange(false);
  };

  const canMatch = organizationId && amount && parseFloat(amount) > 0;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Banknote className="h-5 w-5" />
            凭证匹配核销
          </DialogTitle>
        </DialogHeader>

        {/* ─── Step 1: 录入凭证 ────────────────────────────── */}
        {step === "input" && (
          <div className="space-y-4">
            {ocrConfigured && (
              <div className="rounded-lg border border-dashed p-3 space-y-2 bg-muted/30">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">上传回单识别（GLM-OCR）</p>
                    <p className="text-xs text-muted-foreground">
                      识别结果仅预填，需人工核对后再匹配核销
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={ocrLoading}
                    onClick={() => ocrInputRef.current?.click()}
                  >
                    {ocrLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-1" />
                    ) : (
                      <Upload className="h-4 w-4 mr-1" />
                    )}
                    {ocrLoading ? "识别中…" : "选择图片"}
                  </Button>
                  <input
                    ref={ocrInputRef}
                    type="file"
                    accept="image/jpeg,image/png,application/pdf,.jpg,.jpeg,.png,.pdf"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0] || null;
                      void handleOcrFile(f);
                      e.target.value = "";
                    }}
                  />
                </div>
                {ocrFileName && (
                  <p className="text-xs text-muted-foreground">已选：{ocrFileName}</p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label>付款单位名称 *</Label>
              <div className="relative">
                <Input
                  placeholder="搜索机构名称..."
                  value={orgSearch}
                  onChange={(e) => {
                    setOrgSearch(e.target.value);
                    setOrganizationId("");
                    setOrganizationName("");
                    searchOrg(e.target.value);
                  }}
                />
                {orgSearching && (
                  <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>
              {orgResults.length > 0 && (
                <div className="border rounded-md mt-1 max-h-40 overflow-y-auto">
                  {orgResults.map((org) => (
                    <button
                      key={org.id}
                      type="button"
                      className={cn(
                        "w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center gap-2",
                        organizationId === org.id && "bg-accent",
                      )}
                      onClick={() => selectOrg(org)}
                    >
                      <span>{org.canonicalName}</span>
                      {organizationId === org.id && <Check className="h-3.5 w-3.5 text-primary ml-auto" />}
                    </button>
                  ))}
                </div>
              )}
              {organizationId && (
                <p className="text-xs text-muted-foreground">
                  已选择: <Badge variant="secondary">{organizationName}</Badge>
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>凭证金额 *</Label>
                <Input
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>到款日期</Label>
                <Input
                  type="date"
                  value={receivedAt}
                  onChange={(e) => setReceivedAt(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>备注（可选）</Label>
              <Input
                placeholder="备注信息"
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
              />
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>取消</Button>
              <Button onClick={runMatch} disabled={!canMatch || matching}>
                {matching ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Search className="h-4 w-4 mr-1" />}
                解析机构并匹配
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* ─── Step 2: 匹配结果 ────────────────────────────── */}
        {step === "matching" && matchResult && (
          <div className="space-y-4">
            {/* Summary bar */}
            <div className="bg-muted rounded-lg p-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">机构:</span>
                <span className="font-medium">{matchResult.organization.canonicalName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">凭证金额:</span>
                <span className="font-medium"><MoneyText value={parseFloat(amount)} /></span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">候选发票 / 合计:</span>
                <span>{matchResult.candidateInvoices.length} 张 / <MoneyText value={matchResult.candidateTotal} unit="cents" /></span>
              </div>
              {matchResult.orphanInvoiceCount > 0 && (
                <div className="text-amber-600 text-xs" title={matchResult.diagnosticScopeNote}>
                  另有 {matchResult.orphanInvoiceCount} 张发票未绑定付款机构，已排除
                  {matchResult.diagnosticScopeNote && (
                    <span className="text-muted-foreground">（诊断口径 ≠ 候选口径）</span>
                  )}
                </div>
              )}
              {matchResult.excludedCoveredInvoiceCount > 0 && (
                <div className="text-amber-600 text-xs">
                  该机构有 {matchResult.excludedCoveredInvoiceCount} 张多订单覆盖发票，Phase 1 暂不支持自动匹配
                </div>
              )}
              {matchResult.excludedNonIssuedInvoiceCount > 0 && (
                <div className="text-muted-foreground text-xs" title={matchResult.diagnosticScopeNote}>
                  该机构有 {matchResult.excludedNonIssuedInvoiceCount} 张发票未达已开票状态，未纳入匹配
                  {matchResult.diagnosticScopeNote && (
                    <span>（诊断口径 ≠ 候选口径）</span>
                  )}
                </div>
              )}
              {matchResult.excludedFullyAllocatedInvoiceCount > 0 && (
                <div className="text-muted-foreground text-xs">
                  该机构有 {matchResult.excludedFullyAllocatedInvoiceCount} 张发票 outstanding 为 0（已核销完毕），已排除
                </div>
              )}
              {matchResult.candidateInvoices.length === 0 && (
                <div className="text-xs text-muted-foreground mt-1">
                  空候选不代表机构解析失败，而是该机构下无可参与自动匹配的发票。
                </div>
              )}
              {matchResult.degraded && (
                <div className="text-amber-600 text-xs">
                  候选数量过多，无法精确枚举
                  {matchResult.heuristicReference ? "；下方提供贪心参考组合（不可核销）" : ""}
                </div>
              )}
              {matchResult.diagnosticScopeNote &&
                (matchResult.orphanInvoiceCount > 0 || matchResult.excludedNonIssuedInvoiceCount > 0) && (
                <div className="text-[11px] text-muted-foreground/80 leading-snug">
                  {matchResult.diagnosticScopeNote}
                </div>
              )}
            </div>

            {/* MATCHED: show combinations */}
            {matchResult.status === "MATCHED" && matchResult.combinations && matchResult.combinations.length > 0 && (
              <>
                <p className="text-sm font-medium">
                  {matchResult.hasMore
                    ? `找到 ${matchResult.totalCombinations ?? matchResult.combinations.length}+ 个组合，已截断展示`
                    : `找到 ${matchResult.totalCombinations ?? matchResult.combinations.length} 个精确匹配组合`}
                </p>

                <div className="space-y-4 max-h-[360px] overflow-y-auto">
                  {Array.from(combinationsByBucket.entries()).map(([bucketKey, combos]) => (
                    <div key={bucketKey} className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        {bucketKey === "cross"
                          ? `跨客户（${combos.length} 个组合）`
                          : bucketKey === "unbound"
                            ? `未绑定客户（${combos.length} 个组合）`
                            : `客户: ${bucketKey.slice(0, 12)}...（${combos.length} 个组合）`}
                      </p>
                      <div className="space-y-2">
                        {(matchResult.truncated ? combos : combos.slice(0, 5)).map((combo, idx) => (
                          <Card
                            key={idx}
                            className={cn(
                              "cursor-pointer transition-colors",
                              selectedCombination === combo
                                ? "border-primary bg-primary/5"
                                : "hover:border-primary/50",
                            )}
                            onClick={() => setSelectedCombination(combo)}
                          >
                            <CardHeader className="py-2 px-3">
                              <CardTitle className="text-sm flex items-center justify-between">
                                <span>组合 #{idx + 1} — {combo.count} 张发票</span>
                                <span className="font-mono"><MoneyText value={combo.sum} unit="cents" /></span>
                              </CardTitle>
                            </CardHeader>
                            <CardContent className="py-1 px-3 space-y-1">
                              {combo.invoiceIds.map((invId, i) => {
                                const inv = matchResult.candidateInvoices.find((c) => c.id === invId);
                                return (
                                  <div key={invId} className="flex justify-between text-xs">
                                    <span className="text-muted-foreground">
                                      {inv?.invoiceNo || `${invId.slice(0, 12)}...`}
                                      {inv?.orderId && (
                                        <span className="ml-1 text-muted-foreground/60">
                                          (订单: {inv.orderId.slice(0, 8)}...)
                                        </span>
                                      )}
                                    </span>
                                    <span className="font-mono"><MoneyText value={combo.amounts[i]} unit="cents" /></span>
                                  </div>
                                );
                              })}
                              {combo.crossOrder && (
                                <p className="text-xs text-amber-600 mt-1">
                                  跨订单核销: {combo.orderBreakdown.map((ob) => `${ob.orderId.slice(0, 8)}...`).join(" + ")}
                                </p>
                              )}
                              {(combo.crossProfile || (combo.profileIds && combo.profileIds.length > 1)) && (
                                <p className="text-xs text-amber-600 mt-1">
                                  跨客户组合（{combo.profileIds?.length ?? 0} 个客户）
                                </p>
                              )}
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* NO_EXACT_MATCH: diagnostics */}
            {matchResult.status === "NO_EXACT_MATCH" && (
              <div className="space-y-3">
                <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                  <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
                  <div className="text-sm">
                    <p className="font-medium text-amber-700">
                      {matchResult.reason === "SUM_SHORTFALL"
                        ? "候选发票合计金额不足"
                        : "未找到精确组合"}
                    </p>
                    <p className="text-amber-600 mt-1">
                      {matchResult.reason === "SUM_SHORTFALL"
                        ? `所有发票 outstanding 合计 ${centsToYuan(matchResult.candidateTotal).toFixed(2)} 元，小于凭证金额 ${parseFloat(amount).toFixed(2)} 元`
                        : "请调整凭证金额或先在发票工作台处理异常发票"}
                    </p>
                  </div>
                </div>

                {/* Nearest combinations */}
                <div className="grid grid-cols-2 gap-2">
                  {matchResult.nearestBelow && (
                    <Card className="p-3 text-sm">
                      <p className="text-muted-foreground">最接近且不超过</p>
                      <p className="font-mono text-lg"><MoneyText value={matchResult.nearestBelow.sum} unit="cents" /></p>
                      <p className="text-xs text-muted-foreground">
                        差额: <MoneyText value={matchResult.nearestBelow.delta} unit="cents" /> | {matchResult.nearestBelow.count} 张发票
                      </p>
                    </Card>
                  )}
                  {matchResult.nearestAbove && (
                    <Card className="p-3 text-sm">
                      <p className="text-muted-foreground">最小超出</p>
                      <p className="font-mono text-lg"><MoneyText value={matchResult.nearestAbove.sum} unit="cents" /></p>
                      <p className="text-xs text-muted-foreground">
                        超出: <MoneyText value={matchResult.nearestAbove.delta} unit="cents" /> | {matchResult.nearestAbove.count} 张发票
                      </p>
                    </Card>
                  )}
                </div>

                {matchResult.heuristicReference && (
                  <Card className="p-3 text-sm border-dashed border-amber-300 bg-amber-50/50">
                    <p className="font-medium text-amber-800">贪心参考组合（非精确，不可核销）</p>
                    <p className="text-xs text-amber-700 mt-1">{matchResult.heuristicReference.note}</p>
                    <p className="font-mono text-lg mt-2">
                      <MoneyText value={matchResult.heuristicReference.sum} unit="cents" />
                      <span className="text-sm text-muted-foreground ml-2">
                        / {matchResult.heuristicReference.count} 张
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      差额{" "}
                      <MoneyText
                        value={matchResult.heuristicReference.sum - yuanToCents(parseFloat(amount) || 0)}
                        unit="cents"
                      />
                    </p>
                  </Card>
                )}
              </div>
            )}

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setStep("input")}>
                <ArrowLeft className="h-4 w-4 mr-1" /> 返回修改
              </Button>
              <Button
                onClick={confirm}
                disabled={
                  !selectedCombination ||
                  matchResult.status !== "MATCHED" ||
                  confirming
                }
              >
                {confirming ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Check className="h-4 w-4 mr-1" />}
                确认核销
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* ─── Step 3: 完成 ─────────────────────────────────── */}
        {step === "result" && confirmResult && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-emerald-600">
              <Check className="h-6 w-6" />
              <span className="font-semibold text-lg">核销完成</span>
            </div>

            <Card>
              <CardContent className="p-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">回款编号:</span>
                  <span className="font-mono">{confirmResult.receipt.id}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">回款金额:</span>
                  <span className="font-medium"><MoneyText value={confirmResult.receipt.amount} /></span>
                </div>
                {confirmResult.crossOrder && (
                  <div className="text-amber-600 text-xs">
                    跨订单核销: {confirmResult.orderBreakdown.map((ob) => (
                      <span key={ob.orderId} className="ml-1">
                        {ob.orderId.slice(0, 8)}... (<MoneyText value={ob.sum} />)
                      </span>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <div>
              <p className="text-sm font-medium mb-2">核销明细</p>
              <div className="space-y-1">
                {confirmResult.allocations.map((a) => {
                  const inv = matchResult?.candidateInvoices.find((c) => c.id === a.invoiceId);
                  return (
                    <div key={a.invoiceId} className="flex justify-between text-sm py-1 border-b">
                      <span className="text-muted-foreground">
                        {inv?.invoiceNo || a.invoiceId.slice(0, 12)}...
                      </span>
                      <span>
                        <MoneyText value={a.amount} />
                        <span className="text-xs text-muted-foreground ml-2">
                          剩余: <MoneyText value={a.newOutstanding} />
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>关闭</Button>
              <Button onClick={() => {
                reset();
                onSuccess?.();
              }}>
                继续匹配 <ArrowRight className="h-4 w-4 ml-1" />
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
