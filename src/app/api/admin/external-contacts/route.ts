import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// 外部部门通讯录：仅 ADMIN 维护（设计文档 §3.3 / §7）

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const includeArchived = req.nextUrl.searchParams.get("includeArchived") === "1";
  const contacts = await prisma.externalContact.findMany({
    where: includeArchived ? {} : { archived: false },
    orderBy: [{ archived: "asc" }, { department: "asc" }, { name: "asc" }],
  });

  return NextResponse.json({ contacts });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { name, email, department, description, ccEmails, enabled } = body as Record<
    string,
    unknown
  >;

  if (!(name as string)?.trim()) {
    return NextResponse.json({ error: "名称不能为空" }, { status: 400 });
  }
  const trimmedEmail = (email as string)?.trim();
  if (!trimmedEmail || !trimmedEmail.includes("@")) {
    return NextResponse.json({ error: "收件邮箱无效" }, { status: 400 });
  }

  const contact = await prisma.externalContact.create({
    data: {
      name: (name as string).trim(),
      email: trimmedEmail,
      department: (department as string)?.trim() || null,
      description: (description as string)?.trim() || null,
      ccEmails: (ccEmails as string)?.trim() || null,
      enabled: enabled === undefined ? true : !!enabled,
    },
  });

  return NextResponse.json({ contact }, { status: 201 });
}
