import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { prisma } from "@/lib/prisma";
import { releaseInvoiceFileHashClaimByDocumentId } from "@/lib/finance/invoice-claims";
import fs from "fs/promises";
import path from "path";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (session.user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const doc = await prisma.invoiceDocument.findUnique({ where: { id } });
  if (!doc) return NextResponse.json({ error: "文件不存在" }, { status: 404 });

  await prisma.$transaction(async (tx) => {
    await releaseInvoiceFileHashClaimByDocumentId(tx, id);
    await tx.invoiceDocument.delete({ where: { id } });
  });

  const filePath = path.join(process.cwd(), "public", doc.fileUrl);
  try { await fs.unlink(filePath); } catch { /* file may already be gone */ }

  return NextResponse.json({ success: true });
}
