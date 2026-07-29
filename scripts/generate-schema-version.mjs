#!/usr/bin/env node
/**
 * 构建期生成 Prisma schema 指纹（设计文档 §2.2 schemaVersion 近似）。
 *
 * 仓库使用 `prisma db push`（无 migrations lock），不存在单一权威 schema 版本号。
 * 这里把 prisma/schema.prisma 内容 + @prisma/client 版本做 sha256，取前 12 位，
 * 写入 src/lib/portal/.schema-version.generated.ts（gitignore，不入库）。
 *
 * 运行时 src/lib/portal/runtime-info.ts 通过全局 __SCIMANAGE_SCHEMA_VERSION__
 * 读取该值（Turbopack 生产构建内联为常量）。文件缺失时回退到 client 版本。
 *
 * 由 package.json 的 `prebuild` 自动触发；也可单独运行：
 *   node scripts/generate-schema-version.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const schemaPath = resolve(repoRoot, "prisma/schema.prisma");
const outPath = resolve(repoRoot, "src/lib/portal/.schema-version.txt");

let schemaContent = "";
try {
  schemaContent = readFileSync(schemaPath, "utf8");
} catch (err) {
  console.error("[schema-version] 无法读取 prisma/schema.prisma:", err?.message ?? err);
  process.exit(1);
}

let prismaClientVersion = "unknown";
try {
  const pkg = JSON.parse(
    readFileSync(resolve(repoRoot, "node_modules/@prisma/client/package.json"), "utf8"),
  );
  prismaClientVersion = pkg.version ?? "unknown";
} catch {
  // node_modules 尚未安装（如首次 CI checkout 前）；回退 unknown，仍生成文件。
}

const hash = createHash("sha256")
  .update(`${prismaClientVersion}\n${schemaContent}`)
  .digest("hex")
  .slice(0, 12);

const fingerprint = `prisma-client:${prismaClientVersion}:schema:${hash}`;

// 写入纯文本指纹文件，供 next.config.ts 在构建期读取并经 env 内联到运行时。
// 这样 src/lib/portal/runtime-info.ts 不需要 import 任何 generated .ts（避免
// typecheck:app 在文件缺失时报错），只读 process.env.NEXT_PUBLIC_SCHEMA_VERSION。
writeFileSync(outPath, fingerprint, "utf8");
console.log(`[schema-version] wrote ${outPath} → ${fingerprint}`);
console.log(`[schema-version] wrote ${outPath} → ${fingerprint}`);
