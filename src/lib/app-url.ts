const DEFAULT_APP_BASE_URL = "http://localhost:3000";

export function getAppBaseUrl(): string {
  const rawBaseUrl =
    process.env.NEXTAUTH_URL?.trim() ||
    process.env.APP_BASE_URL?.trim() ||
    DEFAULT_APP_BASE_URL;

  return rawBaseUrl.replace(/\/+$/, "");
}

/**
 * Server-to-server base URL for Agent sidecar → Next.js tool bridge.
 *
 * Must NOT reuse NEXTAUTH_URL / APP_BASE_URL: those are public auth/link URLs
 * (frp host ports, TLS domains). Inside a demo container the public host port
 * (e.g. 31081) is not listening on loopback — Next.js listens on PORT (3000).
 *
 * Priority: AGENT_INTERNAL_APP_URL → getAppBaseUrl() (local/dev fallback).
 * Never write this value into Magic Links or user-visible URLs.
 */
export function getAgentInternalAppBaseUrl(): string {
  const configured = process.env.AGENT_INTERNAL_APP_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  return getAppBaseUrl();
}

export function getAppUrl(
  path: string,
  searchParams?: Record<string, string | null | undefined>
): string {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, getAppBaseUrl());

  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== null && value !== undefined) {
        url.searchParams.set(key, value);
      }
    }
  }

  return url.toString();
}

export function getMagicLinkUrl(token: string, redirect?: string): string {
  return getAppUrl("/magic-link", { token, redirect });
}
