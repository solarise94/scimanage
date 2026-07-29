import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { yuanToCents, centsToYuan } from "@/lib/finance/money";
import { isValidInquiryStatus } from "@/lib/supply-chain/constants";
import { resolveActorDepartmentOrNull } from "@/lib/department";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN" && session.user.role !== "USER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const existing = await prisma.supplierInquiry.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // 对象级权限：ADMIN 全量；USER 仅当询价 departmentSnapshot = actor.department。
  // 设计 §6.5：Inquiry 按自身 departmentSnapshot 过滤；不再用 createdById 兜底
  // （会放宽跨部门，B 部门 USER 不得修改 A 部门用户创建的询价）。
  // Fail-closed（设计 §6.1）：部门无法权威解析时拒绝（403），不静默降级 FIELD_SALES。
  if (session.user.role !== "ADMIN") {
    const dept = await resolveActorDepartmentOrNull(session.user.id);
    if (!dept || existing.departmentSnapshot !== dept) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const body = await req.json();
  const { status, responsePrice, finalPrice, responseLeadDays, note } = body as Record<string, unknown>;

  if (status !== undefined && status !== null && !isValidInquiryStatus(status as string)) {
    return NextResponse.json({ error: "无效询价状态" }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  if (status !== undefined) data.status = status;
  if (responsePrice !== undefined) data.responsePrice = responsePrice != null ? yuanToCents(Number(responsePrice)) : null;
  if (finalPrice !== undefined) data.finalPrice = finalPrice != null ? yuanToCents(Number(finalPrice)) : null;
  if (responseLeadDays !== undefined) data.responseLeadDays = responseLeadDays != null ? Number(responseLeadDays) : null;
  if (note !== undefined) data.note = note;

  const updated = await prisma.supplierInquiry.update({ where: { id }, data });

  return NextResponse.json({
    inquiry: {
      ...updated,
      targetPrice: updated.targetPrice != null ? centsToYuan(updated.targetPrice) : null,
      responsePrice: updated.responsePrice != null ? centsToYuan(updated.responsePrice) : null,
      finalPrice: updated.finalPrice != null ? centsToYuan(updated.finalPrice) : null,
    },
  });
}
