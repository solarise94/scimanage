import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { businessActorFromSessionUser } from "@/lib/application/actor";
import { ApplicationError } from "@/lib/application/errors";
import { listContractTemplatesForActor } from "@/lib/contracts/application/query-contract-templates";
import { canManageTemplates } from "@/lib/contracts/permissions";
import { scanDocxTemplate } from "@/lib/contracts/template-scan";
import { createId } from "@paralleldrive/cuid2";
import fs from "fs/promises";
import path from "path";

// GET: 模板列表（含筛选 category/archived）— T8.1a 起走 canonical application service
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const actor = businessActorFromSessionUser(session.user);
    const url = req.nextUrl;
    const { templates } = await listContractTemplatesForActor(actor, {
      category: url.searchParams.get("category"),
      includeArchived: url.searchParams.get("includeArchived") === "1",
    });
    return NextResponse.json({ templates });
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }
}

// POST: 上传新模板（multipart，含变量校验）
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canManageTemplates(session.user.role)) {
    return NextResponse.json({ error: "Forbidden: 仅管理员可管理模板" }, { status: 403 });
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const name = formData.get("name") as string;
  const category = formData.get("category") as string;
  const description = (formData.get("description") as string) || null;
  const isDefault = formData.get("isDefault") === "true";

  // 校验必填
  if (!file || !name || !category) {
    return NextResponse.json({ error: "缺少必填字段" }, { status: 400 });
  }
  // 校验扩展名
  if (!file.name.toLowerCase().endsWith(".docx")) {
    return NextResponse.json({ error: "仅支持 .docx 文件" }, { status: 400 });
  }
  // 校验大小
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "文件超过 10MB 上限" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // 变量校验
  const scanResult = await scanDocxTemplate(buffer);
  if (!scanResult.ok) {
    return NextResponse.json(
      {
        error: "模板含未知变量，请检查占位符拼写",
        unknown: scanResult.unknown,
        found: scanResult.found,
        recognized: scanResult.recognized,
      },
      { status: 400 }
    );
  }

  // 先写文件
  const templateId = createId();
  const relPath = `/uploads/contract-templates/${templateId}/template.docx`;
  const absPath = path.join(process.cwd(), "public", relPath);
  try {
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, buffer);
  } catch (writeErr) {
    return NextResponse.json(
      {
        error: `模板文件保存失败：${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
      },
      { status: 500 }
    );
  }

  // 文件写成功，建 DB 行
  try {
    const template = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.contractTemplate.updateMany({
          where: { category, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.contractTemplate.create({
        data: {
          id: templateId,
          name,
          category,
          description,
          fileUrl: relPath,
          fileName: file.name,
          fileSize: file.size,
          detectedVariables: JSON.stringify(scanResult.found),
          isDefault,
          createdById: session.user.id,
        },
      });
    });
    return NextResponse.json(
      { ...template, fileUrl: relPath },
      { status: 201 }
    );
  } catch (dbErr) {
    // DB 写失败：删已写文件
    await fs.rm(absPath, { force: true }).catch(() => {});
    return NextResponse.json(
      {
        error: `模板保存失败：${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
      },
      { status: 500 }
    );
  }
}
