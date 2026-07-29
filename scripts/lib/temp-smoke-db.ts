/**
 * W5.4: isolated temporary SQLite for smoke / KPI scripts.
 *
 * Hard constraints:
 * - Set DATABASE_URL before importing @/lib/prisma or business modules
 * - Build one schema-hashed pristine DB, then clone it per test
 * - Callers must dynamic-import business modules inside the callback
 * - Refuse known dev/demo/prod paths
 * - finally: $disconnect + delete temp dir
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMPLATE_CACHE_VERSION = "v1";
const TEMPLATE_CACHE_DIR = path.join(os.tmpdir(), "scimanage-smoke-schema-cache");
const TEMPLATE_LOCK_TIMEOUT_MS = 120_000;
const TEMPLATE_LOCK_STALE_MS = 180_000;
const TEMPLATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// 防呆守卫：拒绝把这些路径当作临时 smoke 数据库（会覆盖真实数据）。
// 这里只列通用目录约定（不绑定具体用户/主机路径）；部署方按部署真实数据目录
// 补充此列表（例如 /srv/<your-deploy>/task-manager-data/...）。
const FORBIDDEN_DB_PATH_FRAGMENTS = [
  `${path.sep}prisma${path.sep}dev.db`,
  `${path.sep}task-manager-data${path.sep}demo${path.sep}`,
  `${path.sep}task-manager-data${path.sep}prod${path.sep}`,
] as const;

export type TempSmokeDbHandle = {
  dbPath: string;
  databaseUrl: string;
  tempDir: string;
  assertSafePath: () => void;
};

function resolveRepoRoot(): string {
  return path.resolve(__dirname, "../..");
}

export function assertSafeSmokeDatabasePath(dbPath: string): void {
  const normalized = path.resolve(dbPath);
  for (const fragment of FORBIDDEN_DB_PATH_FRAGMENTS) {
    if (normalized.includes(fragment)) {
      throw new Error(
        `[temp-smoke-db] Refusing database path that matches known env DB: ${normalized} (matched ${fragment})`,
      );
    }
  }
  if (normalized.endsWith(`${path.sep}dev.db`) && normalized.includes(`${path.sep}prisma${path.sep}`)) {
    throw new Error(`[temp-smoke-db] Refusing prisma/dev.db: ${normalized}`);
  }
}

function clearPrismaSingleton(): void {
  const g = globalThis as unknown as { prisma?: unknown };
  if ("prisma" in g) delete g.prisma;
}

async function pushSchema(databaseUrl: string, repoRoot: string): Promise<void> {
  const prismaBin = path.join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "prisma.cmd" : "prisma",
  );
  const outputLimit = 1_000_000;
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        prismaBin,
        ["db", "push", "--skip-generate", "--accept-data-loss"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            DATABASE_URL: databaseUrl,
            // Prisma 5 schema-engine 在部分 macOS/Node 组合下无日志级别时会空报
            // "Schema engine error"；显式初始化 Rust logger 可稳定执行。
            RUST_LOG: "info",
          },
          shell: process.platform === "win32",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (stdout.length < outputLimit) stdout += chunk.slice(0, outputLimit - stdout.length);
      });
      child.stderr?.on("data", (chunk: string) => {
        if (stderr.length < outputLimit) stderr += chunk.slice(0, outputLimit - stderr.length);
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    },
  );
  if (result.code !== 0) {
    throw new Error(
      `[temp-smoke-db] prisma db push failed (exit ${result.code}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}

function getTemplateCacheKey(repoRoot: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(TEMPLATE_CACHE_VERSION);
  hash.update(process.platform);
  hash.update(process.arch);
  hash.update(fs.readFileSync(path.join(repoRoot, "prisma", "schema.prisma")));

  // Prisma 升级即使 schema 未变化，也重新生成模板，避免缓存跨引擎版本复用。
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  hash.update(packageJson.dependencies?.["@prisma/client"] ?? "");
  hash.update(packageJson.devDependencies?.prisma ?? "");

  return hash.digest("hex").slice(0, 24);
}

function isUsableTemplate(templatePath: string): boolean {
  try {
    const stat = fs.statSync(templatePath);
    if (!stat.isFile() || stat.size < 100) return false;
    const fd = fs.openSync(templatePath, "r");
    try {
      const header = Buffer.alloc(16);
      return fs.readSync(fd, header, 0, header.length, 0) === header.length
        && header.toString("utf8") === "SQLite format 3\u0000";
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function removeDirBestEffort(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // 主错误由调用方保留；缓存构建目录留在系统 tmp 也不会影响数据安全。
  }
}

function pruneTemplateCache(currentTemplatePath: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(TEMPLATE_CACHE_DIR, { withFileTypes: true });
  } catch {
    return;
  }

  const now = Date.now();
  for (const entry of entries) {
    const entryPath = path.join(TEMPLATE_CACHE_DIR, entry.name);
    try {
      const age = now - fs.statSync(entryPath).mtimeMs;
      if (entry.isDirectory() && entry.name.startsWith("build-") && age > TEMPLATE_LOCK_STALE_MS) {
        removeDirBestEffort(entryPath);
        continue;
      }
      if (
        entry.isFile()
        && entry.name.endsWith(".db")
        && entryPath !== currentTemplatePath
        && age > TEMPLATE_RETENTION_MS
        && !fs.existsSync(`${entryPath}.lock`)
      ) {
        fs.unlinkSync(entryPath);
      }
    } catch {
      // 其他 worker 可能已完成构建或清理；缓存回收失败不应影响测试。
    }
  }
}

async function ensureTemplateDb(repoRoot: string): Promise<string> {
  fs.mkdirSync(TEMPLATE_CACHE_DIR, { recursive: true });
  const cacheKey = getTemplateCacheKey(repoRoot);
  const templatePath = path.join(TEMPLATE_CACHE_DIR, `${cacheKey}.db`);
  const lockPath = `${templatePath}.lock`;
  const startedAt = Date.now();
  pruneTemplateCache(templatePath);

  while (!isUsableTemplate(templatePath)) {
    let lockFd: number | undefined;
    try {
      lockFd = fs.openSync(lockPath, "wx");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      try {
        const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (lockAge > TEMPLATE_LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() - startedAt > TEMPLATE_LOCK_TIMEOUT_MS) {
        throw new Error(`[temp-smoke-db] timed out waiting for schema template: ${templatePath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }

    let buildDir: string | undefined;
    try {
      buildDir = fs.mkdtempSync(path.join(TEMPLATE_CACHE_DIR, "build-"));
      const buildDbPath = path.join(buildDir, "template.db");
      await pushSchema(`file:${buildDbPath}`, repoRoot);
      if (!isUsableTemplate(buildDbPath)) {
        throw new Error(`[temp-smoke-db] prisma db push produced an invalid SQLite template`);
      }
      fs.renameSync(buildDbPath, templatePath);
    } finally {
      if (buildDir) removeDirBestEffort(buildDir);
      if (lockFd !== undefined) fs.closeSync(lockFd);
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // lock 已被清理或缓存目录正被系统回收
      }
    }
  }

  pruneTemplateCache(templatePath);
  return templatePath;
}

export async function createTempSmokeDb(): Promise<TempSmokeDbHandle & { dispose: () => Promise<void> }> {
  const repoRoot = resolveRepoRoot();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "scimanage-smoke-"));
  const dbPath = path.join(tempDir, "smoke.db");
  assertSafeSmokeDatabasePath(dbPath);

  const databaseUrl = `file:${dbPath}`;
  const previousUrl = process.env.DATABASE_URL;
  try {
    const templatePath = await ensureTemplateDb(repoRoot);
    // COPYFILE_FICLONE 在 APFS/btrfs 等文件系统上使用写时复制；不支持时自动回退普通复制。
    fs.copyFileSync(templatePath, dbPath, fs.constants.COPYFILE_FICLONE);
    process.env.DATABASE_URL = databaseUrl;
    clearPrismaSingleton();
  } catch (err) {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    removeDirBestEffort(tempDir);
    throw err;
  }

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    clearPrismaSingleton();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    // SQLite 可能仍有 -wal/-shm；重试删除（Node fs.rmSync maxRetries）
    for (let i = 0; i < 8; i++) {
      try {
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          const p = `${dbPath}${suffix}`;
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        break;
      } catch (err) {
        if (i === 7) {
          console.warn("[temp-smoke-db] failed to remove temp dir", tempDir, err);
        } else {
          await new Promise((r) => setTimeout(r, 50 * (i + 1)));
        }
      }
    }
  };

  return {
    dbPath,
    databaseUrl,
    tempDir,
    assertSafePath: () => assertSafeSmokeDatabasePath(dbPath),
    dispose,
  };
}

/**
 * Run a smoke/KPI body against an isolated temp DB.
 * Business modules (including @/lib/prisma) MUST be dynamic-imported inside `fn`.
 */
export async function withTempSmokeDb<T>(
  fn: (handle: TempSmokeDbHandle) => Promise<T>,
): Promise<T> {
  const handle = await createTempSmokeDb();
  handle.assertSafePath();
  try {
    const { prisma } = await import("../../src/lib/prisma");
    try {
      return await fn(handle);
    } finally {
      await prisma.$disconnect().catch(() => undefined);
      clearPrismaSingleton();
    }
  } finally {
    await handle.dispose();
    if (fs.existsSync(handle.dbPath)) {
      throw new Error(`[temp-smoke-db] temp db still exists after dispose: ${handle.dbPath}`);
    }
  }
}

/** Guard: HTTP smoke must not write to non-local bases without explicit opt-in. */
export function assertLocalSmokeBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`[smoke-http] Invalid SMOKE_BASE_URL: ${baseUrl}`);
  }
  const host = parsed.hostname;
  const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!isLocal && process.env.SMOKE_ALLOW_REMOTE_WRITE !== "1") {
    throw new Error(
      `[smoke-http] Refusing non-localhost write target ${baseUrl}. ` +
        `Set SMOKE_ALLOW_REMOTE_WRITE=1 only for intentional dangerous runs.`,
    );
  }
}
