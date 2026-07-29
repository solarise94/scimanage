import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ensureSalesUserForRepresentative } from "@/lib/representative-user";

type DbLike = typeof prisma | Prisma.TransactionClient;

/**
 * 本部（系统）代表 — 客户在没有任何真人(HUMAN)机构绑定时的全局兜底负责人。
 *
 * 设计见 docs/customer-form-unification-design-2026-06-27.md（U4）：
 * - kind="SYSTEM" 与真人代表（kind="HUMAN"）区分，集中常量，不靠 email 前缀判断。
 * - 本部代表全局唯一，不给任何机构造 RepresentativeOrganization 绑定。
 * - 排除范围：提成、运营 KPI、代表排行榜、magic link（详见 U5）。
 */
export const HQ_REPRESENTATIVE_NAME = "本部";
export const HQ_REPRESENTATIVE_EMAIL = "hq-internal@system.scimanage.local";
export const REPRESENTATIVE_KIND = {
  HUMAN: "HUMAN",
  SYSTEM: "SYSTEM",
} as const;

export type EffectiveSystemRepresentative = {
  representativeId: string;
  representativeName: string;
  ownerUserId: string;
};

// 本部代表全局静态，解析一次后缓存正向结果（risk #6：避免每次 resolver 都查）。
// 仅缓存命中结果；未命中（未 seed）时不缓存，下次仍会重查。
let cachedSystemRep: EffectiveSystemRepresentative | null = null;

/** 测试/治理脚本用：清除缓存（seed 本部代表后调用以便 resolver 立即生效）。 */
export function clearSystemRepresentativeCache(): void {
  cachedSystemRep = null;
}

/**
 * 解析本部系统代表及其绑定的销售 User（email bridge），供 effective resolver
 * 的 SYSTEM_FALLBACK 分支使用。命中后缓存；未 seed 或缺销售 User 时返回 null。
 */
export async function resolveSystemRepresentative(
  db: DbLike = prisma,
): Promise<EffectiveSystemRepresentative | null> {
  if (cachedSystemRep) return cachedSystemRep;

  const rep = await db.representative.findFirst({
    where: { kind: REPRESENTATIVE_KIND.SYSTEM, archived: false },
    select: { id: true, name: true, email: true },
    orderBy: { createdAt: "asc" },
  });
  if (!rep || !rep.email) return null;

  const user = await db.user.findUnique({
    where: { email: rep.email },
    select: { id: true, role: true },
  });
  if (!user || (user.role !== "REPRESENTATIVE" && user.role !== "REGIONAL_MANAGER")) {
    return null;
  }

  const resolved: EffectiveSystemRepresentative = {
    representativeId: rep.id,
    representativeName: rep.name,
    ownerUserId: user.id,
  };
  cachedSystemRep = resolved;
  return resolved;
}

/**
 * 幂等创建/确保本部系统代表 + 对应销售 User 存在。供 seed 与一次性治理脚本调用。
 * 已存在则补正 kind=SYSTEM / 取消归档，不重复创建。
 *
 * 注意：使用全局 prisma（ensureSalesUserForRepresentative 内部如此），不在外部事务内调用。
 */
export async function ensureHqRepresentative(): Promise<EffectiveSystemRepresentative> {
  const email = HQ_REPRESENTATIVE_EMAIL;

  // 先确保销售 User 存在（role=REPRESENTATIVE，随机密码，仅 magic link 登录）。
  const { userId } = await ensureSalesUserForRepresentative({
    email,
    name: HQ_REPRESENTATIVE_NAME,
  });

  const existing = await prisma.representative.findUnique({
    where: { email },
    select: { id: true, name: true, kind: true, archived: true },
  });

  let representativeId: string;
  if (existing) {
    // 补正：确保 kind=SYSTEM 且未归档
    if (existing.kind !== REPRESENTATIVE_KIND.SYSTEM || existing.archived) {
      await prisma.representative.update({
        where: { id: existing.id },
        data: { kind: REPRESENTATIVE_KIND.SYSTEM, archived: false, archivedAt: null },
      });
    }
    representativeId = existing.id;
  } else {
    const created = await prisma.representative.create({
      data: {
        email,
        name: HQ_REPRESENTATIVE_NAME,
        kind: REPRESENTATIVE_KIND.SYSTEM,
      },
      select: { id: true },
    });
    representativeId = created.id;
  }

  const resolved: EffectiveSystemRepresentative = {
    representativeId,
    representativeName: HQ_REPRESENTATIVE_NAME,
    ownerUserId: userId,
  };
  cachedSystemRep = resolved;
  return resolved;
}
