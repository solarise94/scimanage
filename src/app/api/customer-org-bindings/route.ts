import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getCrmLifecycleSummariesForProfiles } from "@/lib/crm/lifecycle";
import { resolveEffectiveRepresentativesForProfiles } from "@/lib/crm/customer-effective-representative";
import { getProfileAddressOrgHints } from "@/lib/customers/customer-address-org-hints";

async function assertAdmin(session: { user: { id: string; role: string } } | null) {
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!user || user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return null;
}

const VALID_STATUS = new Set(["PENDING", "PROCESSING", "RESOLVED", "IGNORED"]);
const VALID_CONFIDENCE = new Set(["EXACT", "CANDIDATE", "UNMATCHED"]);

type OrderOrgHint = {
  orgText: string;
  orderCount: number;
  latestOrderNo: string | null;
};

// Phase E contract：Customer 锚点模型已删除，任务列表全部从 profile 侧取数
//（残留统计用 profile 反向关系 _count，历史代表取 profileProjects 最近一条代表快照）。
const taskInclude = {
  profile: {
    select: {
      id: true,
      name: true,
      customerCode: true,
      organizationId: true,
      organization: true,
      organizationRawInput: true,
      ownerUserId: true,
      ownerUser: { select: { name: true } },
      profileProjects: {
        where: { representativeId: { not: null } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { representativeId: true, representative: true },
      },
      _count: {
        select: {
          interactions: true,
          followUpTasks: true,
          addresses: true,
          visitCheckins: true,
          applications: true,
          profileProjects: true,
          profileExternalOrders: true,
          profileFinanceCosts: true,
          profileFinanceReceipts: true,
          profileFinanceAdvances: true,
          profileRepTags: true,
          relationsFromProfile: true,
          relationsToProfile: true,
        },
      },
    },
  },
  suggestedOrg: { select: { id: true, canonicalName: true, orgCode: true, isInvoiceSubject: true, archived: true } },
  suggestedSite: { select: { id: true, siteName: true } },
  resolvedOrg: { select: { id: true, canonicalName: true, orgCode: true } },
  resolvedSite: { select: { id: true, siteName: true } },
  resolvedBy: { select: { id: true, name: true } },
} satisfies Prisma.CustomerOrgBindingTaskInclude;

type TaskWithProfile = Prisma.CustomerOrgBindingTaskGetPayload<{ include: typeof taskInclude }>;

function buildCleanupResidue(prof: TaskWithProfile["profile"]) {
  return {
    crmInteractions: prof?._count.interactions ?? 0,
    crmFollowUpTasks: prof?._count.followUpTasks ?? 0,
    crmAddresses: prof?._count.addresses ?? 0,
    crmVisitCheckins: prof?._count.visitCheckins ?? 0,
    crmApplications: prof?._count.applications ?? 0,
    externalOrders: prof?._count.profileExternalOrders ?? 0,
    financeRecords:
      (prof?._count.profileFinanceCosts ?? 0)
      + (prof?._count.profileFinanceReceipts ?? 0)
      + (prof?._count.profileFinanceAdvances ?? 0),
    repTags: prof?._count.profileRepTags ?? 0,
    relations: (prof?._count.relationsFromProfile ?? 0) + (prof?._count.relationsToProfile ?? 0),
  };
}

// 订单单位线索：只按 Order.profileId 读取（Profile-only）
async function getOrderOrgHints(profileIds: string[]): Promise<Map<string, OrderOrgHint[]>> {
  const uniqueIds = [...new Set(profileIds.filter(Boolean))];
  const result = new Map<string, OrderOrgHint[]>();
  if (uniqueIds.length === 0) return result;

  const orders = await prisma.order.findMany({
    where: {
      profileId: { in: uniqueIds },
      deleted: false,
      archived: false,
      buyerOrgNameSnapshot: { not: null },
    },
    select: {
      profileId: true,
      orderNo: true,
      buyerOrgNameSnapshot: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const byProfile = new Map<string, Map<string, OrderOrgHint & { latestAt: Date }>>();
  for (const order of orders) {
    if (!order.profileId) continue;
    const orgText = (order.buyerOrgNameSnapshot || "").trim();
    if (!orgText || orgText === "总店") continue;
    let orgMap = byProfile.get(order.profileId);
    if (!orgMap) {
      orgMap = new Map();
      byProfile.set(order.profileId, orgMap);
    }
    const existing = orgMap.get(orgText);
    if (existing) {
      existing.orderCount += 1;
      if (order.createdAt > existing.latestAt) {
        existing.latestAt = order.createdAt;
        existing.latestOrderNo = order.orderNo;
      }
    } else {
      orgMap.set(orgText, {
        orgText,
        orderCount: 1,
        latestOrderNo: order.orderNo,
        latestAt: order.createdAt,
      });
    }
  }

  for (const [profileId, orgMap] of byProfile) {
    const hints = [...orgMap.values()]
      .sort((a, b) => b.orderCount - a.orderCount || b.latestAt.getTime() - a.latestAt.getTime())
      .slice(0, 3)
      .map((hint) => ({
        orgText: hint.orgText,
        orderCount: hint.orderCount,
        latestOrderNo: hint.latestOrderNo,
      }));
    result.set(profileId, hints);
  }
  return result;
}

// 需求 1 · 绑定任务列表。支持 status / confidence / search（客户名/编码模糊）筛选 + 分页。
// 增强：业务画像（订单/项目/代表/档案状态）、三无客户高亮、无档案但有业务数据筛选。
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const forbidden = await assertAdmin(session);
  if (forbidden) return forbidden;

  const { searchParams } = new URL(req.url);
  const statusParam = searchParams.get("status");
  const confidenceParam = searchParams.get("confidence");
  const search = searchParams.get("search")?.trim() || "";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get("pageSize") || "20", 10) || 20));
  const noProfile = searchParams.get("noProfile") === "1";
  const tripleNone = searchParams.get("tripleNone") === "1";
  const tripleNoneText = searchParams.get("tripleNoneText");

  const andConditions: Prisma.CustomerOrgBindingTaskWhereInput[] = [];

  // 活动主体 = task.profile（Profile-only）
  andConditions.push({
    profile: {
      deleted: false,
      archived: false,
      mergedIntoProfileId: null,
    },
  });

  // status：默认 PENDING；显式传 "ALL" 表示不过滤
  if (statusParam && statusParam !== "ALL") {
    if (VALID_STATUS.has(statusParam)) andConditions.push({ status: statusParam });
  } else if (!statusParam) {
    andConditions.push({ status: "PENDING" });
  }

  if (confidenceParam && confidenceParam !== "ALL" && VALID_CONFIDENCE.has(confidenceParam)) {
    andConditions.push({ matchConfidence: confidenceParam });
  }

  if (search) {
    andConditions.push({
      OR: [
        { customerName: { contains: search } },
        { profile: { customerCode: { contains: search } } },
        { profile: { name: { contains: search } } },
      ],
    });
  }

  // noProfile：机构补绑任务必有 profileId，该筛选项不再适用（返回空集，避免误展示）
  if (noProfile) {
    andConditions.push({ id: { in: [] } });
  }

  // 三无粗筛：Profile 无机构 + 无历史订单（精确无代表需内存过滤）
  if (tripleNone) {
    andConditions.push({
      profile: {
        organizationId: null,
        profileOrders: {
          none: {
            status: { in: ["CONFIRMED", "CLOSED"] },
            deleted: false,
            archived: false,
          },
        },
      },
    });
  }

  const where: Prisma.CustomerOrgBindingTaskWhereInput = andConditions.length > 0 ? { AND: andConditions } : {};

  const enrichTask = (
    task: TaskWithProfile,
    lifecycleMap: Awaited<ReturnType<typeof getCrmLifecycleSummariesForProfiles>>,
    effectiveRepMap: Awaited<ReturnType<typeof resolveEffectiveRepresentativesForProfiles>>,
    orderOrgHintsMap: Map<string, OrderOrgHint[]>,
    addressOrgHintsMap: Awaited<ReturnType<typeof getProfileAddressOrgHints>>,
  ) => {
    const prof = task.profile;
    const resolvedProfileId = task.profileId;
    const lifecycle = lifecycleMap.get(resolvedProfileId);
    const effective = effectiveRepMap.get(resolvedProfileId);
    const historicalRep = prof?.profileProjects[0]?.representative ?? null;

    // 无机构以 task.profile.organizationId 为准；无代表仅看 Profile effective
    const isTripleNone =
      (prof?.organizationId ?? null) === null &&
      (lifecycle?.historicalOrderCount ?? 0) === 0 &&
      (effective?.source === "NONE" || effective?.source === "SYSTEM_FALLBACK" || !effective?.representativeId);

    return {
      ...task,
      profileId: resolvedProfileId,
      portrait: {
        orderCount: lifecycle?.historicalOrderCount ?? 0,
        orderAmountCents: lifecycle?.activeOrderAmount ?? 0,
        projectCount: prof?._count.profileProjects ?? 0,
        historicalRepName: historicalRep || null,
        hasProfile: true,
        profileOwnerName: prof?.ownerUser?.name || null,
      },
      orderOrgHints: orderOrgHintsMap.get(resolvedProfileId) ?? [],
      addressOrgHints: addressOrgHintsMap.get(resolvedProfileId) ?? [],
      cleanupResidue: buildCleanupResidue(prof),
      isTripleNone,
    };
  };

  // 当 tripleNone=1 时，先不分页拉取候选任务，在内存中精确过滤后再手动分页
  if (tripleNone) {
    const allTasks = await prisma.customerOrgBindingTask.findMany({
      where,
      include: taskInclude,
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    });

    const profileIds = allTasks.map((task) => task.profileId).filter(Boolean);
    const [lifecycleMap, effectiveRepMap, orderOrgHintsMap, addressOrgHintsMap] = await Promise.all([
      getCrmLifecycleSummariesForProfiles(profileIds),
      resolveEffectiveRepresentativesForProfiles(profileIds),
      getOrderOrgHints(profileIds),
      getProfileAddressOrgHints(profileIds),
    ]);

    const enrichedTasks = allTasks.map((task) =>
      enrichTask(task, lifecycleMap, effectiveRepMap, orderOrgHintsMap, addressOrgHintsMap),
    );

    const filteredTasks = enrichedTasks.filter((t) => {
      if (!t.isTripleNone) return false;
      const profileOrg = t.profile?.organization;
      const profileRawInput = t.profile?.organizationRawInput;
      if (tripleNoneText === "has") {
        return !!(profileOrg || profileRawInput);
      }
      if (tripleNoneText === "none") {
        return !profileOrg && !profileRawInput;
      }
      return true;
    });
    const total = filteredTasks.length;
    const skip = (page - 1) * pageSize;
    const paginatedTasks = filteredTasks.slice(skip, skip + pageSize);

    return NextResponse.json({ tasks: paginatedTasks, total, page, pageSize });
  }

  const [tasks, total] = await Promise.all([
    prisma.customerOrgBindingTask.findMany({
      where,
      include: taskInclude,
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.customerOrgBindingTask.count({ where }),
  ]);

  // 聚合业务画像：订单数/金额用 lifecycle 口径；机构线索只按 profileId 读取
  const profileIds = tasks.map((task) => task.profileId).filter(Boolean);
  const [lifecycleMap, effectiveRepMap, orderOrgHintsMap, addressOrgHintsMap] = await Promise.all([
    getCrmLifecycleSummariesForProfiles(profileIds),
    resolveEffectiveRepresentativesForProfiles(profileIds),
    getOrderOrgHints(profileIds),
    getProfileAddressOrgHints(profileIds),
  ]);

  const enrichedTasks = tasks.map((task) =>
    enrichTask(task, lifecycleMap, effectiveRepMap, orderOrgHintsMap, addressOrgHintsMap),
  );

  return NextResponse.json({ tasks: enrichedTasks, total, page, pageSize });
}
