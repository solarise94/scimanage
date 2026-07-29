"use client";

import { useState, useRef, useCallback } from "react";
import { Search, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

interface TaxIdCandidate {
  name: string;
  taxId: string;
  confidence: number;
  source: string;
  /** 发票四要素（发票 API 命中时填齐） */
  unitAddress?: string;
  unitPhone?: string;
  bankName?: string;
  bankNo?: string;
}

/** 选中候选时回填的发票信息（可选，机构管理页用） */
export interface InvoiceFields {
  taxId: string;
  unitAddress?: string;
  unitPhone?: string;
  bankName?: string;
  bankNo?: string;
}

interface TaxIdLookupInputProps {
  value: string;
  onChange: (value: string) => void;
  orgName: string;
  placeholder?: string;
  required?: boolean;
  className?: string;
  errorMessage?: string;
  onFromLookupChange?: (fromLookup: boolean) => void;
  /** 选中候选时回调完整发票信息（含四要素）。机构管理页用它一次性回填税号+四要素。 */
  onInvoiceSelect?: (fields: InvoiceFields) => void;
}

export function TaxIdLookupInput({
  value, onChange, orgName, placeholder = "统一社会信用代码/纳税人识别号",
  required, className, errorMessage, onFromLookupChange, onInvoiceSelect,
}: TaxIdLookupInputProps) {
  const [looking, setLooking] = useState(false);
  const [candidates, setCandidates] = useState<TaxIdCandidate[]>([]);
  const [showCandidates, setShowCandidates] = useState(false);
  const seqRef = useRef(0);
  const [queriedName, setQueriedName] = useState("");

  const lookup = useCallback(async () => {
    const q = orgName.trim();
    if (!q) { toast.error("请先填写机构名称"); return; }
    const seq = ++seqRef.current;
    setQueriedName(q);
    setLooking(true);
    setCandidates([]);
    setShowCandidates(false);
    try {
      const res = await fetch("/api/tax-id-lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      if (seq !== seqRef.current) return;
      const data = await res.json();
      if (seq !== seqRef.current) return;
      if (!res.ok) throw new Error(data.error || "查询失败");
      const results = (data.candidates || []) as TaxIdCandidate[];
      if (results.length === 0) {
        toast.info("未找到匹配的税号信息");
      } else {
        setCandidates(results);
        setShowCandidates(true);
      }
    } catch (err) {
      if (seq === seqRef.current) toast.error(err instanceof Error ? err.message : "查询失败");
    } finally {
      if (seq === seqRef.current) setLooking(false);
    }
  }, [orgName]);

  const handleSelect = (c: TaxIdCandidate) => {
    onChange(c.taxId);
    onFromLookupChange?.(true);
    setShowCandidates(false);
    if (onInvoiceSelect) {
      onInvoiceSelect({
        taxId: c.taxId,
        unitAddress: c.unitAddress,
        unitPhone: c.unitPhone,
        bankName: c.bankName,
        bankNo: c.bankNo,
      });
    }
    toast.success("已填入税号" + (c.bankName ? "及开票信息" : "") + "，请核实");
  };

  return (
    <div className="space-y-1">
      <div className="flex gap-1.5">
        <Input
          value={value}
          onChange={(e) => { onChange(e.target.value); onFromLookupChange?.(false); }}
          placeholder={placeholder}
          required={required}
          className={`h-8 text-sm flex-1 ${errorMessage ? "border-destructive" : ""} ${className || ""}`}
        />
        <Button
          type="button" size="sm" variant="outline" className="h-8 px-2 shrink-0"
          disabled={looking || !orgName.trim()}
          onClick={lookup}
          title="按机构名查询发票信息（税号+四要素）"
        >
          {looking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
        </Button>
      </div>
      {errorMessage && <p className="text-[10px] text-destructive">{errorMessage}</p>}
      {showCandidates && candidates.length > 0 && queriedName === orgName.trim() && (
        <div className="border rounded-md p-2 space-y-1 bg-muted/50 max-h-56 overflow-y-auto">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">查询结果（点击选用，请人工核实）</span>
            <Button type="button" size="sm" variant="ghost" className="h-5 text-[10px] px-1" onClick={() => setShowCandidates(false)}>关闭</Button>
          </div>
          {candidates.map((c, i) => (
            <button
              key={i} type="button"
              className="w-full text-left p-1.5 rounded hover:bg-accent text-xs transition-colors"
              onClick={() => handleSelect(c)}
            >
              <div className="flex items-center gap-2">
                <span className="font-medium">{c.taxId}</span>
                <span className="text-[10px] text-muted-foreground">置信度 {Math.round(c.confidence * 100)}%</span>
              </div>
              <div className="text-[10px] text-muted-foreground">{c.name}</div>
              {(c.bankName || c.unitAddress || c.unitPhone) && (
                <div className="text-[10px] text-muted-foreground mt-0.5 space-y-0.5">
                  {c.bankName && <div>开户行：{c.bankName}{c.bankNo ? ` ${c.bankNo}` : ""}</div>}
                  {c.unitAddress && <div>地址：{c.unitAddress}</div>}
                  {c.unitPhone && <div>电话：{c.unitPhone}</div>}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
