"use client";

import { useEffect } from "react";

const CURRENT_BUILD_VERSION = process.env.NEXT_PUBLIC_APP_BUILD_VERSION ?? "development";
const CHECK_INTERVAL_MS = 60_000;

/**
 * Reload tabs that remain open across a deployment.
 *
 * This is deliberately a deployment-contract check, not an API compatibility
 * layer: an old client is discarded before it can keep using removed request
 * parameters against the new server.
 */
export function BuildVersionGuard() {
  useEffect(() => {
    let stopped = false;
    let checking = false;

    async function checkVersion() {
      if (stopped || checking) return;
      checking = true;

      try {
        const response = await fetch(`/api/build-version?t=${Date.now()}`, {
          cache: "no-store",
        });
        if (!response.ok) return;

        const data = (await response.json()) as { version?: string };
        if (data.version && data.version !== CURRENT_BUILD_VERSION) {
          window.location.reload();
        }
      } catch {
        // A transient network failure must not interrupt the current workflow.
      } finally {
        checking = false;
      }
    }

    function checkWhenVisible() {
      if (document.visibilityState === "visible") void checkVersion();
    }

    void checkVersion();
    const intervalId = window.setInterval(checkWhenVisible, CHECK_INTERVAL_MS);
    window.addEventListener("focus", checkWhenVisible);
    window.addEventListener("pageshow", checkWhenVisible);
    document.addEventListener("visibilitychange", checkWhenVisible);

    return () => {
      stopped = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", checkWhenVisible);
      window.removeEventListener("pageshow", checkWhenVisible);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, []);

  return null;
}
