/**
 * 项目附件归档（软删）与永久删除。
 *
 * 瘦 handler：只做鉴权 + 参数解析，核心逻辑在 canonical service
 * （src/lib/projects/application/project-attachments.ts），便于真实路由测试覆盖。
 *
 * PATCH  /api/projects/[id]/attachments/[attachmentId]
 *   body: { archived: boolean }
 *   - 权限 canManage（ADMIN 或项目 OWNER）。
 *   - 软删：archived=true 后从列表/时间线/计数/下载隐藏；DB 行与文件保留，可恢复。
 *
 * DELETE /api/projects/[id]/attachments/[attachmentId]?force=true
 *   - 权限：仅 ADMIN。
 *   - 两阶段保护：附件必须已归档（archived=true）才能永久删除。
 *   - 备注引用：未 force 时 409 + 受影响备注列表；force=true 级联删引用（备注文本保留）。
 *   - 历史 public 附件先迁移到私有存储，再走 PURGING 状态机统一删除（避免假删除）。
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
  assertCanManageAttachment,
  setAttachmentArchived,
  permanentlyDeleteAttachment,
} from "@/lib/projects/application/project-attachments";
import { ForbiddenError, NotFoundError, ValidationError, ConflictError } from "@/lib/application/errors";

function mapDomainErrorToHttp(err: unknown): NextResponse {
  if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
  if (err instanceof NotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
  if (err instanceof ValidationError) return NextResponse.json({ error: err.message }, { status: 400 });
  if (err instanceof ConflictError) {
    const payload: Record<string, unknown> = { error: err.message };
    const ext = err as Error & { code?: string; referencingNotes?: unknown[] };
    if (ext.code) payload.code = ext.code;
    if (ext.referencingNotes) payload.referencingNotes = ext.referencingNotes;
    return NextResponse.json(payload, { status: 409 });
  }
  console.error("attachment archive/delete failed:", err);
  return NextResponse.json({ error: "操作失败" }, { status: 500 });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, attachmentId } = await params;

  try {
    await assertCanManageAttachment({
      projectId: id,
      userId: session.user.id,
      role: session.user.role,
    });

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Request body must be an object" }, { status: 400 });
    }
    if (typeof body.archived !== "boolean") {
      return NextResponse.json({ error: "archived (boolean) is required" }, { status: 400 });
    }

    const attachment = await setAttachmentArchived({
      projectId: id,
      attachmentId,
      archived: body.archived,
      actorUserId: session.user.id,
      actorRole: session.user.role,
    });
    return NextResponse.json({ ok: true, attachment });
  } catch (err) {
    return mapDomainErrorToHttp(err);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, attachmentId } = await params;
  const force = req.nextUrl.searchParams.get("force") === "true";

  try {
    // 永久删除：仅 ADMIN（两阶段保护的第一道闸）。
    await assertCanManageAttachment({
      projectId: id,
      userId: session.user.id,
      role: session.user.role,
      requireAdmin: true,
    });

    await permanentlyDeleteAttachment({
      projectId: id,
      attachmentId,
      actorUserId: session.user.id,
      actorRole: session.user.role,
      force,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return mapDomainErrorToHttp(err);
  }
}
