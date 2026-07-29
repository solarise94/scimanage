import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { writeAgentActionLog } from "@/lib/application/agent-action-logs";
import { ensureAgentRunBelongsToSession } from "@/lib/agent-actions/run-context";
import {
  IMPORT_KIND,
  IMPORT_STAGING_MAX_BYTES,
  createImportStagingFile,
  listOwnedImportStaging,
  recoverStaleImportStaging,
  sweepExpiredImportStaging,
  toPublicImportStagingMeta,
  type ImportKind,
  type ImportStagingStatus,
} from "@/lib/import-staging";

/**
 * GET /api/agent/import-staging
 * 列出当前用户拥有的未过期订单/流水 staging（最多 50 条）。
 * 作为副作用触发 recoverStaleImportStaging + sweepExpiredImportStaging。
 * 不返回 storageKey。
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden", code: "IMPORT_REQUEST_FORBIDDEN" }, { status: 403 });
  }

  try {
    void recoverStaleImportStaging().catch(() => undefined);
    void sweepExpiredImportStaging().catch(() => undefined);

    const agentRunId = req.nextUrl.searchParams.get("agentRunId")?.trim() || undefined;
    if (agentRunId) {
      try {
        await ensureAgentRunBelongsToSession(agentRunId, session);
      } catch {
        return NextResponse.json(
          { error: "Agent run 不可用", code: "IMPORT_STAGING_CHANGED" },
          { status: 403 },
        );
      }
    }

    const statusParam = req.nextUrl.searchParams.get("status")?.trim();
    const statuses = statusParam
      ? statusParam.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

    const rows = await listOwnedImportStaging({
      userId: session.user.id,
      agentRunId,
      status: statuses as ImportStagingStatus[] | undefined,
      limit: 50,
    });

    return NextResponse.json({
      items: rows.map((row) => ({
        ...toPublicImportStagingMeta(row),
        agentRunId: row.agentRunId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error("[import-staging] list failed:", err);
    return NextResponse.json({ error: "查询失败" }, { status: 500 });
  }
}

/**
 * POST /api/agent/import-staging
 * 多部分单文件上传 → createImportStagingFile。Phase B 仅 ADMIN。
 * 返回公开元数据（不含 storageKey）。
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden", code: "IMPORT_REQUEST_FORBIDDEN" }, { status: 403 });
  }

  try {
    void recoverStaleImportStaging().catch(() => undefined);
    void sweepExpiredImportStaging().catch(() => undefined);

    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "缺少文件", code: "STAGING_FILE_INVALID" }, { status: 400 });
    }
    // 提前按声明大小拒绝：超限文件不应先整个读进内存（arrayBuffer 全量缓冲）
    // 才被 assertFileSignature 拦截。file.size 可被客户端伪造，仅作第一道闸，
    // 服务端仍会在 assertFileSignature 按真实 buffer 长度复检。
    if (file.size > IMPORT_STAGING_MAX_BYTES) {
      return NextResponse.json(
        { error: "文件大小超过上限", code: "STAGING_FILE_INVALID" },
        { status: 400 },
      );
    }

    const agentRunIdRaw = form.get("agentRunId");
    const agentRunId =
      typeof agentRunIdRaw === "string" && agentRunIdRaw.trim()
        ? agentRunIdRaw.trim()
        : null;

    if (agentRunId) {
      try {
        await ensureAgentRunBelongsToSession(agentRunId, session);
      } catch {
        return NextResponse.json(
          { error: "Agent run 不可用或不属于当前用户", code: "IMPORT_STAGING_CHANGED" },
          { status: 403 },
        );
      }
    }

    const importKindRaw = form.get("importKind");
    const importKind: ImportKind =
      typeof importKindRaw === "string" && importKindRaw.trim() === IMPORT_KIND.BANK_FLOW
        ? IMPORT_KIND.BANK_FLOW
        : IMPORT_KIND.ORDER;

    const buffer = Buffer.from(await file.arrayBuffer());
    const staging = await createImportStagingFile({
      ownerUserId: session.user.id,
      agentRunId,
      originalName: file.name,
      declaredMime: file.type || "",
      buffer,
      importKind,
    });

    await writeAgentActionLog({
      userId: session.user.id,
      agentRunId,
      actionKey: "orders.import_staging_upload",
      riskLevel: "safe",
      status: "IMPORT_STAGING_UPLOADED",
      input: {
        stagingFileId: staging.id,
        fileName: staging.originalName,
        mimeType: staging.mimeType,
        fileSize: staging.sizeBytes,
        importKind: staging.importKind,
        sha256Prefix: staging.sha256.slice(0, 12),
        agentRunId,
      },
      target: { type: "import_staging", id: staging.id },
    });

    return NextResponse.json({ stagingFile: toPublicImportStagingMeta(staging) }, { status: 201 });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && "httpStatus" in err) {
      const e = err as { code: string; message: string; httpStatus: number };
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.httpStatus });
    }
    console.error("[import-staging] upload failed:", err);
    return NextResponse.json({ error: "上传失败" }, { status: 500 });
  }
}
