/**
 * Wave R4 HTTP smoke：真实 Next.js Route + NextAuth session
 *
 * Usage:
 *   npm run build   # once, fresh standalone
 *   npx tsx scripts/smoke-test-rep-ops-r4-http.ts
 */

import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { withTempSmokeHttpServer } from "./lib/temp-smoke-http";

const RUN = Date.now().toString(36);
const PREFIX = `R4H-${RUN}`;
const ADMIN_EMAIL = `smoke-r4h-admin-${RUN}@test.local`;
const ADMIN_PW = randomBytes(18).toString("base64url");
const REPA_EMAIL = `smoke-r4h-repa-${RUN}@test.local`;
const REPA_PW = randomBytes(18).toString("base64url");
const REPB_EMAIL = `smoke-r4h-repb-${RUN}@test.local`;
const REPB_PW = randomBytes(18).toString("base64url");

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✅ ${msg}`);
    pass++;
  } else {
    console.log(`  ❌ ${msg}`);
    fail++;
  }
}

function assertEq<T>(actual: T, expected: T, msg: string) {
  assert(
    actual === expected,
    `${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`,
  );
}

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const csrfRes = await fetch(`${baseUrl}/api/auth/csrf`);
  const csrfData = (await csrfRes.json()) as { csrfToken: string };
  const cookiesBefore = csrfRes.headers.get("set-cookie") || "";

  const loginRes = await fetch(`${baseUrl}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookiesBefore,
    },
    body: new URLSearchParams({
      csrfToken: csrfData.csrfToken,
      email,
      password,
      json: "true",
    }),
    redirect: "manual",
  });

  const newCookies = loginRes.headers.get("set-cookie");
  if (!newCookies) {
    const text = await loginRes.text();
    throw new Error(`Login failed (${loginRes.status}): ${text.slice(0, 200)}`);
  }
  return newCookies
    .split(",")
    .map((c) => c.trim().split(";")[0])
    .filter(Boolean)
    .join("; ");
}

