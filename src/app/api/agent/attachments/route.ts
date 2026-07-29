import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { writeAgentActionLog } from "@/lib/application/agent-action-logs";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";
import { ensureAgentRunBelongsToSession } from "@/lib/agent-actions/run-context";
import { StagingError } from "@/lib/staging-common";
import {
  createAgentAttachmentStaging,
  listOwnedAgentAttachments,
  recoverStaleAnalyzingAttachments,
  sweepExpiredAgentAttachments,
  toPublicAttachmentMeta,
} from "@/lib/agent-attachments/staging";
import { resumePendingAgentAttachmentRoutes, resumePendingInvoiceRoutes } from "@/lib/agent-attachments/routes";
import { resumePendingPrivateAttachments, resumeAttachmentMaintenance } from "@/lib/projects/application/project-attachments";
import { cleanOrphanProjectTmpFiles } from "@/lib/agent-attachments/storage";

function mapStagingError(err: unknown) {
  if (err instanceof StagingError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.httpStatus });
  }
  console.error("[agent-attachments] failed:", err);
  return NextResponse.json({ error: "操作失败" }, { status: 500 });
}

/** 列出当前用户未过期的通用附件（可按 run/session 过滤）。 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const denied = requireAgentAccess(session);
  if (denied) return denied;

  try {
    void recoverStaleAnalyzingAttachments().catch(() => undefined);
    void sweepExpiredAgentAttachments().catch(() => undefined);
    // 崩溃恢复（docs §6.3.3）：续接 PROCESSING 提升任务、孤儿 .tmp 清理。机会式触发。
    void resumePendingAgentAttachmentRoutes().catch(() => undefined);
    // P1#4: 发票采纳崩溃恢复（staging 建后 promote 前崩溃 → 复用，不建第二个）。
    void resumePendingInvoiceRoutes().catch(() => undefined);
    void resumePendingPrivateAttachments().catch(() => undefined);
    // MIGRATING / PURGING 崩溃恢复（全局机会式；项目页 archived GET 与 reminder 也会触发）。
    void resumeAttachmentMaintenance().catch(() => undefined);
    void cleanOrphanProjectTmpFiles().catch(() => undefined);

    const agentRunId = req.nextUrl.searchParams.get("agentRunId")?.trim() || undefined;
    const chatSessionId = req.nextUrl.searchParams.get("chatSessionId")?.trim() || undefined;

    if (agentRunId) {
      try {
        await ensureAgentRunBelongsToSession(agentRunId, session!);
      } catch {
        return NextResponse.json({ error: "Agent run 不可用", code: "ATTACHMENT_CHANGED" }, { status: 403 });
      }
    }

    const rows = await listOwnedAgentAttachments({
      userId: session!.user.id,
      agentRunId,
      chatSessionId,
      limit: 50,
    });

    return NextResponse.json({
      items: rows.map((row) => ({
        ...toPublicAttachmentMeta(row),
        agentRunId: row.agentRunId,
        chatSessionId: row.chatSessionId,
        createdAt: row.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return mapStagingError(err);
  }
}

/** 单文件 multipart 上传到私有通用 staging；不写任何业务数据。 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const denied = requireAgentAccess(session);
  if (denied) return denied;

  try {
    void recoverStaleAnalyzingAttachments().catch(() => undefined);
    void sweepExpiredAgentAttachments().catch(() => undefined);

    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "缺少文件", code: "ATTACHMENT_FILE_INVALID" }, { status: 400 });
    }

    const agentRunIdRaw = form.get("agentRunId");
    const agentRunId = typeof agentRunIdRaw === "string" && agentRunIdRaw.trim() ? agentRunIdRaw.trim() : null;
    const chatSessionIdRaw = form.get("chatSessionId");
    const chatSessionId = typeof chatSessionIdRaw === "string" && chatSessionIdRaw.trim() ? chatSessionIdRaw.trim() : null;

    if (agentRunId) {
      try {
        await ensureAgentRunBelongsToSession(agentRunId, session!);
      } catch {
        return NextResponse.json({ error: "Agent run 不可用或不属于当前用户", code: "ATTACHMENT_CHANGED" }, { status: 403 });
      }
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const staging = await createAgentAttachmentStaging({
      ownerUserId: session!.user.id,
      agentRunId,
      chatSessionId,
      originalFileName: file.name,
      declaredMime: file.type || "",
      buffer,
    });

    await writeAgentActionLog({
      userId: session!.user.id,
      agentRunId,
      actionKey: "agent.attachment_upload",
      riskLevel: "safe",
      status: "ATTACHMENT_UPLOADED",
      input: {
        stagingFileId: staging.id,
        fileName: staging.originalName,
        mimeType: staging.mimeType,
        fileSize: staging.sizeBytes,
        sha256Prefix: staging.sha256.slice(0, 12),
        agentRunId,
        chatSessionId,
      },
      target: { type: "agent_attachment_staging", id: staging.id },
    });

    return NextResponse.json({ stagingFile: toPublicAttachmentMeta(staging) }, { status: 201 });
  } catch (err) {
    return mapStagingError(err);
  }
}
