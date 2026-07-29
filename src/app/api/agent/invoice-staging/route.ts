import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { writeAgentActionLog } from "@/lib/application/agent-action-logs";
import { ensureAgentRunBelongsToSession } from "@/lib/agent-actions/run-context";
import {
  createInvoiceStagingFile,
  listOwnedInvoiceStaging,
  listPendingInvoiceRegisterProposals,
  recoverStaleAnalyzingStaging,
  sweepExpiredInvoiceStaging,
  toPublicStagingMeta,
} from "@/lib/finance/invoice-staging";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden", code: "INVOICE_REQUEST_FORBIDDEN" }, { status: 403 });
  }

  try {
    void recoverStaleAnalyzingStaging().catch(() => undefined);
    void sweepExpiredInvoiceStaging().catch(() => undefined);

    const agentRunId = req.nextUrl.searchParams.get("agentRunId")?.trim() || undefined;
    if (agentRunId) {
      try {
        await ensureAgentRunBelongsToSession(agentRunId, session);
      } catch {
        return NextResponse.json(
          { error: "Agent run 不可用", code: "INVOICE_STAGING_CHANGED" },
          { status: 403 },
        );
      }
    }

    const statusParam = req.nextUrl.searchParams.get("status")?.trim();
    const statuses = statusParam
      ? statusParam.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

    const rows = await listOwnedInvoiceStaging({
      userId: session.user.id,
      agentRunId,
      status: statuses as ("UPLOADED" | "ANALYZING" | "ANALYZED" | "REGISTERED" | "SKIPPED" | "EXPIRED")[] | undefined,
      limit: 50,
    });

    const proposalByStagingId = await listPendingInvoiceRegisterProposals({
      userId: session.user.id,
      agentRunId,
    });

    return NextResponse.json({
      items: rows.map((row) => ({
        ...toPublicStagingMeta(row),
        agentRunId: row.agentRunId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        hasExtracted: Boolean(row.extractedJson),
        pendingProposalId: proposalByStagingId.get(row.id) ?? null,
        warningCount: (() => {
          try {
            const parsed = row.ocrWarningsJson ? JSON.parse(row.ocrWarningsJson) : [];
            return Array.isArray(parsed) ? parsed.length : 0;
          } catch {
            return 0;
          }
        })(),
      })),
    });
  } catch (err) {
    console.error("[invoice-staging] list failed:", err);
    return NextResponse.json({ error: "查询失败" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden", code: "INVOICE_REQUEST_FORBIDDEN" }, { status: 403 });
  }

  try {
    void recoverStaleAnalyzingStaging().catch(() => undefined);
    void sweepExpiredInvoiceStaging().catch(() => undefined);

    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "缺少文件", code: "INVOICE_FILE_INVALID" }, { status: 400 });
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
          { error: "Agent run 不可用或不属于当前用户", code: "INVOICE_STAGING_CHANGED" },
          { status: 403 },
        );
      }
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const staging = await createInvoiceStagingFile({
      createdById: session.user.id,
      agentRunId,
      originalFileName: file.name,
      declaredMime: file.type || "",
      buffer,
    });

    await writeAgentActionLog({
      userId: session.user.id,
      agentRunId,
      actionKey: "finance.invoice_staging_upload",
      riskLevel: "safe",
      status: "INVOICE_STAGING_UPLOADED",
      input: {
        stagingFileId: staging.id,
        fileName: staging.originalFileName,
        mimeType: staging.mimeType,
        fileSize: staging.fileSize,
        sha256Prefix: staging.sha256.slice(0, 12),
        agentRunId,
      },
      target: { type: "invoice_staging", id: staging.id },
    });

    return NextResponse.json({ stagingFile: toPublicStagingMeta(staging) }, { status: 201 });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && "httpStatus" in err) {
      const e = err as { code: string; message: string; httpStatus: number };
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.httpStatus });
    }
    console.error("[invoice-staging] upload failed:", err);
    return NextResponse.json({ error: "上传失败" }, { status: 500 });
  }
}
