/**
 * C2 空壳客户扫描（设计文档 §3.2 / §八 Phase G2；W6.7 Profile-only 契约）。
 *
 * 空壳 = 未删除/未归档/未合并的 CrmCustomerProfile AND 强信号四件套全空。
 * 订单计数只认 Order.profileId（不再回落遗留 Customer 锚点）。
 */

import { prisma } from "@/lib/prisma";
import { GOVERNANCE_ORDER_STATUSES, isStrongSignalEmpty, readProfileOrg } from "@/lib/governance/common";

export type EmptyShellSubClass = "C2a" | "C2b" | "C2c";

export interface EmptyShellCustomer {
  profileId: string;
  name: string;
  organization: string | null;
  organizationId: string | null;
  orderCount: number;
  blockingOrderCount: number;
  createdAt: Date;
  subClass: EmptyShellSubClass;
}

export async function scanEmptyShellCustomers(subClass?: EmptyShellSubClass): Promise<EmptyShellCustomer[]> {
  const profiles = await prisma.crmCustomerProfile.findMany({
    where: {
      deleted: false,
      archived: false,
      mergedIntoProfileId: null,
    },
    select: {
      id: true,
      createdAt: true,
      name: true,
      wechat: true,
      phone: true,
      principal: true,
      miniProgramId: true,
      organization: true,
      organizationId: true,
    },
  });

  const profileIds = profiles.map((p) => p.id);

  const orderByProfile =
    profileIds.length > 0
      ? await prisma.order.groupBy({
          by: ["profileId"],
          where: {
            profileId: { in: profileIds },
            deleted: false,
            archived: false,
            status: { in: [...GOVERNANCE_ORDER_STATUSES] },
          },
          _count: { _all: true },
        })
      : [];
  const orderCountByProfile = new Map<string, number>();
  for (const g of orderByProfile) {
    if (g.profileId) orderCountByProfile.set(g.profileId, g._count._all);
  }

  const blockingByProfile =
    profileIds.length > 0
      ? await prisma.order.groupBy({
          by: ["profileId"],
          where: { profileId: { in: profileIds } },
          _count: { _all: true },
        })
      : [];
  const blockingByProfileMap = new Map<string, number>();
  for (const g of blockingByProfile) {
    if (g.profileId) blockingByProfileMap.set(g.profileId, g._count._all);
  }

  const result: EmptyShellCustomer[] = [];
  for (const p of profiles) {
    if (!isStrongSignalEmpty(p)) continue;
    const org = readProfileOrg(p);
    const orderCount = orderCountByProfile.get(p.id) ?? 0;
    const blockingOrderCount = blockingByProfileMap.get(p.id) ?? 0;

    let cls: EmptyShellSubClass;
    if (blockingOrderCount > 0) cls = "C2a";
    else if (org.organization) cls = "C2b";
    else cls = "C2c";
    if (subClass && cls !== subClass) continue;

    result.push({
      profileId: p.id,
      name: p.name ?? "未命名客户",
      organization: org.organization,
      organizationId: org.organizationId,
      orderCount,
      blockingOrderCount,
      createdAt: p.createdAt,
      subClass: cls,
    });
  }

  const order: Record<EmptyShellSubClass, number> = { C2a: 0, C2b: 1, C2c: 2 };
  result.sort((a, b) => order[a.subClass] - order[b.subClass] || b.createdAt.getTime() - a.createdAt.getTime());
  return result;
}

export async function countEmptyShellCustomers(): Promise<number> {
  return (await scanEmptyShellCustomers()).length;
}
