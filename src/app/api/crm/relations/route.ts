import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { SYMMETRIC_RELATION_TYPES } from "@/lib/crm/constants";
import {
  isRepresentativeRole,
  isRegionalManagerRole,
  getEffectiveCrmVisibleProfileIds,
} from "@/lib/crm/permissions";
import { findActiveProfile } from "@/lib/crm/ids";
import { getCustomerOrganizationName } from "@/lib/customer-organization";
import { toPublicRelation } from "@/lib/crm/public-dto";

const profileSelect = {
  id: true,
  name: true,
  customerCode: true,
  organization: true,
  org: { select: { canonicalName: true } },
};

type RelationProfileRow = {
  id: string;
  name: string | null;
  customerCode: string | null;
  organization: string | null;
  org: { canonicalName: string } | null;
};

/** Profile 投影：端点 id 始终为 profileId，保证详情深链与缓存键一致。 */
function projectRelationEndpoint(profile: RelationProfileRow | null) {
  if (profile) {
    return {
      id: profile.id,
      name: profile.name,
      customerCode: profile.customerCode,
      organization: getCustomerOrganizationName({
        organization: profile.organization,
        org: profile.org,
      }),
    };
  }
  return null;
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const profileId = searchParams.get("profileId");
  const type = searchParams.get("type");
  const search = searchParams.get("search");

  // 旧 *CustomerId 系筛选参数一律 400（键名枚举，避免在源码里引用已废弃契约）。
  const legacyParam = [...searchParams.keys()].find((k) => /customerids?$/i.test(k));
  if (legacyParam) {
    return NextResponse.json(
      { error: `请使用 profileId 筛选客户关系（不再接受 ${legacyParam}）` },
      { status: 400 },
    );
  }

  const where: Record<string, unknown> = {};
  const visibleProfileIds = await getEffectiveCrmVisibleProfileIds(
    session.user.id,
    session.user.role,
  );

  if (visibleProfileIds !== null) {
    const ids = [...visibleProfileIds];
    if (ids.length === 0) {
      return NextResponse.json({ relations: [] });
    }
    where.OR = [
      { fromProfileId: { in: ids } },
      { toProfileId: { in: ids } },
    ];
  }

  if (profileId) {
    const ref = await findActiveProfile(profileId, prisma);
    if (!ref) {
      return NextResponse.json({ error: "客户档案不存在" }, { status: 404 });
    }
    const profileFilter = [{ fromProfileId: ref.profileId }, { toProfileId: ref.profileId }];
    if (where.OR) {
      where.AND = [{ OR: where.OR }, { OR: profileFilter }];
      delete where.OR;
    } else {
      where.OR = profileFilter;
    }
  }
  if (type) where.type = type;
  if (search) {
    const profileSearch = {
      OR: [
        { name: { contains: search } },
        { customerCode: { contains: search } },
        { organization: { contains: search } },
        { org: { canonicalName: { contains: search } } },
        { nameAliases: { some: { alias: { contains: search }, active: true } } },
      ],
    };
    const sf = {
      OR: [
        { fromProfile: profileSearch },
        { toProfile: profileSearch },
      ],
    };
    if (where.AND) {
      (where.AND as unknown[]).push(sf);
    } else if (where.OR) {
      where.AND = [{ OR: where.OR }, sf];
      delete where.OR;
    } else {
      where.AND = [sf];
    }
  }

  const relations = await prisma.customerRelation.findMany({
    where,
    include: {
      fromProfile: { select: profileSelect },
      toProfile: { select: profileSelect },
      createdByUser: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const enrichedRelations = relations.map((r) => {
    const fromVisible =
      visibleProfileIds === null ||
      (r.fromProfileId != null && visibleProfileIds.has(r.fromProfileId));
    const toVisible =
      visibleProfileIds === null ||
      (r.toProfileId != null && visibleProfileIds.has(r.toProfileId));
    return toPublicRelation({
      ...r,
      fromCustomer: projectRelationEndpoint(r.fromProfile),
      toCustomer: projectRelationEndpoint(r.toProfile),
      fromHasCrm: !!r.fromProfileId && fromVisible,
      toHasCrm: !!r.toProfileId && toVisible,
    });
  });

  return NextResponse.json({ relations: enrichedRelations });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  // 旧 *CustomerId 系参数一律 400（键名枚举，避免在源码里引用已废弃契约）。
  const legacyKey = Object.keys(body as Record<string, unknown>).find((k) => /customerids?$/i.test(k));
  if (legacyKey) {
    return NextResponse.json(
      { error: `请使用 fromProfileId / toProfileId 创建客户关系（不再接受 ${legacyKey}）` },
      { status: 400 },
    );
  }
  const {
    fromProfileId: bodyFromProfileId,
    toProfileId: bodyToProfileId,
    type,
    strength,
    notes,
    introducedAt,
  } = body;

  if (!bodyFromProfileId || !bodyToProfileId || !type) {
    return NextResponse.json({ error: "fromProfileId, toProfileId, and type are required" }, { status: 400 });
  }

  if (bodyFromProfileId === bodyToProfileId) {
    return NextResponse.json({ error: "Cannot create a relation to the same customer" }, { status: 400 });
  }

  const { assertCrmProfileAccess } = await import("@/lib/crm/permissions");

  const [fromRef, toRef] = await Promise.all([
    findActiveProfile(bodyFromProfileId, prisma),
    findActiveProfile(bodyToProfileId, prisma),
  ]);
  if (!fromRef || !toRef) {
    return NextResponse.json({ error: "One or both customers not found" }, { status: 404 });
  }
  if (fromRef.profileId === toRef.profileId) {
    return NextResponse.json({ error: "Cannot create a relation to the same customer" }, { status: 400 });
  }

  if (isRepresentativeRole(session.user.role) || isRegionalManagerRole(session.user.role)) {
    try {
      await assertCrmProfileAccess(fromRef.profileId, session.user.id, session.user.role);
      await assertCrmProfileAccess(toRef.profileId, session.user.id, session.user.role);
    } catch {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  let fromProfileId = fromRef.profileId;
  let toProfileId = toRef.profileId;
  if (SYMMETRIC_RELATION_TYPES.has(type) && fromProfileId > toProfileId) {
    [fromProfileId, toProfileId] = [toProfileId, fromProfileId];
  }

  const existing = await prisma.customerRelation.findUnique({
    where: {
      fromProfileId_toProfileId_type: {
        fromProfileId,
        toProfileId,
        type,
      },
    },
  });
  if (existing) {
    return NextResponse.json({ error: "This relation already exists" }, { status: 409 });
  }

  const relation = await prisma.customerRelation.create({
    data: {
      fromProfileId,
      toProfileId,
      type,
      strength: strength || null,
      notes: notes || null,
      introducedAt: introducedAt ? new Date(introducedAt) : null,
      createdByUserId: session.user.id,
    },
    include: {
      fromProfile: { select: profileSelect },
      toProfile: { select: profileSelect },
      createdByUser: { select: { id: true, name: true } },
    },
  });

  return NextResponse.json(
    {
      relation: toPublicRelation({
        ...relation,
        fromCustomer: projectRelationEndpoint(relation.fromProfile),
        toCustomer: projectRelationEndpoint(relation.toProfile),
      } as unknown as Record<string, unknown>),
    },
    { status: 201 },
  );
}
