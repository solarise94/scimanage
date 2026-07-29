import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { centsToYuan, yuanToCents } from "@/lib/finance/money";
import { isCostingBlocked, getCostingScopeWhere } from "@/lib/costing/permissions";
import {
  isValidCostBucket,
  isValidCostEntryType,
  isValidCostStatus,
  isValidTaxMode,
} from "@/lib/costing/constants";
import { createManualCostEntry } from "@/lib/costing/entries";
import { toPublicOrder } from "@/lib/crm/public-dto";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isCostingBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const orderId = url.searchParams.get("orderId")?.trim() || "";
  const projectId = url.searchParams.get("projectId")?.trim() || "";
  const profileId = url.searchParams.get("profileId")?.trim() || "";
  const bucket = url.searchParams.get("bucket")?.trim() || "";
  const status = url.searchParams.get("status")?.trim() || "";
  const costType = url.searchParams.get("costType")?.trim() || "";
  const supplierId = url.searchParams.get("supplierId")?.trim() || "";
  const sourceType = url.searchParams.get("sourceType")?.trim() || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));

  const andConditions: Record<string, unknown>[] = [];

  // Scope（非 ADMIN）
  const scopeWhere = await getCostingScopeWhere(session.user.id, session.user.role, session.user.department);
  if (scopeWhere) andConditions.push(scopeWhere);

  if (orderId) andConditions.push({ orderId });
  if (projectId) andConditions.push({ projectId });
  // 旧 *CustomerId 系查询参数一律 400（键名枚举，避免在源码里引用已废弃契约）。
  const legacyKey = [...url.searchParams.keys()].find((k) => /customerids?$/i.test(k));
  if (legacyKey) {
    return NextResponse.json(
      { error: `请使用 profileId 筛选成本条目（不再接受 ${legacyKey}）` },
      { status: 400 },
    );
  }
  if (profileId) andConditions.push({ profileId });
  if (bucket) andConditions.push({ bucket });
  if (status) andConditions.push({ status });
  if (costType) andConditions.push({ costType });
  if (supplierId) andConditions.push({ supplierId });
  if (sourceType) andConditions.push({ sourceType });

  const where = andConditions.length === 1 ? andConditions[0] : { AND: andConditions };

  const [entries, total] = await Promise.all([
    prisma.costEntry.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true } },
        order: { select: { id: true, orderNo: true, title: true } },
        project: { select: { id: true, name: true } },
        profile: { select: { id: true, name: true } },
      },
      orderBy: { occurredAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.costEntry.count({ where }),
  ]);

  const entriesYuan = entries.map((e) => {
    const { amount, profile, ...rest } = toPublicOrder(e);
    const profileDto = profile
      ? { id: profile.id, name: profile.name ?? null }
      : null;
    return {
      ...rest,
      profile: profileDto,
      customer: profileDto,
      profileMissing: !e.profileId || !profile,
      amount: centsToYuan(amount),
    };
  });

  return NextResponse.json({
    entries: entriesYuan,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  // 旧 *CustomerId 系参数一律 400（键名枚举，避免在源码里引用已废弃契约）。
  const legacyKey = Object.keys(body).find((k) => /customerids?$/i.test(k));
  if (legacyKey) {
    return NextResponse.json(
      { error: `请使用 profileId 指定客户（不再接受 ${legacyKey}）` },
      { status: 400 },
    );
  }
  const {
    subjectType, orderId, projectId, profileId: bodyProfileId,
    bucket, costType, amount, status,
    supplierId, occurredAt, remark, taxMode,
  } = body as Record<string, unknown>;

  const profileId =
    typeof bodyProfileId === "string" && bodyProfileId.trim() ? bodyProfileId.trim() : null;

  if (!bucket || !isValidCostBucket(bucket as string)) {
    return NextResponse.json({ error: `无效成本桶：${bucket}` }, { status: 400 });
  }
  if (!costType || !isValidCostEntryType(costType as string)) {
    return NextResponse.json({ error: `无效成本类型：${costType}` }, { status: 400 });
  }
  if (amount == null || Number(amount) <= 0) {
    return NextResponse.json({ error: "金额必须为正数" }, { status: 400 });
  }
  if (status !== undefined && status !== null && !isValidCostStatus(status as string)) {
    return NextResponse.json({ error: `无效成本状态：${status}` }, { status: 400 });
  }
  if (taxMode !== undefined && taxMode !== null && !isValidTaxMode(taxMode as string)) {
    return NextResponse.json({ error: `无效价税模式：${taxMode}` }, { status: 400 });
  }

  try {
    const entry = await createManualCostEntry({
      subjectType: (subjectType as "ORDER" | "PROJECT" | "CUSTOMER" | "MANUAL") || "ORDER",
      orderId: (orderId as string) || null,
      projectId: (projectId as string) || null,
      profileId,
      bucket: bucket as never,
      costType: costType as never,
      amount: yuanToCents(Number(amount)),
      status: status as never | undefined,
      supplierId: (supplierId as string) || null,
      occurredAt: occurredAt ? new Date(occurredAt as string) : undefined,
      remark: (remark as string) || undefined,
      actorUserId: session.user.id,
    });

    return NextResponse.json({
      entry: (() => {
        const { amount: amountCents, ...rest } = toPublicOrder(entry);
        return {
          ...rest,
          profileId: entry.profileId,
          profileMissing: !entry.profileId,
          amount: centsToYuan(amountCents),
        };
      })(),
    }, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "创建失败";
    const isNotFound = message === "NOT_FOUND";
    return NextResponse.json({ error: message }, { status: isNotFound ? 404 : 400 });
  }
}
