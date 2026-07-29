/**
 * 签到事件时间事实源：completedAt ?? createdAt
 *
 * 计数窗口与最近事件排序必须使用同一表达式，禁止仅 orderBy completedAt
 * 再读取 fallback（null completedAt 的新记录会被旧 completedAt 压后）。
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type DbClient = typeof prisma | Prisma.TransactionClient;

export function checkinHappenedAt(row: {
  completedAt: Date | null | undefined;
  createdAt: Date;
}): Date {
  return row.completedAt ?? row.createdAt;
}

/** 计数窗口：completedAt in window OR (completedAt IS NULL AND createdAt in window) */
export function checkinEventTimeInWindowWhere(
  from: Date,
  toExclusive?: Date,
): Prisma.CrmVisitCheckinWhereInput {
  if (toExclusive) {
    return {
      OR: [
        { completedAt: { gte: from, lt: toExclusive } },
        { completedAt: null, createdAt: { gte: from, lt: toExclusive } },
      ],
    };
  }
  return {
    OR: [
      { completedAt: { gte: from } },
      { completedAt: null, createdAt: { gte: from } },
    ],
  };
}

function toDate(value: string | Date | number | bigint | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === "bigint") return new Date(Number(value));
  return new Date(value);
}

/** SQLite 变量上限约 999；为 userId+profileId 双 IN 预留余量 */
const SQLITE_ID_CHUNK = 400;

function chunkIds(ids: string[], size = SQLITE_ID_CHUNK): string[][] {
  if (ids.length === 0) return [];
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

type LastCheckinRow = {
  profileId: string;
  happenedAt: string | Date | number | bigint | null;
};

/**
 * 每个 profile 的最近签到事件时间（真正 COALESCE 排序聚合）。
 */
export async function getLastCheckinHappenedAtByProfileIds(
  profileIds: string[],
  db: DbClient = prisma,
): Promise<Map<string, Date>> {
  const ids = [...new Set(profileIds.filter(Boolean))];
  const result = new Map<string, Date>();
  if (ids.length === 0) return result;

  for (const chunk of chunkIds(ids)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await db.$queryRawUnsafe<LastCheckinRow[]>(
      `SELECT profileId, MAX(COALESCE(completedAt, createdAt)) AS happenedAt
       FROM CrmVisitCheckin
       WHERE status = 'COMPLETED' AND profileId IN (${placeholders})
       GROUP BY profileId`,
      ...chunk,
    );
    for (const row of rows) {
      const happenedAt = toDate(row.happenedAt);
      if (!row.profileId || !happenedAt) continue;
      const prev = result.get(row.profileId);
      if (!prev || happenedAt > prev) result.set(row.profileId, happenedAt);
    }
  }
  return result;
}

type UserProfileLastRow = {
  userId: string;
  profileId: string;
  happenedAt: string | Date | number | bigint | null;
};

/**
 * 按 (userId, profileId) 返回最近签到时间。
 * 调用方必须再用 profile→rep 映射过滤，禁止只按 userId 取全局最新。
 */
export async function getLastCheckinHappenedAtByUserAndProfile(
  params: {
    userIds: string[];
    profileIds: string[];
  },
  db: DbClient = prisma,
): Promise<Array<{ userId: string; profileId: string; happenedAt: Date }>> {
  const userIds = [...new Set(params.userIds.filter(Boolean))];
  const profileIds = [...new Set(params.profileIds.filter(Boolean))];
  if (userIds.length === 0 || profileIds.length === 0) return [];

  // 双 IN：profile 分块，保证 userIds.length + chunk.length < SQLite 上限
  const profileChunkSize = Math.max(50, SQLITE_ID_CHUNK - userIds.length);
  const best = new Map<string, { userId: string; profileId: string; happenedAt: Date }>();
  const userPh = userIds.map(() => "?").join(", ");

  for (const chunk of chunkIds(profileIds, profileChunkSize)) {
    const profilePh = chunk.map(() => "?").join(", ");
    const rows = await db.$queryRawUnsafe<UserProfileLastRow[]>(
      `SELECT userId, profileId, MAX(COALESCE(completedAt, createdAt)) AS happenedAt
       FROM CrmVisitCheckin
       WHERE status = 'COMPLETED'
         AND userId IN (${userPh})
         AND profileId IN (${profilePh})
       GROUP BY userId, profileId`,
      ...userIds,
      ...chunk,
    );
    for (const row of rows) {
      const happenedAt = toDate(row.happenedAt);
      if (!row.userId || !row.profileId || !happenedAt) continue;
      const key = `${row.userId}\0${row.profileId}`;
      const prev = best.get(key);
      if (!prev || happenedAt > prev.happenedAt) {
        best.set(key, { userId: row.userId, profileId: row.profileId, happenedAt });
      }
    }
  }
  return [...best.values()];
}

type TopIdRow = { id: string };

/**
 * 在 actor + profile scope 内按 COALESCE 时间取最近 N 条签到 ID。
 */
export async function getRecentScopedCheckinIds(
  params: {
    userId: string;
    profileIds: string[];
    take?: number;
  },
  db: DbClient = prisma,
): Promise<string[]> {
  const profileIds = [...new Set(params.profileIds.filter(Boolean))];
  const take = Math.max(1, Math.min(params.take ?? 20, 100));
  if (!params.userId || profileIds.length === 0) return [];

  // 分块取候选，再按事件时间全局排序截断
  type Ranked = { id: string; happenedAt: Date };
  const ranked: Ranked[] = [];
  for (const chunk of chunkIds(profileIds)) {
    const profilePh = chunk.map(() => "?").join(", ");
    const rows = await db.$queryRawUnsafe<Array<{ id: string; happenedAt: string | Date | number | bigint | null }>>(
      `SELECT id, COALESCE(completedAt, createdAt) AS happenedAt
       FROM CrmVisitCheckin
       WHERE status = 'COMPLETED'
         AND userId = ?
         AND profileId IN (${profilePh})
       ORDER BY COALESCE(completedAt, createdAt) DESC, id ASC
       LIMIT ?`,
      params.userId,
      ...chunk,
      take,
    );
    for (const row of rows) {
      const happenedAt = toDate(row.happenedAt);
      if (!row.id || !happenedAt) continue;
      ranked.push({ id: row.id, happenedAt });
    }
  }
  ranked.sort((a, b) => {
    const dt = b.happenedAt.getTime() - a.happenedAt.getTime();
    if (dt !== 0) return dt;
    return a.id.localeCompare(b.id);
  });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of ranked) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row.id);
    if (out.length >= take) break;
  }
  return out;
}

/**
 * 每个 profile 在给定 actor 下的最近签到时间（COALESCE）。
 */
export async function getLastActorCheckinHappenedAtByProfileIds(
  params: {
    userId: string;
    profileIds: string[];
  },
  db: DbClient = prisma,
): Promise<Map<string, Date>> {
  const profileIds = [...new Set(params.profileIds.filter(Boolean))];
  const result = new Map<string, Date>();
  if (!params.userId || profileIds.length === 0) return result;

  const rows = await getLastCheckinHappenedAtByUserAndProfile(
    { userIds: [params.userId], profileIds },
    db,
  );
  for (const row of rows) {
    result.set(row.profileId, row.happenedAt);
  }
  return result;
}
