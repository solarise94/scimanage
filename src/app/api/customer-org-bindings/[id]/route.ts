import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { executeCustomerOrgBinding } from "@/lib/crm/customer-org-binding";

async function assertAdmin(session: { user: { id: string; role: string } } | null) {
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!user || user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return null;
}

// 需求 1 · 单条预览
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const forbidden = await assertAdmin(session);
  if (forbidden) return forbidden;

  const { id } = await params;
  const task = await prisma.customerOrgBindingTask.findUnique({
    where: { id },
    include: {
      profile: {
        select: {
          id: true,
          name: true, customerCode: true,
          principal: true, email: true, wechat: true, phone: true,
          organization: true, organizationRawInput: true, labOrGroup: true,
          organizationId: true, organizationSiteId: true,
        },
      },
      suggestedOrg: { select: { id: true, canonicalName: true, orgCode: true, isInvoiceSubject: true, archived: true } },
      suggestedSite: { select: { id: true, siteName: true } },
      resolvedOrg: { select: { id: true, canonicalName: true, orgCode: true } },
      resolvedSite: { select: { id: true, siteName: true } },
      resolvedBy: { select: { id: true, name: true } },
      scannedBy: { select: { id: true, name: true } },
    },
  });
  if (!task) return NextResponse.json({ error: "任务不存在" }, { status: 404 });

  // Phase E contract：Profile-only，与列表 API 契约一致
  return NextResponse.json({
    task: {
      ...task,
      profileId: task.profileId,
    },
  });
}

// 需求 1 · 处理单条：action = bind | ignore | reopen | reset
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const forbidden = await assertAdmin(session);
  if (forbidden) return forbidden;

  const { id } = await params;
  const userId = session!.user.id;

  const body = await req.json().catch(() => ({}));
  const action: string = body?.action;
  const note: string | null = typeof body?.note === "string" ? body.note.trim() || null : null;

  const task = await prisma.customerOrgBindingTask.findUnique({
    where: { id },
    select: { id: true, profileId: true },
  });
  if (!task) return NextResponse.json({ error: "任务不存在" }, { status: 404 });

  // ── action = ignore ──────────────────────────────────────────────────────
  if (action === "ignore") {
    const res = await prisma.customerOrgBindingTask.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "IGNORED", resolutionNote: note, resolvedById: userId, resolvedAt: new Date() },
    });
    if (res.count !== 1) return NextResponse.json({ error: "任务状态已变更" }, { status: 409 });
    return NextResponse.json({ ok: true });
  }

  // ── action = reopen ──────────────────────────────────────────────────────
  if (action === "reopen") {
    const res = await prisma.customerOrgBindingTask.updateMany({
      where: { id, status: "IGNORED" },
      data: { status: "PENDING", resolvedAt: null, resolvedById: null },
    });
    if (res.count !== 1) return NextResponse.json({ error: "任务状态已变更" }, { status: 409 });
    return NextResponse.json({ ok: true });
  }

  // ── action = reset（兜底卡住 >5min 的 stale PROCESSING）──────────────────────
  if (action === "reset") {
    const res = await prisma.customerOrgBindingTask.updateMany({
      where: { id, status: "PROCESSING", updatedAt: { lt: new Date(Date.now() - 5 * 60 * 1000) } },
      data: { status: "PENDING" },
    });
    if (res.count !== 1) return NextResponse.json({ error: "任务不在 PROCESSING 或尚未超时" }, { status: 409 });
    return NextResponse.json({ ok: true });
  }

  // ── action = bind ────────────────────────────────────────────────────────
  if (action === "bind") {
    const organizationId: string | null = body?.organizationId || null;
    const siteId: string | null = body?.siteId || null;
    if (!task.profileId) {
      return NextResponse.json(
        { error: "任务缺少 profileId，请重跑机构绑定扫描" },
        { status: 422 },
      );
    }

    const outcome = await executeCustomerOrgBinding(
      id,
      task.profileId,
      organizationId || "",
      siteId,
      userId,
      note,
    );

    if (outcome.success) {
      return NextResponse.json({ ok: true, profileId: outcome.profileId });
    }
    return NextResponse.json({ error: outcome.message }, { status: outcome.status });
  }

  return NextResponse.json({ error: "不支持的操作" }, { status: 400 });
}
