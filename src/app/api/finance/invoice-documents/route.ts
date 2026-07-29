import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { prisma } from "@/lib/prisma";
import { isFinanceBlocked, getFinanceProfileScopeWhere, getFinanceProjectScopeWhere } from "@/lib/finance/permissions";
import { assertOrderInvoiceReadable } from "@/lib/finance/order-invoice-access";
import {
  createInvoiceStagingFile,
  PAGE_INVOICE_UPLOAD_EXTENSIONS,
  PAGE_INVOICE_UPLOAD_MIME,
  sweepExpiredInvoiceStaging,
} from "@/lib/finance/invoice-staging";
import {
  mapRegisterIssuedInvoiceError,
} from "@/lib/finance/register-issued-invoice";
import {
  registerIssuedInvoiceForActor,
  WEB_REGISTER_ISSUED_INVOICE_POLICY,
} from "@/lib/finance/application/register-issued-invoice";

async function checkInvoiceAccess(
  userId: string,
  role: string,
  department: string,
  projectInvoiceId: string | null,
  externalOrderInvoiceRequestId: string | null,
): Promise<boolean> {
  if (role === "ADMIN") return true;

  const [custScope, projScope] = await Promise.all([
    getFinanceProfileScopeWhere(userId, role),
    getFinanceProjectScopeWhere(userId, role),
  ]);

  if (projectInvoiceId) {
    const inv = await prisma.projectInvoice.findUnique({
      where: { id: projectInvoiceId },
      select: { project: { select: { profileId: true, id: true } } },
    });
    if (!inv) return false;
    if (projScope && !projScope.id.in.includes(inv.project.id)) return false;
    if (custScope && inv.project.profileId && !custScope.id.in.includes(inv.project.profileId)) return false;
    return true;
  }

  if (externalOrderInvoiceRequestId) {
    try {
      await assertOrderInvoiceReadable(externalOrderInvoiceRequestId, userId, role, department);
      return true;
    } catch (err) {
      if (err && typeof err === "object" && "status" in err && (err as { status?: number }).status === 403) {
        return false;
      }
      console.error("[invoice-documents] checkInvoiceAccess unexpected error:", err);
      return false;
    }
  }

  return false;
}

export async function GET(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (isFinanceBlocked(session.user.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = req.nextUrl;
  const projectInvoiceId = searchParams.get("projectInvoiceId");
  const externalOrderInvoiceRequestId = searchParams.get("externalOrderInvoiceRequestId");

  if (!projectInvoiceId && !externalOrderInvoiceRequestId) {
    return NextResponse.json({ error: "必须指定 projectInvoiceId 或 externalOrderInvoiceRequestId" }, { status: 400 });
  }

  const hasAccess = await checkInvoiceAccess(
    session.user.id, session.user.role, session.user.department, projectInvoiceId, externalOrderInvoiceRequestId,
  );
  if (!hasAccess) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const where: Record<string, unknown> = {};
  if (projectInvoiceId) where.projectInvoiceId = projectInvoiceId;
  if (externalOrderInvoiceRequestId) where.externalOrderInvoiceRequestId = externalOrderInvoiceRequestId;

  const documents = await prisma.invoiceDocument.findMany({
    where,
    include: { uploadedBy: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ documents });
}

export async function POST(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (session.user.role !== "ADMIN" && session.user.role !== "USER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const form = await req.formData();
  const file = form.get("file") as File | null;
  const projectInvoiceId = (form.get("projectInvoiceId") as string)?.trim() || null;
  const externalOrderInvoiceRequestId = (form.get("externalOrderInvoiceRequestId") as string)?.trim() || null;
  const actualInvoiceNo = (form.get("actualInvoiceNo") as string)?.trim() || null;
  const actualIssuedAt = (form.get("actualIssuedAt") as string)?.trim() || null;

  if (!file) return NextResponse.json({ error: "缺少文件" }, { status: 400 });
  if (projectInvoiceId) {
    return NextResponse.json({ error: "项目发票已停用上传，请使用订单发票" }, { status: 410 });
  }
  if (!externalOrderInvoiceRequestId) {
    return NextResponse.json({ error: "缺少发票 ID" }, { status: 400 });
  }

  try {
    void sweepExpiredInvoiceStaging().catch(() => undefined);

    const buffer = Buffer.from(await file.arrayBuffer());
    const staging = await createInvoiceStagingFile({
      createdById: session.user.id,
      originalFileName: file.name,
      declaredMime: file.type || "",
      buffer,
      allowedMime: PAGE_INVOICE_UPLOAD_MIME,
      allowedExt: PAGE_INVOICE_UPLOAD_EXTENSIONS,
      ttlMs: 60 * 60 * 1000, // short-lived page adapter staging
    });

    const result = await registerIssuedInvoiceForActor(
      { userId: session.user.id, role: session.user.role },
      {
        invoiceRequestId: externalOrderInvoiceRequestId,
        stagedFile: staging,
        actualInvoiceNo,
        actualIssuedAt,
        expectedSha256: staging.sha256,
        expectedStagingVersion: staging.version,
      },
      {
        policy: WEB_REGISTER_ISSUED_INVOICE_POLICY,
        invocation: { channel: "web" },
      },
    );

    const document = await prisma.invoiceDocument.findUnique({
      where: { id: result.document.id },
    });

    return NextResponse.json({ document }, { status: 201 });
  } catch (err) {
    const mapped = mapRegisterIssuedInvoiceError(err);
    if (mapped) {
      return NextResponse.json(mapped.body, { status: mapped.status });
    }
    console.error("[invoice-documents] POST failed:", err);
    return NextResponse.json({ error: "登记发票附件失败" }, { status: 500 });
  }
}
