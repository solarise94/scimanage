import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { writeAgentActionLog } from "@/lib/application/agent-action-logs";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";
import { StagingError } from "@/lib/staging-common";
import { deleteOwnedAgentAttachment } from "@/lib/agent-attachments/staging";

/** 删除未被 PROCESSING/PROMOTED/PENDING route 占用的通用附件 staging。 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const denied = requireAgentAccess(session);
  if (denied) return denied;

  const { id } = await params;
  try {
    const result = await deleteOwnedAgentAttachment({ stagingId: id, userId: session!.user.id });
    if (!result.deleted) {
      return NextResponse.json(
        { error: "附件正在被业务路由占用，无法删除", code: "ATTACHMENT_BUSY" },
        { status: 409 },
      );
    }

    await writeAgentActionLog({
      userId: session!.user.id,
      actionKey: "agent.attachment_delete",
      riskLevel: "safe",
      status: "ATTACHMENT_DELETED",
      input: { stagingFileId: id },
      target: { type: "agent_attachment_staging", id },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof StagingError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.httpStatus });
    }
    console.error("[agent-attachments] delete failed:", err);
    return NextResponse.json({ error: "删除失败" }, { status: 500 });
  }
}
