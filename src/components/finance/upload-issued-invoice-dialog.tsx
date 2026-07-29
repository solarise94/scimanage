"use client";

import { useState } from "react";
import { Upload, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";

interface UploadIssuedInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceId: string;
  onSuccess: () => void;
}

export function UploadIssuedInvoiceDialog({
  open,
  onOpenChange,
  invoiceId,
  onSuccess,
}: UploadIssuedInvoiceDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [actualInvoiceNo, setActualInvoiceNo] = useState("");
  const [actualIssuedAt, setActualIssuedAt] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setFile(null);
    setActualInvoiceNo("");
    setActualIssuedAt("");
  };

  const handleSubmit = async () => {
    if (!file) return;
    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("externalOrderInvoiceRequestId", invoiceId);
      if (actualInvoiceNo.trim()) formData.append("actualInvoiceNo", actualInvoiceNo.trim());
      if (actualIssuedAt.trim()) formData.append("actualIssuedAt", actualIssuedAt.trim());

      const res = await fetch("/api/finance/invoice-documents", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "上传失败");
      }
      reset();
      onSuccess();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "上传失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>登记已开票</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>
              真实发票附件 <span className="text-destructive">*</span>
            </Label>
            <Input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp,.tiff,.tif"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
            <p className="text-[11px] text-muted-foreground">
              支持 PDF、JPG、PNG、WebP、TIFF，最大 20 MB
            </p>
          </div>
          <div className="space-y-1">
            <Label>发票号码</Label>
            <Input
              value={actualInvoiceNo}
              onChange={(e) => setActualInvoiceNo(e.target.value)}
              placeholder="选填，如已知真实发票号可填入"
            />
          </div>
          <div className="space-y-1">
            <Label>开票日期</Label>
            <Input
              type="date"
              value={actualIssuedAt}
              onChange={(e) => setActualIssuedAt(e.target.value)}
            />
          </div>
          <Button
            className="w-full"
            onClick={handleSubmit}
            disabled={!file || submitting}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : (
              <Upload className="h-4 w-4 mr-1" />
            )}
            {submitting ? "提交中..." : "确认登记"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
