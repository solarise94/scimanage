import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canContributeProject, isRepresentative } from "@/lib/permissions";
import { StagingError } from "@/lib/staging-common";
import {
  createPrivateProjectAttachmentFromBuffer,
  extFromFileName,
} from "@/lib/projects/application/project-attachments";
import { validateAgentAttachmentPayload } from "@/lib/agent-attachments/validation";

/**
 * 项目附件上传（P0 加固）。
 *
 * 历史行为：无大小/MIME/magic 校验，直接写 public/uploads/（静态公开 URL）。
 * 现在：复用 Agent 通用附件的共享校验（白名单 + magic/MIME/扩展名一致 + 家族大小上限 +
 * OOXML 容器校验），并写入私有目录 AGENT_PROJECT_ATTACHMENT_DIR，经同源受控端点鉴权下载。
 * 历史公开 Attachment 行不迁移，继续按原 url 兼容读取；新附件不再落入 public/。
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (isRepresentative(session.user.role)) {
    return NextResponse.json({ error: "Forbidden: representatives cannot upload files" }, { status: 403 });
  }

  const { id } = await params;

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (project.deleted) return NextResponse.json({ error: "项目已删除，无法上传文件" }, { status: 400 });

  if (session.user.role !== "ADMIN") {
    const canContribute = await canContributeProject(id, session.user.id, session.user.role);
    if (!canContribute) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // 服务端最终校验：白名单 + magic/MIME/扩展名一致 + 家族大小上限 + OOXML 容器。
    const validated = validateAgentAttachmentPayload({
      originalFileName: file.name,
      declaredMime: file.type,
      buffer,
    });

    const attachment = await createPrivateProjectAttachmentFromBuffer({
      projectId: id,
      filename: validated.displayName,
      mimeType: validated.mimeType,
      size: validated.sizeBytes,
      ext: extFromFileName(file.name),
      buffer,
      source: "PROJECT_UI",
    });

    await prisma.activityLog.create({
      data: {
        type: "FILE_UPLOADED",
        content: `上传了文件 "${validated.displayName}"`,
        metadata: JSON.stringify({
          filename: validated.displayName,
          attachmentId: attachment.id,
          size: validated.sizeBytes,
          mimeType: validated.mimeType,
          private: true,
        }),
        projectId: id,
        userId: session.user.id,
      },
    });

    return NextResponse.json({ attachment }, { status: 201 });
  } catch (error) {
    if (error instanceof StagingError) {
      return NextResponse.json({ error: error.message }, { status: error.httpStatus });
    }
    console.error(error);
    return NextResponse.json({ error: "Failed to upload file" }, { status: 500 });
  }
}
