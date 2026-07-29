/**
 * 项目已归档附件列表（管理者「已归档」视图）+ 迁移中间态。
 *
 * GET /api/projects/[id]/attachments/archived
 *   - 权限 canManage（ADMIN 或项目 OWNER）。
 *   - 机会式触发本项目 MIGRATING/PURGING 恢复，再返回列表。
 *   - attachments：status=READY 且 archived=true
 *   - pendingMigrations：status=MIGRATING（迁移恢复中；普通 FAILED 不混入）
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
  assertCanManageAttachment,
  listArchivedAttachments,
  listPendingMigrationAttachments,
  resumeAttachmentMaintenance,
} from "@/lib/projects/application/project-attachments";
import { ForbiddenError, NotFoundError } from "@/lib/application/errors";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  try {
    await assertCanManageAttachment({
      projectId: id,
      userId: session.user.id,
      role: session.user.role,
    });

    // 管理者打开附件管理页时续接本项目迁移/清理（不等 agent attachments）。
    await resumeAttachmentMaintenance({ projectId: id }).catch((err) => {
      console.warn("[attachments/archived] resume maintenance failed:", (err as Error).message);
    });

    const [attachments, pendingMigrations] = await Promise.all([
      listArchivedAttachments(id),
      listPendingMigrationAttachments(id),
    ]);
    return NextResponse.json({ attachments, pendingMigrations });
  } catch (err) {
    if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
    if (err instanceof NotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    console.error("list archived attachments failed:", err);
    return NextResponse.json({ error: "获取已归档附件失败" }, { status: 500 });
  }
}
