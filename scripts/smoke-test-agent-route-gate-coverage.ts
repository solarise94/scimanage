/**
 * Agent 用户态路由角色门覆盖静态回归（review P2#3）。
 *
 * 目的：锁定「所有面向用户的 /api/agent/** 路由都必须引用 requireAgentAccess」。
 * 现有 access-matrix smoke 只测 helper 本身（USER→403），无法发现未来新增路由漏门。
 * 本脚本扫描 src/app/api/agent 下所有 route.ts，对每个文件断言：
 *   - 引用了 requireAgentAccess，或
 *   - 在下方白名单内（明确豁免，并附豁免理由）。
 *
 * 运行: npx tsx scripts/smoke-test-agent-route-gate-coverage.ts
 *
 * 新增 /api/agent/** 路由时若忘记加门，本脚本会立即失败，把「USER 可绕过 /agent 页面
 * 直接调 API」的产品边界缺口挡在 CI/本地回归阶段。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(process.cwd(), "src/app/api/agent");

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    pass++;
  } else {
    console.log(`  ✗ ${msg}`);
    fail++;
  }
}

/**
 * 明确豁免 requireAgentAccess 的路由（相对 src/app/api/agent 的 POSIX 路径）。
 * 每项必须附豁免理由。新增豁免时同步更新本说明。
 */
const WHITELIST = new Map<string, string>([
  // 已有更严格的 ADMIN-only 门（session.user.role !== "ADMIN" → 403），
  // 比 canAccessAgent 更紧，无需叠加 requireAgentAccess。
  ["proactive-tasks/check/route.ts", "ADMIN-only（比 canAccessAgent 更严格），既有 403 门已覆盖"],
]);

/** 递归收集目录下所有 route.ts 的相对 POSIX 路径（如 "actions/route.ts"）。 */
function collectRoutes(dir: string, base: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(abs).isDirectory()) {
      out.push(...collectRoutes(abs, rel));
    } else if (entry === "route.ts") {
      out.push(rel);
    }
  }
  return out;
}

function main() {
  console.log("=== Agent 用户态路由角色门覆盖（静态）===\n");

  const routes = collectRoutes(ROOT, "").sort();
  console.log(`扫描到 ${routes.length} 个 /api/agent/** 路由：\n`);

  for (const route of routes) {
    const abs = join(ROOT, route);
    const content = readFileSync(abs, "utf8");

    if (WHITELIST.has(route)) {
      assert(true, `${route} —— 白名单豁免（${WHITELIST.get(route)}）`);
      continue;
    }

    // 必须同时 import 并调用。import 断言保证未被意外删除；调用断言保证不是死 import。
    const hasImport = /from\s+["']@\/lib\/agent-actions\/require-agent-access["']/.test(content);
    const hasCall = /requireAgentAccess\s*\(/.test(content);
    assert(
      hasImport && hasCall,
      `${route} 引用并调用 requireAgentAccess${!hasImport ? "（缺 import）" : ""}${!hasCall ? "（缺调用）" : ""}`,
    );
  }

  // 白名单完整性自检：白名单里的路径必须真实存在，避免豁免项变成隐式漏门。
  console.log("\n[白名单完整性] 每个豁免项对应真实存在的路由");
  for (const route of WHITELIST.keys()) {
    const abs = join(ROOT, route);
    let exists = false;
    try {
      exists = statSync(abs).isFile();
    } catch {
      exists = false;
    }
    assert(exists, `白名单 ${route} 对应的文件存在`);
  }

  // 覆盖完整性自检：白名单 + 被门覆盖的路由 = 全部路由，避免有路由既不在门内也不在白名单。
  const covered = new Set([...WHITELIST.keys()]);
  for (const route of routes) {
    const abs = join(ROOT, route);
    const content = readFileSync(abs, "utf8");
    if (/requireAgentAccess\s*\(/.test(content)) covered.add(route);
  }
  const uncovered = routes.filter((r) => !covered.has(r));
  assert(uncovered.length === 0, `所有路由都被门覆盖或在白名单内（未覆盖: ${uncovered.join(", ") || "无"}）`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("❌ Agent 路由门覆盖回归失败");
    process.exit(1);
  }
  console.log("✅ Agent 路由门覆盖回归通过");
}

main();
