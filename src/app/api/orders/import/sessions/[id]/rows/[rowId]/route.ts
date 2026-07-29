import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { NormalizedOrderRow } from "@/lib/external-order";
import { findActiveProfile } from "@/lib/crm/ids";
import {
  createMatchContext,
  resolveRowAgainstContext,
  reviewStatusFromResolution,
  DECISION_TYPE,
  ROW_STATUS,
  SESSION_TERMINAL_STATUSES,
  type DecisionType,
} from "@/lib/orders/import-session";

/**
 * PATCH /api/orders/import/sessions/[id]/rows/[rowId]
 *
 * 持久化行级确认决策（§7.3 / §9.5）。三种 decisionType：
 *  - USE_SUGGESTION：采纳自动建议 → confirmedProfileId = suggestedProfileId，CONFIRMED_EXISTING
 *  - PICK_EXISTING：人工挑选现有客户 → confirmedProfileId（body.profileId）
 *  - CREATE_NEW：标记新建 → 持久化 createCustomerDraftJson，CONFIRMED_CREATE（commit 时才真正建客户）
 *
 * 另支持 decisionType=null / "RESET"：清空决策并对该行就地 recompute（回到未确认三态）。
 * commit 永不信任前端 representativeId（§9.4），故此处只写客户决策，不接受任何代表字段。
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; rowId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id, rowId } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "无效请求体" }, { status: 400 });

  // Profile-only DTO：旧 *CustomerId 系参数一律 400（Phase E 删列后随旧列一起移除）。
  // 用键名枚举而非硬编码字段名，避免在源码里引用已废弃契约。
  const legacyKey = Object.keys(body).find((k) => /customerids?$/i.test(k));
  if (legacyKey) {
    return NextResponse.json(
      { error: `请使用 confirmedProfileId / profileId 指定客户（不再接受 ${legacyKey}）` },
      { status: 400 },
    );
  }

  const sess = await prisma.orderImportSession.findUnique({ where: { id }, select: { status: true } });
  if (!sess) return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  if (SESSION_TERMINAL_STATUSES.includes(sess.status as never)) {
    return NextResponse.json({ error: `会话已是终态（${sess.status}），不能修改` }, { status: 409 });
  }

  const row = await prisma.orderImportRow.findUnique({
    where: { id: rowId },
    select: {
      id: true,
      sessionId: true,
      reviewStatus: true,
      suggestedProfileId: true,
      normalizedPayloadJson: true,
    },
  });
  if (!row || row.sessionId !== id) return NextResponse.json({ error: "行不存在" }, { status: 404 });

  if (row.reviewStatus === ROW_STATUS.IMPORTED) {
    return NextResponse.json({ error: "该行已导入，不能修改" }, { status: 409 });
  }

  const rawDecision = (body.decisionType as string | null | undefined) ?? null;

  // ── RESET：清空决策，就地 recompute 回三态 ──
  if (rawDecision === null || rawDecision === "RESET") {
    let nextStatus: string = ROW_STATUS.NO_MATCH;
    let suggestedProfileId: string | null = null;
    let suggestedScore: number | null = null;
    let suggestedReason: string | null = null;
    if (row.reviewStatus !== ROW_STATUS.PARSE_FAILED) {
      try {
        const ctx = await createMatchContext();
        const parsed = JSON.parse(row.normalizedPayloadJson) as NormalizedOrderRow;
        const resolution = resolveRowAgainstContext(ctx, parsed);
        nextStatus = reviewStatusFromResolution(resolution);
        suggestedProfileId = resolution.status === "AUTO_SUGGESTED" ? resolution.suggestedProfileId : null;
        suggestedScore = resolution.best?.score ?? null;
        suggestedReason = resolution.best?.reason ?? null;
      } catch {
        nextStatus = ROW_STATUS.NO_MATCH;
      }
    } else {
      nextStatus = ROW_STATUS.PARSE_FAILED;
    }
    const updated = await prisma.orderImportRow.update({
      where: { id: rowId },
      data: {
        decisionType: null,
        confirmedProfileId: null,
        createCustomerDraftJson: null,
        reviewStatus: nextStatus,
        suggestedProfileId,
        suggestedScore,
        suggestedReason,
      },
      select: { id: true, reviewStatus: true },
    });
    return NextResponse.json({ ok: true, row: updated });
  }

  const decisionType = rawDecision as DecisionType;
  if (!Object.values(DECISION_TYPE).includes(decisionType)) {
    return NextResponse.json({ error: `无效 decisionType：${rawDecision}` }, { status: 400 });
  }
  if (row.reviewStatus === ROW_STATUS.PARSE_FAILED) {
    return NextResponse.json({ error: "解析失败行不能确认，请剔除该行" }, { status: 409 });
  }

  if (decisionType === DECISION_TYPE.USE_SUGGESTION) {
    const suggestedProfileId = row.suggestedProfileId;
    if (!suggestedProfileId) {
      return NextResponse.json({ error: "该行没有可采纳的自动建议（缺少 suggestedProfileId）" }, { status: 409 });
    }
    const ref = await findActiveProfile(suggestedProfileId, prisma);
    if (!ref) return NextResponse.json({ error: "建议客户不存在或已删除/归档" }, { status: 422 });
    const updated = await prisma.orderImportRow.update({
      where: { id: rowId },
      data: {
        decisionType,
        confirmedProfileId: ref.profileId,
        createCustomerDraftJson: null,
        reviewStatus: ROW_STATUS.CONFIRMED_EXISTING,
      },
      select: { id: true, reviewStatus: true, confirmedProfileId: true },
    });
    return NextResponse.json({ ok: true, row: updated });
  }

  if (decisionType === DECISION_TYPE.PICK_EXISTING) {
    const rawId =
      (body.confirmedProfileId as string | undefined)?.trim() ||
      (body.profileId as string | undefined)?.trim();
    if (!rawId) {
      return NextResponse.json({ error: "缺少 confirmedProfileId / profileId" }, { status: 400 });
    }
    const ref = await findActiveProfile(rawId, prisma);
    if (!ref) return NextResponse.json({ error: "客户不存在或已删除/归档" }, { status: 422 });
    const updated = await prisma.orderImportRow.update({
      where: { id: rowId },
      data: {
        decisionType,
        confirmedProfileId: ref.profileId,
        createCustomerDraftJson: null,
        reviewStatus: ROW_STATUS.CONFIRMED_EXISTING,
      },
      select: { id: true, reviewStatus: true, confirmedProfileId: true },
    });
    return NextResponse.json({ ok: true, row: updated });
  }

  // CREATE_NEW
  const draft = body.createCustomerDraft as Record<string, unknown> | undefined;
  const draftName = (draft?.name as string | undefined)?.trim();
  if (!draft || !draftName) {
    return NextResponse.json({ error: "新建客户需要至少填写客户名（createCustomerDraft.name）" }, { status: 400 });
  }
  const draftOrgId = (draft.organizationId as string | undefined)?.trim();
  const draftOrgName = (draft.organizationName as string | undefined)?.trim();
  if (!draftOrgId && !draftOrgName) {
    return NextResponse.json({ error: "新建客户必须指定机构（organizationId 或 organizationName）" }, { status: 400 });
  }
  const normalizedDraft = {
    name: draftName,
    phone: (draft.phone as string | undefined)?.trim() || null,
    wechat: (draft.wechat as string | undefined)?.trim() || null,
    miniProgramId: (draft.miniProgramId as string | undefined)?.trim() || null,
    address: (draft.address as string | undefined)?.trim() || null,
    organizationId: draftOrgId || null,
    organizationName: draftOrgName || null,
    organizationSiteId: (draft.organizationSiteId as string | undefined)?.trim() || null,
  };
  const updated = await prisma.orderImportRow.update({
    where: { id: rowId },
    data: {
      decisionType,
      confirmedProfileId: null,
      createCustomerDraftJson: JSON.stringify(normalizedDraft),
      reviewStatus: ROW_STATUS.CONFIRMED_CREATE,
    },
    select: { id: true, reviewStatus: true },
  });
  return NextResponse.json({ ok: true, row: updated });
}
