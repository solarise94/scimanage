import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// 外部通讯录批量导入（仅 ADMIN）。见 docs/business-email-notification-design-2026-06-26.md §9 item 3
//
// 请求体：{ text: string }
// 每行一条：name,email,department,ccEmails,description
//   - name、email 必填；email 必须含 @
//   - ccEmails 多个用「;」分隔（避免与列分隔的逗号冲突）
//   - 第 5 列起的内容合并为 description
//   - 首行若含「邮箱」或「email」视为表头跳过
// 去重：与库内已有 email（含已归档）+ 本批次内 email 去重，重复跳过。
// 全部有效行在单个 $transaction 内创建。

interface ParsedRow {
  line: number;
  name: string;
  email: string;
  department: string | null;
  ccEmails: string | null;
  description: string | null;
}

interface SkipInfo {
  line: number;
  raw: string;
  reason: string;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const text = (body?.text as string | undefined)?.replace(/\r\n?/g, "\n");
  if (!text || !text.trim()) {
    return NextResponse.json({ error: "导入内容为空" }, { status: 400 });
  }

  const rawLines = text.split("\n");
  const valid: ParsedRow[] = [];
  const skipped: SkipInfo[] = [];
  const seenInBatch = new Set<string>();

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue; // 空行
    // 表头检测：仅当首个非空行的「邮箱」列不含 @（真实数据行该列必含 @）时才视为表头跳过，
    // 避免姓名/部门恰好含 "email"/"name" 子串的数据行被误判为表头而静默丢弃。
    if (valid.length === 0 && skipped.length === 0) {
      const secondCol = (trimmed.split(",")[1] || "").trim();
      if (!secondCol.includes("@") && /邮箱|email|名称|name|姓名/i.test(trimmed)) {
        continue;
      }
    }

    const parts = trimmed.split(",");
    const name = (parts[0] || "").trim();
    const email = (parts[1] || "").trim();
    const department = (parts[2] || "").trim();
    const ccEmails = (parts[3] || "").trim();
    const description = parts.slice(4).join(",").trim();

    if (!name) {
      skipped.push({ line: i + 1, raw: trimmed, reason: "名称为空" });
      continue;
    }
    if (!email || !email.includes("@")) {
      skipped.push({ line: i + 1, raw: trimmed, reason: "收件邮箱无效" });
      continue;
    }
    const emailKey = email.toLowerCase();
    if (seenInBatch.has(emailKey)) {
      skipped.push({ line: i + 1, raw: trimmed, reason: "本批次内邮箱重复" });
      continue;
    }
    seenInBatch.add(emailKey);
    valid.push({
      line: i + 1,
      name,
      email,
      department: department || null,
      ccEmails: ccEmails || null,
      description: description || null,
    });
  }

  // 与库内已有 email 去重（含已归档），不区分大小写。
  // 注意：SQLite 的 IN/= 区分大小写，且 Prisma 在 SQLite 上不支持 mode:"insensitive"，
  // 故拉取全部已有 email 在内存里做小写比较（外部通讯录表规模很小）。
  if (valid.length > 0) {
    const existing = await prisma.externalContact.findMany({
      select: { email: true },
    });
    const existingSet = new Set(existing.map((e) => e.email.toLowerCase()));
    for (let idx = valid.length - 1; idx >= 0; idx--) {
      if (existingSet.has(valid[idx].email.toLowerCase())) {
        const r = valid[idx];
        skipped.push({ line: r.line, raw: r.email, reason: "邮箱已存在" });
        valid.splice(idx, 1);
      }
    }
  }

  let created = 0;
  if (valid.length > 0) {
    await prisma.$transaction(
      valid.map((r) =>
        prisma.externalContact.create({
          data: {
            name: r.name,
            email: r.email,
            department: r.department,
            ccEmails: r.ccEmails,
            description: r.description,
            enabled: true,
          },
        }),
      ),
    );
    created = valid.length;
  }

  return NextResponse.json({
    created,
    skippedCount: skipped.length,
    skipped: skipped.sort((a, b) => a.line - b.line),
  });
}
