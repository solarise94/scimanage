"use client";

/**
 * Agent Resource navigation hook.
 *
 * Owns the Resource View state machine for the Agent workspace.  Driven
 * **only** by explicit user actions (clicking an in-chat resource link) —
 * never by `tool_end` / proposal / session-restore events.
 *
 * State machine (see docs §3.2):
 *   closed -> resolving -> open(resource)
 *     push history / back / forward / reload / openFullPage / close
 *
 * The hook calls `POST /api/agent/resources/resolve` to turn a client request
 * into a canonical, permission-checked `AgentResourceLocation`.  If the server
 * says the entity is not embeddable (or the user lacks permission), we either
 * fall back to a full-page navigation or surface the error — we never open a
 * half-rendered resource.
 */

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type {
  AgentResourceLocation,
  AgentResourceRequest,
  AgentResourceTarget,
} from "@/lib/agent-resources/types";

export interface AgentResourceState {
  /** Ordered navigation stack (entries[index] is the current resource). */
  entries: AgentResourceLocation[];
  index: number;
  /** Mobile: whether the full-screen sheet is mounted/open. Desktop derives panel visibility from entries.length. */
  open: boolean;
}

export interface AgentResourceNavigation {
  state: AgentResourceState;
  /** True while a resolve request is in-flight (shows a spinner in the panel/sheet header). */
  resolving: boolean;
  /** Current resource (top of the history stack), or null when closed. */
  current: AgentResourceLocation | null;
  canBack: boolean;
  canForward: boolean;
  /** Monotonic counter bumped to force the active View to refetch its data. */
  reloadToken: number;
  /** Open a resource request (entity preferred; href fallback). */
  openResource: (request: AgentResourceRequest, target?: AgentResourceTarget) => Promise<void>;
  back: () => void;
  forward: () => void;
  reload: () => void;
  close: () => void;
  /** Navigate the whole app to the current resource's canonical href. */
  openFullPage: (href?: string) => void;
}

const CLOSED: AgentResourceState = { entries: [], index: -1, open: false };

function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "打开资源失败";
}

/**
 * Resolve a resource request via the server, then either embed it (push onto
 * history) or navigate away to a full page.
 */
export function useAgentResourceNavigation(): AgentResourceNavigation {
  const router = useRouter();
  const [state, setState] = useState<AgentResourceState>(CLOSED);
  const [resolving, setResolving] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  // Guard against resolve races: only the most recent request may mutate state.
  const resolveSeqRef = useRef(0);

  const openResource = useCallback(
    async (request: AgentResourceRequest, target: AgentResourceTarget = "workspace") => {
      // Fast path: explicit "page" target skips the panel entirely.
      if (target === "page") {
        const href = request.type === "href" ? request.href : undefined;
        if (href) {
          router.push(href);
          return;
        }
      }

      const seq = ++resolveSeqRef.current;
      setResolving(true);
      try {
        const res = await fetch("/api/agent/resources/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(typeof data.error === "string" ? data.error : "打开资源失败");
        }
        if (seq !== resolveSeqRef.current) return;

        const resolution = data.resolution;
        if (!resolution) {
          throw new Error("打开资源失败");
        }

        if (resolution.mode === "navigate") {
          // Not embeddable (or href request) — open as a full page.
          router.push(resolution.href);
          return;
        }

        // Embed: push onto history stack (truncate any forward history).
        const location = resolution.location as AgentResourceLocation;
        if (target === "page") {
          // Explicit full-page target: navigate to the canonical href instead
          // of embedding, even though the resource is embeddable.
          router.push(location.href);
          return;
        }
        setState((current) => {
          // If the same resource is already current, just refocus (no duplicate).
          const existing = current.entries[current.index];
          if (existing && existing.key === location.key) {
            return { ...current, open: true };
          }
          const baseEntries = current.entries.slice(0, current.index + 1);
          const entries = [...baseEntries, location];
          return { entries, index: entries.length - 1, open: true };
        });
      } catch (error) {
        if (seq !== resolveSeqRef.current) return;
        toast.error(errorToMessage(error));
      } finally {
        if (seq === resolveSeqRef.current) {
          setResolving(false);
        }
      }
    },
    [router],
  );

  const back = useCallback(() => {
    setState((current) => {
      if (current.index <= 0) {
        // No more history — close the panel/sheet.
        return CLOSED;
      }
      return { ...current, index: current.index - 1 };
    });
  }, []);

  const forward = useCallback(() => {
    setState((current) => {
      if (current.index >= current.entries.length - 1) return current;
      return { ...current, index: current.index + 1 };
    });
  }, []);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  const close = useCallback(() => {
    setState(CLOSED);
  }, []);

  const openFullPage = useCallback(
    (href?: string) => {
      // Read state directly — never run router.push inside a setState updater
      // (updaters must be pure; Strict Mode double-invokes them).
      const target = href ?? state.entries[state.index]?.href;
      if (target) router.push(target);
    },
    [router, state],
  );

  // Reset the panel when the user switches Agent session is intentionally NOT
  // done here — per the plan, switching sessions does not auto-close an
  // explicitly opened resource.  The shell owns session boundaries.

  const current = state.index >= 0 ? state.entries[state.index] ?? null : null;

  return {
    state,
    resolving,
    current,
    canBack: state.index > 0,
    canForward: state.index < state.entries.length - 1,
    reloadToken,
    openResource,
    back,
    forward,
    reload,
    close,
    openFullPage,
  };
}
