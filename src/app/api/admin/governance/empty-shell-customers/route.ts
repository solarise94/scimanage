import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { GOVERNANCE_ORDER_STATUSES } from "@/lib/governance/common";
import { scanEmptyShellCustomers, type EmptyShellSubClass } from "@/lib/governance/customer-scan";
import {
  loadAddressMatchOrganizations,
  extractOrgFromAddress,
  type OrderAddressOrgCandidate,
} from "@/lib/orders/order-address-org";

const PAGE_SIZE = 20;
const SUB_CLASSES: EmptyShellSubClass[] = ["C2a", "C2b", "C2c"];

// GET /api/admin/governance/empty-shell-customers?page=1&subClass=C2a
// C2 空壳 Profile 列表（W6.7：响应只含 profileId，无 Customer 锚点字段）。
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get("pageSize") || String(PAGE_SIZE), 10) || PAGE_SIZE));
  const subClassParam = searchParams.get("subClass");
  const subClass = SUB_CLASSES.includes(subClassParam as EmptyShellSubClass)
    ? (subClassParam as EmptyShellSubClass)
    : undefined;

  const all = await scanEmptyShellCustomers(subClass);
  const total = all.length;
  const totalPages = Math.ceil(total / pageSize);
  const slice = all.slice((page - 1) * pageSize, page * pageSize);

  const needAddressHint = slice.filter((r) => r.subClass === "C2a" && !r.organization);
  const addressHints = new Map<string, OrderAddressOrgCandidate>();
  if (needAddressHint.length > 0) {
    const orgs = await loadAddressMatchOrganizations();
    const profileIds = needAddressHint.map((r) => r.profileId);
    const orders = await prisma.order.findMany({
      where: {
        profileId: { in: profileIds },
        deleted: false,
        archived: false,
        status: { in: [...GOVERNANCE_ORDER_STATUSES] },
        buyerAddressSnapshot: { not: null },
      },
      select: { profileId: true, buyerAddressSnapshot: true },
    });
    for (const o of orders) {
      if (!o.profileId || addressHints.has(o.profileId)) continue;
      const cand = extractOrgFromAddress(orgs, o.buyerAddressSnapshot);
      if (cand) addressHints.set(o.profileId, cand);
    }
  }

  const rows = slice.map((r) => ({
    ...r,
    addressOrgHint: addressHints.get(r.profileId) ?? null,
  }));

  return NextResponse.json({ rows, total, page, pageSize, totalPages });
}
