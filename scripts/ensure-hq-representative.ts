/**
 * 幂等 seed 本部（系统）代表 + 对应销售 User。
 *
 * 设计见 docs/customer-form-unification-design-2026-06-27.md（U4，存量治理 step 2）。
 * 可对任意环境重复执行：已存在则补正 kind=SYSTEM / 取消归档，不重复创建。
 * 密码由 ensureSalesUserForRepresentative 内部用随机 UUID 生成，无硬编码凭据。
 *
 * 用法：
 *   npx tsx scripts/ensure-hq-representative.ts
 *   DATABASE_URL=file:/path/to/dev.db npx tsx scripts/ensure-hq-representative.ts
 */
import { prisma } from "@/lib/prisma";
import {
  ensureHqRepresentative,
  HQ_REPRESENTATIVE_EMAIL,
  HQ_REPRESENTATIVE_NAME,
} from "@/lib/crm/system-representative";

async function main() {
  console.log(`[ensure-hq] 确保本部系统代表存在：${HQ_REPRESENTATIVE_NAME} <${HQ_REPRESENTATIVE_EMAIL}>`);
  const result = await ensureHqRepresentative();
  console.log("[ensure-hq] 完成：", {
    representativeId: result.representativeId,
    representativeName: result.representativeName,
    ownerUserId: result.ownerUserId,
  });

  // 二次校验
  const rep = await prisma.representative.findUnique({
    where: { email: HQ_REPRESENTATIVE_EMAIL },
    select: { id: true, name: true, kind: true, archived: true },
  });
  const user = await prisma.user.findUnique({
    where: { email: HQ_REPRESENTATIVE_EMAIL },
    select: { id: true, role: true },
  });
  console.log("[ensure-hq] 校验 Representative：", rep);
  console.log("[ensure-hq] 校验 User：", user);

  if (!rep || rep.kind !== "SYSTEM" || rep.archived) {
    throw new Error("[ensure-hq] 本部代表校验失败");
  }
  if (!user || (user.role !== "REPRESENTATIVE" && user.role !== "REGIONAL_MANAGER")) {
    throw new Error("[ensure-hq] 本部销售 User 校验失败");
  }
  console.log("[ensure-hq] ✓ 本部系统代表 + 销售 User 就绪");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
