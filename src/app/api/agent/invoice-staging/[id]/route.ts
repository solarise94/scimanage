import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
  deleteOwnedInvoiceStaging,
  getOwnedStagingFile,
  toPublicStagingMeta,
} from "@/lib/finance/invoice-staging";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden", code: "INVOICE_REQUEST_FORBIDDEN" }, { status: 403 });
  }

  try {
    const { id } = await params;
    const staging = await getOwnedStagingFile({
      stagingFileId: id,
      userId: session.user.id,
      requireActive: false,
    });
    if (
      staging.expiresAt.getTime() <= Date.now()
      || staging.status === "EXPIRED"
      || staging.status === "SKIPPED"
    ) {
      return NextResponse.json({ error: "staging 已过期", code: "INVOICE_STAGING_EXPIRED" }, { status: 410 });
    }
    return NextResponse.json({ stagingFile: toPublicStagingMeta(staging) });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && "httpStatus" in err) {
      const e = err as { code: string; message: string; httpStatus: number };
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.httpStatus });
    }
    console.error("[invoice-staging] get failed:", err);
    return NextResponse.json({ error: "查询失败" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden", code: "INVOICE_REQUEST_FORBIDDEN" }, { status: 403 });
  }

  try {
    const { id } = await params;
    const result = await deleteOwnedInvoiceStaging({
      stagingFileId: id,
      userId: session.user.id,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && "httpStatus" in err) {
      const e = err as { code: string; message: string; httpStatus: number };
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.httpStatus });
    }
    console.error("[invoice-staging] delete failed:", err);
    return NextResponse.json({ error: "删除失败" }, { status: 500 });
  }
}
