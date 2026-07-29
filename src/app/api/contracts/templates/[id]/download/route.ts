import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canManageTemplates } from "@/lib/contracts/permissions";
import fs from "fs/promises";
import path from "path";

// GET: 下载模板原始文件
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canManageTemplates(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const template = await prisma.contractTemplate.findUnique({ where: { id } });
  if (!template) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const absPath = path.join(process.cwd(), "public", template.fileUrl);
  try {
    const buffer = await fs.readFile(absPath);
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(template.fileName)}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "模板文件读取失败" }, { status: 500 });
  }
}
