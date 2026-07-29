import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  PROFILE_DELETE_GUARD_INCLUDE,
  evaluateProfileDeletableWithAddressHints,
  evaluateNoSourceProfileDeletableWithAddressHints,
} from "@/lib/governance/delete-guard";
import { getProfileAddressOrgHints } from "@/lib/customers/customer-address-org-hints";

const MAX_BATCH = 200;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

/**
 * POST /api/admin/governance/delete-customers
 * 统一客户删除写路径（设计文档 §八 Phase G4）。替代：
 *  - /api/admin/data-governance/batch-delete（三无孤儿扫删）
 *  - /api/customer-org-bindings/batch-delete（脏数据清理）
 *
 * body: { profileIds?: string[], mode?: "STRICT" | "NO_SOURCE" }
 *  - 传 profileIds：逐个校验并软删（C2b/C2c、C3 显式删除）。
 *  - 不传：扫描三无孤儿候选（cheap 预过滤）后逐个走统一守卫（保留旧"一键清理"行为）。
 *  - mode=NO_SOURCE：无来源客户清理。允许存在自动档案/代表标签壳信息，但仍拒绝任何业务、财务、关系、CRM 行为记录。
 *
 * 守卫为三套旧守卫的并集，宁严勿松。
 * W7.3 Profile-only：删除写入 = CrmCustomerProfile 生命周期字段（deleted/deletedAt），
 * 不再触碰 Customer 锚点表（Phase E 物理删除）；请求只收 profileIds，旧 *CustomerId 参数 400。
 * 删除时若该客户存在 PENDING/IGNORED 的 CustomerOrgBindingTask，一并标记 IGNORED（保留旧行为）。
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) ?? {};

  // Profile-only DTO：旧 *CustomerId 系参数一律 400（Phase E 删列后随旧列一起移除）。
  // 用键名枚举而非硬编码字段名，避免在源码里引用已废弃契约。
  const legacyKey = Object.keys(body).find((k) => /customerids?$/i.test(k));
  if (legacyKey) {
    return NextResponse.json(
      { error: `请使用 profileIds 指定客户（不再接受 ${legacyKey}）` },
      { status: 400 },
    );
  }

  const explicitIds: string[] | undefined = Array.isArray(body?.profileIds) ? body.profileIds : undefined;
  const mode = body?.mode === "NO_SOURCE" ? "NO_SOURCE" : "STRICT";

  if (explicitIds && explicitIds.length > MAX_BATCH) {
    return NextResponse.json({ error: `单次最多处理 ${MAX_BATCH} 条` }, { status: 400 });
  }

  // 候选 id：显式传入则取交集；否则按 cheap 预过滤扫描三无孤儿（守卫仍逐个复核，预过滤只为收窄集合）。
  let candidateIds: string[];
  if (explicitIds) {
    candidateIds = explicitIds;
  } else {
    const since = new Date(Date.now() - SEVEN_DAYS);
    const rows = await prisma.crmCustomerProfile.findMany({
      where: {
        deleted: false,
        archived: false,
        mergedIntoProfileId: null,
        createdAt: { lt: since },
        profileProjects: { none: {} },
        profileOrders: { none: {} },
      },
      select: { id: true },
    });
    candidateIds = rows.map((r) => r.id);
  }

  let deleted = 0;
  let skipped = 0;
  const errors: Array<{ profileId: string; reason: string }> = [];
  const resolvedById = session.user.id;
  const addressOrgHintsMap = await getProfileAddressOrgHints(candidateIds, 1);

  for (const id of candidateIds) {
    try {
      const profile = await prisma.crmCustomerProfile.findUnique({
        where: { id },
        include: PROFILE_DELETE_GUARD_INCLUDE,
      });
      const addressOrgHints = addressOrgHintsMap.get(id) ?? [];
      const guard = mode === "NO_SOURCE"
        ? evaluateNoSourceProfileDeletableWithAddressHints(profile, addressOrgHints)
        : evaluateProfileDeletableWithAddressHints(profile, addressOrgHints);
      if (!guard.deletable) {
        skipped++;
        errors.push({ profileId: id, reason: guard.reason || "不满足删除守卫" });
        continue;
      }

      await prisma.$transaction([
        prisma.customerRepTag.deleteMany({ where: { profileId: id } }),
        prisma.crmCustomerApplication.updateMany({
          where: { createdCrmProfileId: id },
          data: { createdCrmProfileId: null },
        }),
        // Profile 生命周期软删（Profile 即客户；Customer 锚点表 Phase E 物理删除，运行时不再写入）
        prisma.crmCustomerProfile.update({
          where: { id },
          data: { deleted: true, deletedAt: new Date() },
        }),
        prisma.customerOrgBindingTask.updateMany({
          where: { profileId: id, status: { in: ["PENDING", "IGNORED"] } },
          data: {
            status: "IGNORED",
            resolutionNote: "客户已删除，脏数据清理（统一删除写路径）",
            resolvedAt: new Date(),
            resolvedById,
          },
        }),
      ]);
      deleted++;
    } catch (e) {
      skipped++;
      errors.push({ profileId: id, reason: e instanceof Error ? e.message : "事务执行失败" });
    }
  }

  return NextResponse.json({ deleted, skipped, errors });
}
