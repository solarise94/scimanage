import { randomBytes, randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

const BASE_URL = process.env.SMOKE_BASE_URL || "http://127.0.0.1:31099";

// 一次性 ADMIN 账号：跑完即删，不依赖任何真实账号或环境变量密码。
const TEST_EMAIL = `smoke-uiopt-${Date.now()}-${randomUUID().slice(0, 8)}@test.local`;
const TEST_PASSWORD = randomBytes(24).toString("base64url");

async function login(email: string, password: string): Promise<string> {
  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
  const csrfData = await csrfRes.json();
  const cookies = csrfRes.headers.get("set-cookie") || "";
  const loginRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies },
    body: new URLSearchParams({ csrfToken: csrfData.csrfToken, email, password, json: "true" } as Record<string, string>),
    redirect: "manual",
  });
  const newCookies = loginRes.headers.get("set-cookie");
  if (!newCookies) {
    const text = await loginRes.text();
    throw new Error(`Login failed: ${loginRes.status} ${text.slice(0, 200)}`);
  }
  return newCookies.split(",").map((c) => c.trim().split(";")[0]).filter(Boolean).join("; ");
}

async function getJson(path: string, cookie: string) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Cookie: cookie } });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}`, detail ? JSON.stringify(detail).slice(0, 200) : "");
  }
}

async function main() {
  console.log("=== Projects/Orders UI Optimization Smoke Test ===");
  console.log(`Test account: ${TEST_EMAIL}（一次性，跑完即删）`);

  const admin = await prisma.user.create({
    data: { email: TEST_EMAIL, name: "smoke-uiopt", password: await bcrypt.hash(TEST_PASSWORD, 12), role: "ADMIN" },
    select: { id: true },
  });

  try {
    const cookie = await login(TEST_EMAIL, TEST_PASSWORD);
    console.log("Login OK\n");

    // 1. 项目 API 全量分支（不传 page）→ { projects } 无 total
    console.log("[1] /api/projects 全量分支（看板视图，不传 page）");
    const full = await getJson("/api/projects?status=ALL", cookie);
    check("HTTP 200", full.status === 200, full.status);
    check("返回 projects 数组", Array.isArray(full.data.projects), Object.keys(full.data));
    check("全量分支无 total 字段（向后兼容）", full.data.total === undefined);
    const fullCount = full.data.projects?.length ?? 0;
    console.log(`    全量返回 ${fullCount} 个项目`);

    // 2. 项目 API 分页分支（传 page）→ { projects, total, page, pageSize, totalPages }
    console.log("[2] /api/projects 分页分支（列表视图，page=1&pageSize=5）");
    const paged = await getJson("/api/projects?status=ALL&page=1&pageSize=5", cookie);
    check("HTTP 200", paged.status === 200, paged.status);
    check("返回 total/page/pageSize/totalPages", typeof paged.data.total === "number" && paged.data.page === 1 && paged.data.pageSize === 5 && typeof paged.data.totalPages === "number", { total: paged.data.total, page: paged.data.page, pageSize: paged.data.pageSize });
    check("分页大小不超过 pageSize", (paged.data.projects?.length ?? 0) <= 5, paged.data.projects?.length);
    check("total 与全量数量一致", paged.data.total === fullCount, { paged: paged.data.total, full: fullCount });
    check("totalPages 计算正确", paged.data.totalPages === Math.ceil(fullCount / 5), { tp: paged.data.totalPages, expect: Math.ceil(fullCount / 5) });

    // 3. project-bind-dialog 兼容性：传 pageSize 但不传 page → 命中全量分支
    console.log("[3] /api/projects?pageSize=20（绑定弹窗口径，无 page）");
    const bindStyle = await getJson("/api/projects?pageSize=20", cookie);
    check("HTTP 200", bindStyle.status === 200, bindStyle.status);
    check("命中全量分支（无 total）", bindStyle.data.total === undefined && Array.isArray(bindStyle.data.projects));

    // 4. 订单 stats 端点
    console.log("[4] /api/orders/stats KPI 聚合");
    const stats = await getJson("/api/orders/stats", cookie);
    check("HTTP 200", stats.status === 200, stats.status);
    const s = stats.data;
    check("含 5 项聚合字段", ["total", "draftCount", "confirmedAmount", "pendingReceivable", "thisMonthCount"].every((k) => typeof s[k] === "number"), Object.keys(s));
    check("待回款 = 已确认 − 已到款（非负）", s.pendingReceivable >= 0, s.pendingReceivable);
    check("draftCount ≤ total", s.draftCount <= s.total, { d: s.draftCount, t: s.total });
    console.log(`    total=${s.total} draft=${s.draftCount} confirmed=${s.confirmedAmount}元 pending=${s.pendingReceivable}元 month=${s.thisMonthCount}`);

    // 5. stats 透传筛选参数（status=CONFIRMED 时 total 应为已确认数）
    console.log("[5] /api/orders/stats?status=CONFIRMED 筛选联动");
    const statsConf = await getJson("/api/orders/stats?status=CONFIRMED", cookie);
    check("HTTP 200", statsConf.status === 200, statsConf.status);
    check("筛选后 total ≤ 全量 total", statsConf.data.total <= s.total, { f: statsConf.data.total, all: s.total });
    check("CONFIRMED 筛选下 draftCount=0", statsConf.data.draftCount === 0, statsConf.data.draftCount);

    // 6. 导出端点仍可用（44 列表头）
    console.log("[6] /api/orders/export/contract-ledger 导出仍正常");
    const expRes = await fetch(`${BASE_URL}/api/orders/export/contract-ledger?format=tsv`, { headers: { Cookie: cookie } });
    check("HTTP 200", expRes.status === 200, expRes.status);
    const expText = await expRes.text();
    const headerCols = expText.split("\n")[0].split("\t");
    check("44 列表头", headerCols.length === 44, headerCols.length);

    // 7. 未授权访问 stats → 401
    console.log("[7] 未登录访问 /api/orders/stats → 401");
    const unauth = await fetch(`${BASE_URL}/api/orders/stats`);
    check("HTTP 401", unauth.status === 401, unauth.status);

    console.log("");
    if (failures === 0) {
      console.log("✅ ALL SMOKE CHECKS PASSED");
    } else {
      console.log(`❌ ${failures} CHECK(S) FAILED`);
      process.exitCode = 1;
    }
  } finally {
    await prisma.user.delete({ where: { id: admin.id } }).catch(() => {});
    console.log(`\nCleaned up test admin ${admin.id}`);
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
