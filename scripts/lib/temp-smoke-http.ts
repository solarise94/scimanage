/**
 * W5.4: start a local Next.js standalone server bound to a temporary SQLite DB.
 *
 * Flow: temp DB → spawn standalone on ephemeral port → SMOKE_BASE_URL=http://127.0.0.1:PORT
 * → run smoke → kill server → dispose temp DB.
 *
 * W6.6: fail-closed build freshness — if git HEAD or dirty src/prisma is newer than
 * standalone, refuse to run (avoids false pass/fail on stale builds). Override only with
 * SMOKE_SKIP_BUILD_STAMP=1 (not for CI).
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  assertLocalSmokeBaseUrl,
  assertSafeSmokeDatabasePath,
  createTempSmokeDb,
  type TempSmokeDbHandle,
} from "./temp-smoke-db";

export type TempSmokeHttpHandle = TempSmokeDbHandle & {
  baseUrl: string;
  port: number;
};

function resolveRepoRoot(): string {
  return path.resolve(__dirname, "../..");
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to allocate free port"));
        return;
      }
      const { port } = addr;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

async function waitForHealthy(baseUrl: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/auth/session`);
      if (res.status === 200 || res.status === 401) return;
      lastErr = `status ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`[smoke-http] Server not healthy at ${baseUrl} (${lastErr})`);
}

function resolveStandaloneServer(repoRoot: string): string {
  const candidates = [
    path.join(repoRoot, ".next/standalone/server.js"),
    path.join(repoRoot, ".next/standalone", path.basename(repoRoot), "server.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    "[smoke-http] Missing .next/standalone/server.js. Run `npm run build` once before HTTP smokes.",
  );
}

/**
 * Fail-closed: standalone must be at least as new as git HEAD and any dirty src/prisma files.
 * Prevents HTTP smokes from validating against a stale production build (false pass/fail).
 */
export function assertStandaloneBuildFresh(repoRoot: string, serverJs: string): void {
  if (process.env.SMOKE_SKIP_BUILD_STAMP === "1") {
    console.warn("[smoke-http] SMOKE_SKIP_BUILD_STAMP=1 — skipping standalone freshness check");
    return;
  }

  if (!fs.existsSync(serverJs)) {
    throw new Error(
      "[smoke-http] Missing standalone server. Run `npm run build` before HTTP smokes.",
    );
  }
  const serverMtimeMs = fs.statSync(serverJs).mtimeMs;
  const skewMs = 2_000; // allow small clock/fs skew

  const head = spawnSync("git", ["log", "-1", "--format=%ct"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (head.status === 0) {
    const headSec = parseInt(head.stdout.trim(), 10);
    if (Number.isFinite(headSec) && headSec * 1000 > serverMtimeMs + skewMs) {
      throw new Error(
        `[smoke-http] standalone is older than git HEAD (HEAD=${new Date(headSec * 1000).toISOString()}, server=${new Date(serverMtimeMs).toISOString()}). Run \`npm run build\` then re-run the smoke.`,
      );
    }
  }

  const dirty = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=no", "--", "src", "prisma", "package.json", "next.config.ts", "tsconfig.json"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (dirty.status !== 0) return;

  const lines = dirty.stdout.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const staleFiles: string[] = [];
  for (const line of lines) {
    // porcelain: XY PATH or XY ORIG -> PATH
    const pathPart = line.slice(3).includes(" -> ")
      ? line.slice(3).split(" -> ").pop()!.trim()
      : line.slice(3).trim();
    if (!pathPart) continue;
    const abs = path.join(repoRoot, pathPart);
    if (!fs.existsSync(abs)) continue;
    const mtime = fs.statSync(abs).mtimeMs;
    if (mtime > serverMtimeMs + skewMs) staleFiles.push(pathPart);
  }
  if (staleFiles.length > 0) {
    const sample = staleFiles.slice(0, 8).join(", ");
    const more = staleFiles.length > 8 ? ` (+${staleFiles.length - 8} more)` : "";
    throw new Error(
      `[smoke-http] working tree sources newer than standalone: ${sample}${more}. Run \`npm run build\` (or commit after rebuild) before HTTP smokes.`,
    );
  }
}

/**
 * Run an HTTP smoke against a local standalone server wired to an isolated temp DB.
 * Sets process.env.SMOKE_BASE_URL for the duration of `fn`.
 */
export async function withTempSmokeHttpServer<T>(
  fn: (handle: TempSmokeHttpHandle) => Promise<T>,
): Promise<T> {
  const repoRoot = resolveRepoRoot();
  const db = await createTempSmokeDb();
  db.assertSafePath();
  assertSafeSmokeDatabasePath(db.dbPath);

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  assertLocalSmokeBaseUrl(baseUrl);

  const serverJs = resolveStandaloneServer(repoRoot);
  assertStandaloneBuildFresh(repoRoot, serverJs);
  const previousBase = process.env.SMOKE_BASE_URL;
  process.env.SMOKE_BASE_URL = baseUrl;

  let child: ChildProcess | null = null;
  try {
    child = spawn(process.execPath, [serverJs], {
      cwd: path.dirname(serverJs),
      env: {
        ...process.env,
        HOSTNAME: "127.0.0.1",
        PORT: String(port),
        DATABASE_URL: db.databaseUrl,
        NEXTAUTH_URL: baseUrl,
        NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET || "smoke-temp-secret-not-for-prod",
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (buf) => {
      stderr += buf.toString();
    });
    child.on("exit", (code, signal) => {
      if (code && code !== 0) {
        console.warn(`[smoke-http] server exited code=${code} signal=${signal}\n${stderr.slice(-2000)}`);
      }
    });

    await waitForHealthy(baseUrl);

    const handle: TempSmokeHttpHandle = {
      ...db,
      baseUrl,
      port,
    };
    return await fn(handle);
  } finally {
    if (child?.pid) {
      try {
        child.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 500));
        if (!child.killed) child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    if (previousBase === undefined) delete process.env.SMOKE_BASE_URL;
    else process.env.SMOKE_BASE_URL = previousBase;
    await db.dispose();
    if (fs.existsSync(db.dbPath)) {
      throw new Error(`[smoke-http] temp db still exists after dispose: ${db.dbPath}`);
    }
  }
}
