"use client";

import { useEffect, useState, useCallback } from "react";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import type { RuntimeInfo } from "@/lib/runtime-info";

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <span className="break-all text-[11px] text-foreground">{value || "-"}</span>
    </>
  );
}

type PanelState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "done"; info: RuntimeInfo };

export function RuntimeDebugPanel() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PanelState>({ phase: "idle" });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        setOpen((prev) => !prev);
      } else if (event.key === "Escape") {
        setOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const fetchInfo = useCallback(async (signal: AbortSignal): Promise<PanelState> => {
    const res = await fetch("/api/runtime-info", {
      headers: { "x-runtime-debug": "1" },
      cache: "no-store",
      signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return { phase: "error", message: data?.error || "运行环境信息读取失败" };
    }
    return { phase: "done", info: data as RuntimeInfo };
  }, []);

  useEffect(() => {
    if (!open || state.phase === "done") return;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 5000);

    let cancelled = false;
    fetchInfo(controller.signal)
      .then((result) => { if (!cancelled) setState(result); })
      .catch((err: Error) => {
        if (!cancelled) {
          setState({ phase: "error", message: err.name === "AbortError" ? "读取超时" : err.message });
        }
      })
      .finally(() => window.clearTimeout(timeoutId));

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [open, state.phase, fetchInfo]);

  if (!open) return null;

  return (
    <aside className="fixed bottom-4 right-4 z-[100] w-[min(26rem,calc(100vw-2rem))] rounded-lg border border-border bg-background/95 p-4 shadow-lg backdrop-blur">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">运行环境面板</div>
          <div className="text-[11px] text-muted-foreground">快捷键 Ctrl/Cmd + Shift + D</div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          aria-label="关闭运行环境面板"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {(state.phase === "idle" || state.phase === "loading") ? (
        <div className="text-sm text-muted-foreground">读取中...</div>
      ) : state.phase === "error" ? (
        <div className="text-sm text-destructive">{state.message}</div>
      ) : state.phase === "done" ? (
        <div className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-2">
          <InfoRow label="环境" value={state.info.runtimeName} />
          <InfoRow label="数据库" value={state.info.databaseLabel} />
          <InfoRow label="Base URL" value={state.info.baseUrl} />
          <InfoRow label="绑定" value={[state.info.hostname, state.info.port].filter(Boolean).join(":")} />
          <InfoRow label="模式" value={state.info.nodeEnv} />
          <InfoRow label="页面" value={pathname || "/"} />
        </div>
      ) : null}
    </aside>
  );
}
