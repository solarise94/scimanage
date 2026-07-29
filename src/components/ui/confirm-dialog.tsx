"use client";
import { useState, useCallback } from "react";
import { create } from "zustand";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";

type DialogVariant = "default" | "destructive";

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: DialogVariant;
}

interface PromptOptions extends ConfirmOptions {
  defaultValue?: string;
  placeholder?: string;
}

type DialogMode = "confirm" | "prompt";

interface DialogState {
  open: boolean;
  mode: DialogMode;
  options: ConfirmOptions | PromptOptions;
  resolve: ((value: unknown) => void) | null;
  submitting: boolean;
}

interface ConfirmStore extends DialogState {
  setOpen: (open: boolean) => void;
  setSubmitting: (submitting: boolean) => void;
  startConfirm: (options: ConfirmOptions, resolve: (value: boolean) => void) => void;
  startPrompt: (options: PromptOptions, resolve: (value: string | null) => void) => void;
  startAlert: (options: ConfirmOptions, resolve: () => void) => void;
  close: () => void;
}

const useConfirmStore = create<ConfirmStore>((set) => ({
  open: false,
  mode: "confirm",
  options: { title: "" },
  resolve: null,
  submitting: false,
  setOpen: (open) => set({ open }),
  setSubmitting: (submitting) => set({ submitting }),
  startConfirm: (options, resolve) =>
    set({ open: true, mode: "confirm", options, resolve: resolve as (value: unknown) => void, submitting: false }),
  startPrompt: (options, resolve) =>
    set({ open: true, mode: "prompt", options, resolve: resolve as (value: unknown) => void, submitting: false }),
  startAlert: (options, resolve) =>
    set({ open: true, mode: "confirm", options: { ...options, confirmText: options.confirmText ?? "确定" }, resolve: resolve as (value: unknown) => void, submitting: false }),
  close: () => set({ open: false, resolve: null, submitting: false }),
}));

export function useConfirm() {
  const startConfirm = useConfirmStore((s) => s.startConfirm);
  const startPrompt = useConfirmStore((s) => s.startPrompt);
  const startAlert = useConfirmStore((s) => s.startAlert);

  const confirm = useCallback(
    (options: ConfirmOptions): Promise<boolean> =>
      new Promise((resolve) => {
        startConfirm(options, resolve);
      }),
    [startConfirm]
  );

  const prompt = useCallback(
    (options: PromptOptions): Promise<string | null> =>
      new Promise((resolve) => {
        startPrompt(options, resolve);
      }),
    [startPrompt]
  );

  const alert = useCallback(
    (options: ConfirmOptions): Promise<void> =>
      new Promise((resolve) => {
        startAlert(options, resolve);
      }),
    [startAlert]
  );

  return { confirm, prompt, alert };
}

export function ConfirmDialogProvider({ children }: { children: React.ReactNode }) {
  const { open, mode, options, resolve, submitting, setOpen, close } = useConfirmStore();
  const [inputValue, setInputValue] = useState("");

  const isDestructive = options.variant === "destructive";
  const confirmLabel = options.confirmText ?? (isDestructive ? "确认" : "确定");
  const cancelLabel = (options as ConfirmOptions).cancelText ?? "取消";

  const handleOpenChange = (next: boolean) => {
    if (!next && resolve && !submitting) {
      resolve(mode === "prompt" ? null : false);
    }
    setOpen(next);
    if (!next) setInputValue("");
  };

  const handleConfirm = () => {
    if (mode === "prompt") {
      resolve?.(inputValue);
    } else {
      resolve?.(true);
    }
    close();
  };

  const handleCancel = () => {
    if (resolve) resolve(mode === "prompt" ? null : false);
    close();
  };

  return (
    <>
      {children}
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{options.title}</DialogTitle>
            {options.description && <DialogDescription>{options.description}</DialogDescription>}
          </DialogHeader>
          {mode === "prompt" && (
            <Input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={(options as PromptOptions).placeholder}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && inputValue.trim()) {
                  handleConfirm();
                }
              }}
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={handleCancel} disabled={submitting}>
              {cancelLabel}
            </Button>
            <Button
              variant={isDestructive ? "destructive" : "default"}
              onClick={handleConfirm}
              disabled={submitting || (mode === "prompt" && !inputValue.trim())}
            >
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export type { ConfirmOptions, PromptOptions };
