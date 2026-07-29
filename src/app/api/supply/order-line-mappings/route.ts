import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isSupplyChainBlocked, assertOrderVisibleForSupplyChain } from "@/lib/supply-chain/permissions";
import { MAPPING_SOURCE } from "@/lib/supply-chain/constants";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isSupplyChainBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const orderId = url.searchParams.get("orderId")?.trim() || "";

  if (!orderId) {
    return NextResponse.json({ error: "orderId 必填" }, { status: 400 });
  }

  // 订单 scope 校验
  const visible = await assertOrderVisibleForSupplyChain(session.user.id, session.user.role, orderId, session.user.department);
  if (!visible) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // 并行查全部订单行和已存在的映射，前端按 orderLineId 做 left join。
  // 如果只返回 mappings，订单首次配置时列表为空，没有任何行可选服务项。
  const [orderLines, mappings] = await Promise.all([
    prisma.orderLine.findMany({
      where: { orderId },
      select: { id: true, itemName: true, spec: true, quantity: true, unitPrice: true },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.orderLineServiceMapping.findMany({
      where: { orderLine: { orderId } },
      include: {
        orderLine: { select: { id: true, itemName: true, spec: true } },
      },
    }),
  ]);

  return NextResponse.json({ orderLines, mappings });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isSupplyChainBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { orderLineId, serviceKey, confidence, source, matchedText, note } = body as Record<string, unknown>;

  if (!orderLineId) return NextResponse.json({ error: "orderLineId 必填" }, { status: 400 });
  if (!serviceKey) return NextResponse.json({ error: "serviceKey 必填" }, { status: 400 });

  const orderLine = await prisma.orderLine.findUnique({
    where: { id: orderLineId as string },
    select: { id: true, orderId: true },
  });
  if (!orderLine) return NextResponse.json({ error: "订单行不存在" }, { status: 400 });

  // 从 orderLineId 反查订单 → 订单 scope 校验
  const visible = await assertOrderVisibleForSupplyChain(
    session.user.id,
    session.user.role,
    orderLine.orderId,
    session.user.department,
  );
  if (!visible) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const service = await prisma.serviceCatalog.findUnique({ where: { serviceKey: serviceKey as string } });
  if (!service) return NextResponse.json({ error: `服务项 ${serviceKey} 不存在` }, { status: 400 });
  // 新建/修改映射不允许使用已停用的服务项。历史映射可以继续展示停用项，
  // 但 Select 只提供 active 项，API 层也拒绝直接调用绑定停用项。
  if (!service.active) {
    return NextResponse.json({ error: `服务项 ${serviceKey} 已停用，不能建立新映射` }, { status: 400 });
  }

  // orderLineId @unique → upsert
  const mapping = await prisma.orderLineServiceMapping.upsert({
    where: { orderLineId: orderLineId as string },
    update: {
      serviceKey: serviceKey as string,
      confidence: confidence != null ? Number(confidence) : null,
      source: (source as string) || MAPPING_SOURCE.MANUAL,
      matchedText: (matchedText as string) || null,
      note: (note as string) || null,
      confirmedById: session.user.id,
      confirmedAt: new Date(),
    },
    create: {
      orderLineId: orderLineId as string,
      serviceKey: serviceKey as string,
      confidence: confidence != null ? Number(confidence) : null,
      source: (source as string) || MAPPING_SOURCE.MANUAL,
      matchedText: (matchedText as string) || null,
      note: (note as string) || null,
      confirmedById: session.user.id,
      confirmedAt: new Date(),
    },
  });

  return NextResponse.json({ mapping }, { status: 201 });
}
