import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertCrmProfileAccess } from "@/lib/crm/permissions";
import { COMPLAINT_EVENT_TYPE } from "@/lib/crm/constants";
import { addComplaintEvent } from "@/lib/crm/complaints";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ complaintId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { complaintId } = await params;

  const existing = await prisma.crmComplaint.findUnique({
    where: { id: complaintId },
    select: { id: true, profileId: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    await assertCrmProfileAccess(existing.profileId, session.user.id, session.user.role);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "NOT_FOUND") return NextResponse.json({ error: "Profile not found" }, { status: 404 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { eventType, content } = body;

  if (!eventType || !COMPLAINT_EVENT_TYPE.includes(eventType)) {
    return NextResponse.json({ error: `无效的 eventType` }, { status: 400 });
  }
  // 状态变化类事件必须走受控路径（resolve/close/reopen），通用事件接口不接受 toStatus。
  const STATUS_CHANGE_EVENTS = ["STATUS_CHANGED", "RESOLVED", "REOPENED", "CLOSED"];
  if (STATUS_CHANGE_EVENTS.includes(eventType)) {
    return NextResponse.json(
      { error: "状态变化请使用 解决/关闭/重新打开 专用操作" },
      { status: 400 },
    );
  }

  try {
    const result = await addComplaintEvent({
      complaintId,
      actorUserId: session.user.id,
      eventType,
      content: content?.trim() || undefined,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "NOT_FOUND") return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ error: "添加处理记录失败" }, { status: 500 });
  }
}