async function api(
  baseUrl: string,
  path: string,
  cookie?: string,
  init?: RequestInit,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function main() {
  console.log("=== Wave R4 rep-ops HTTP smoke ===");

  await withTempSmokeHttpServer(async (handle) => {
    handle.assertSafePath();
    const baseUrl = handle.baseUrl;
    const { prisma } = await import("../src/lib/prisma");
    const { REPRESENTATIVE_KIND } = await import("../src/lib/crm/system-representative");

    const admin = await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        name: "R4H Admin",
        password: await bcrypt.hash(ADMIN_PW, 10),
        role: "ADMIN",
      },
    });
    const userA = await prisma.user.create({
      data: {
        email: REPA_EMAIL,
        name: "R4H RepA",
        password: await bcrypt.hash(REPA_PW, 10),
        role: "REPRESENTATIVE",
      },
    });
    const userB = await prisma.user.create({
      data: {
        email: REPB_EMAIL,
        name: "R4H RepB",
        password: await bcrypt.hash(REPB_PW, 10),
        role: "REPRESENTATIVE",
      },
    });
    const repA = await prisma.representative.create({
      data: { name: "R4H RepA", email: userA.email, kind: REPRESENTATIVE_KIND.HUMAN },
    });
    const repB = await prisma.representative.create({
      data: { name: "R4H RepB", email: userB.email, kind: REPRESENTATIVE_KIND.HUMAN },
    });
    const orgA = await prisma.organization.create({
      data: {
        orgCode: `${PREFIX}-OA`,
        canonicalName: `${PREFIX} OrgA`,
        normalizedName: `${PREFIX}-orga`,
      },
    });
    const orgB = await prisma.organization.create({
      data: {
        orgCode: `${PREFIX}-OB`,
        canonicalName: `${PREFIX} OrgB`,
        normalizedName: `${PREFIX}-orgb`,
      },
    });

    const unlinkedRep = await prisma.representative.create({
      data: {
        name: "R4H Unlinked",
        email: `smoke-r4h-unlinked-${RUN}@no-user.local`,
        kind: REPRESENTATIVE_KIND.HUMAN,
      },
    });
    await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-UL`,
        name: `${PREFIX} Unlinked Profile`,
        organizationId: orgA.id,
        organization: orgA.canonicalName,
        // no sales user link for rep; still assign profile to org only? need effective ownership
        ownerUserId: admin.id,
        stage: "ACTIVE",
        assignmentStatus: "ASSIGNED",
        assignedAt: new Date(),
      },
    });
    // explicit assign via owner email bridge is admin, not unlinkedRep; create binding so effective can resolve?
    // For unlinked rep scope empty is ok; we mainly assert route does not 500 and accountUnlinked path works for repA when email broken.
    void unlinkedRep;

    // 55 profiles for A, 1 for B, 1 RECALLED
    const profileIdsA: string[] = [];
    for (let i = 0; i < 55; i++) {
      const p = await prisma.crmCustomerProfile.create({
        data: {
          customerCode: `${PREFIX}-A-${i}`,
          name: `${PREFIX} A${i}`,
          organizationId: orgA.id,
          organization: orgA.canonicalName,
          ownerUserId: userA.id,
          stage: "ACTIVE",
          assignmentStatus: "ASSIGNED",
          assignedAt: new Date(),
        },
      });
      profileIdsA.push(p.id);
    }
    const profileB = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-B`,
        name: `${PREFIX} B`,
        organizationId: orgB.id,
        organization: orgB.canonicalName,
        ownerUserId: userB.id,
        stage: "ACTIVE",
        assignmentStatus: "ASSIGNED",
        assignedAt: new Date(),
      },
    });
    const profileRecalled = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-R`,
        name: `${PREFIX} Recalled`,
        organizationId: orgA.id,
        ownerUserId: userA.id,
        stage: "LEAD",
        assignmentStatus: "RECALLED",
      },
    });

    for (let i = 0; i < 25; i++) {
      await prisma.crmFollowUpTask.create({
        data: {
          profileId: profileIdsA[i % 55],
          ownerUserId: userA.id,
          createdByUserId: admin.id,
          title: `${PREFIX} t${i}`,
          dueAt: new Date("2026-01-01T00:00:00Z"),
          status: "OPEN",
        },
      });
    }
    // orphan overdue: owner A, profile B
    await prisma.crmFollowUpTask.create({
      data: {
        profileId: profileB.id,
        ownerUserId: userA.id,
        createdByUserId: admin.id,
        title: `${PREFIX} orphan`,
        dueAt: new Date("2026-01-01T00:00:00Z"),
        status: "OPEN",
      },
    });

    const inScopeAt = new Date("2026-07-15T10:00:00+08:00");
    const crossAt = new Date("2026-07-17T12:00:00+08:00");
    await prisma.crmVisitCheckin.create({
      data: {
        profileId: profileIdsA[0],
        userId: userA.id,
        status: "COMPLETED",
        addressSnapshot: "in-scope",
        completedAt: inScopeAt,
        createdAt: inScopeAt,
        lat: 31.2,
        lng: 121.5,
        voiceUrl: "secret",
      },
    });
    await prisma.crmVisitCheckin.create({
      data: {
        profileId: profileB.id,
        userId: userA.id,
        status: "COMPLETED",
        addressSnapshot: "cross-secret",
        completedAt: crossAt,
        createdAt: crossAt,
        lat: 1,
        lng: 2,
      },
    });
    await prisma.crmVisitCheckin.create({
      data: {
        profileId: profileRecalled.id,
        userId: userA.id,
        status: "COMPLETED",
        addressSnapshot: "recalled-secret",
        completedAt: crossAt,
      },
    });

    // unauth（显式无 Cookie；proxy withAuth 对 /api/crm 返回 307→/login）
    console.log("\n--- Auth ---");
    const unauthRes = await fetch(`${baseUrl}/api/crm/representatives`, {
      headers: { Cookie: "", Accept: "application/json" },
      cache: "no-store",
      redirect: "manual",
    });
    assert(
      unauthRes.status === 307 || unauthRes.status === 401,
      `unauth list blocked (${unauthRes.status})`,
    );
    if (unauthRes.status === 307) {
      const loc = unauthRes.headers.get("location") || "";
      assert(loc.includes("/login"), `unauth redirect to login (loc=${loc})`);
    }
    // 跟随重定向后不得泄露 JSON 代表列表
    const unauthFollow = await fetch(`${baseUrl}/api/crm/representatives`, {
      headers: { Cookie: "", Accept: "application/json" },
      cache: "no-store",
    });
    const unauthFollowText = await unauthFollow.text();
    assert(
      !unauthFollowText.includes('"representatives"'),
      "unauth follow must not leak representatives JSON",
    );

    const adminCookie = await login(baseUrl, ADMIN_EMAIL, ADMIN_PW);
    const repCookie = await login(baseUrl, REPA_EMAIL, REPA_PW);

    const repList = await api(baseUrl, "/api/crm/representatives", repCookie);
    assertEq(repList.status, 403, "REPRESENTATIVE list 403");

    // list
    console.log("\n--- List / Detail KPI ---");
    const list = await api(baseUrl, "/api/crm/representatives?archived=active", adminCookie);
    assertEq(list.status, 200, "admin list 200");
    const rowA = ((list.json.representatives as Array<Record<string, unknown>> | undefined) || []).find(
      (r) => r.representativeId === repA.id,
    );
    assert(!!rowA, "list contains repA");
    const row = rowA as {
      customerCount: number;
      overdueFollowUps: number;
      visitCheckinCount: number;
      longUnvisitedCount: number;
    };
    assertEq(row.customerCount, 55, "list customerCount=55");
    assertEq(row.overdueFollowUps, 25, "list overdue excludes orphan");
    assert(row.visitCheckinCount >= 1, "list visit includes in-scope");

    const detail = await api(baseUrl, `/api/crm/representatives/${repA.id}`, adminCookie);
    assertEq(detail.status, 200, "detail 200");
    assert(detail.json.accountUnlinked !== true, "linked rep accountUnlinked false/undefined");

    const unlinkedDetail = await api(
      baseUrl,
      `/api/crm/representatives/${unlinkedRep.id}`,
      adminCookie,
    );
    assertEq(unlinkedDetail.status, 200, "unlinked rep detail 200");
    assertEq(unlinkedDetail.json.accountUnlinked, true, "unlinked rep accountUnlinked true");
    assertEq(unlinkedDetail.json.visitCheckinCount, 0, "unlinked visit=0");
    assertEq(unlinkedDetail.json.overdueFollowUps, 0, "unlinked overdue=0");
    assertEq(detail.json.customerCount, row.customerCount, "detail customerCount=list");
    assertEq(detail.json.overdueFollowUps, row.overdueFollowUps, "detail overdue=list");
    assertEq(detail.json.visitCheckinCount, row.visitCheckinCount, "detail visit=list");
    assertEq(detail.json.longUnvisitedCount, row.longUnvisitedCount, "detail longUnvisited=list");
    const detailLast = String(detail.json.lastCheckinAt ?? "");
    const listLast = String((row as { lastCheckinAt?: string | null }).lastCheckinAt ?? "");
    assert(!!detailLast, "detail lastCheckinAt present");
    assert(
      !detailLast.startsWith("2026-07-17"),
      "lastCheckinAt ignores cross-scope newer checkin",
    );
    if (listLast) {
      assertEq(listLast, detailLast, "list lastCheckinAt=detail");
    }
    assertEq(((detail.json.customers as unknown[]) || []).length, 0, "detail overview customers empty array");
    assertEq(((detail.json.openFollowUps as unknown[]) || []).length, 0, "detail overview followUps empty array");

    // checkin DTO min fields
    const checkins = (detail.json.recentCheckins as Array<Record<string, unknown>> | undefined) || [];
    assert(checkins.length >= 1, "detail recent checkins");
    for (const c of checkins) {
      assert(!("lat" in c), "no lat");
      assert(!("lng" in c), "no lng");
      assert(!("voiceUrl" in c), "no voiceUrl");
      assert(!("media" in c), "no media");
      assert(c.profileId !== profileB.id, "no cross profileId in checkins");
      assert(c.profileId !== profileRecalled.id, "no recalled profileId");
    }

    // dashboard alerts align overdue for A
    const dash = await api(baseUrl, "/api/crm/dashboard/admin-overview", adminCookie);
    assertEq(dash.status, 200, "admin overview 200");
    const alertA = ((dash.json.representativeAlerts as Array<Record<string, unknown>> | undefined) || []).find(
      (a) => a.representativeId === repA.id,
    );
    if (row.overdueFollowUps > 0 || row.longUnvisitedCount > 0) {
      assert(!!alertA, "dashboard has repA alert when KPI>0");
      if (alertA) {
        assertEq((alertA as { overdueFollowUps: number }).overdueFollowUps, row.overdueFollowUps, "dashboard overdue=list");
        assertEq((alertA as { longUnvisitedCount: number }).longUnvisitedCount, row.longUnvisitedCount, "dashboard long=list");
      }
    }

    // pagination subroutes
    console.log("\n--- Pagination subroutes ---");
    const c1 = await api(
      baseUrl,
      `/api/crm/representatives/${repA.id}/customers?page=1&pageSize=50`,
      adminCookie,
    );
    const c2 = await api(
      baseUrl,
      `/api/crm/representatives/${repA.id}/customers?page=2&pageSize=50`,
      adminCookie,
    );
    assertEq(c1.status, 200, "customers p1 200");
    assertEq(c2.status, 200, "customers p2 200");
    assertEq(c1.json.total as number, 55, "customers total 55");
    assertEq((c1.json.customers as unknown[]).length, 50, "customers p1 len 50");
    assertEq((c2.json.customers as unknown[]).length, 5, "customers p2 len 5");
    const cids1 = (c1.json.customers as Array<{ id: string }>).map((c) => c.id);
    const cids2 = (c2.json.customers as Array<{ id: string }>).map((c) => c.id);
    assert(cids1.every((id: string) => !cids2.includes(id)), "customers pages no overlap");
    assertEq(new Set([...cids1, ...cids2]).size, 55, "customers union 55");

    const c1b = await api(
      baseUrl,
      `/api/crm/representatives/${repA.id}/customers?page=1&pageSize=50`,
      adminCookie,
    );
    assertEq(
      (c1b.json.customers as Array<{ id: string }>).map((c) => c.id).join(","),
      cids1.join(","),
      "customers p1 stable order",
    );

    const f1 = await api(
      baseUrl,
      `/api/crm/representatives/${repA.id}/follow-ups?page=1&pageSize=20`,
      adminCookie,
    );
    const f2 = await api(
      baseUrl,
      `/api/crm/representatives/${repA.id}/follow-ups?page=2&pageSize=20`,
      adminCookie,
    );
    assertEq(f1.json.total as number, 25, "follow-ups total 25 (no orphan)");
    assertEq((f1.json.openFollowUps as unknown[]).length, 20, "fu p1=20");
    assertEq((f2.json.openFollowUps as unknown[]).length, 5, "fu p2=5");
    const fids1 = (f1.json.openFollowUps as Array<{ id: string }>).map((t) => t.id);
    const fids2 = (f2.json.openFollowUps as Array<{ id: string }>).map((t) => t.id);
    assert(fids1.every((id: string) => !fids2.includes(id)), "fu pages no overlap");

    // report week dates
    console.log("\n--- Report ---");
    const report = await api(
      baseUrl,
      `/api/crm/representatives/${repA.id}/report`,
      adminCookie,
    );
    assertEq(report.status, 200, "report 200");
    assert(!!report.json.periodKey, "report periodKey");
    assert(!!report.json.periodStartDate, "report periodStartDate");
    assert(!!report.json.periodEndDate, "report periodEndDate");
    const badPatch = await api(
      baseUrl,
      `/api/crm/representatives/${repA.id}/report`,
      repCookie,
      {
        method: "PATCH",
        body: JSON.stringify({
          periodType: "WEEK",
          periodKey: report.json.periodKey,
          lines: [
            {
              profileId: profileB.id,
              customerName: "x",
              demand: "d",
              note: "n",
            },
          ],
        }),
      },
    );
    assertEq(badPatch.status, 403, "report PATCH cross-scope 403");

    // lite list
    const lite = await api(baseUrl, "/api/crm/representatives?archived=all&lite=1", adminCookie);
    assertEq(lite.status, 200, "lite list 200");
    assert(
      ((lite.json.representatives as Array<Record<string, unknown>> | undefined) || []).every((r) => r.representativeId && r.name),
      "lite rows have id/name",
    );

    // binding sync partial: inject by monkey? route has real sync; create ACTIVE binding
    console.log("\n--- Binding sync response shape ---");
    const bind = await api(baseUrl, "/api/crm/representative-organizations", adminCookie, {
      method: "POST",
      body: JSON.stringify({
        representativeId: repA.id,
        organizationId: orgA.id,
      }),
    });
    assert(
      bind.status === 200 || bind.status === 201 || bind.status === 207,
      `binding create status ok (${bind.status})`,
    );
    assert("syncOk" in bind.json, "binding returns syncOk field");
    if (bind.status === 200 || bind.status === 201) {
      assertEq(bind.json.syncOk, true, "successful binding syncOk=true");
    }
    if (bind.status === 207) {
      assertEq(bind.json.syncOk, false, "partial binding syncOk=false");
      assertEq(bind.json.syncError, "EFFECTIVE_LINKS_SYNC_FAILED", "partial sync safe error code");
    }

    // cleanup users not required — temp db disposed
    void admin;
    void repB;
  });

  console.log(`\n=== HTTP Result: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
