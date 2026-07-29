/**
 * 通用业务编号原子序列服务。
 *
 * 对应设计文档 §4.3：Product/SKU 编号不能使用"查最大值再加一"，
 * SQLite 并发下两个请求可能读到相同最大值。这里用原子 upsert 领号，
 * 再格式化为 PRD-000001 / SKU-000001。
 *
 * 规则（设计文档 §4.3）：
 *  - Product 和 ProductSku 使用独立序列；
 *  - 序号允许因事务失败产生空洞，但绝不回收或复用；
 *  - productCode/skuCode @unique 仍是最终数据库防线；
 *  - 对唯一冲突最多重试 3 次，重试时领取新序号；
 *  - 编号服务放在 canonical application service 中，Web、导入和 Agent 不得各自实现编号算法。
 *
 * 本模块是基础设施，允许 Prisma。
 */
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import {
  PRODUCT_CODE_PREFIX,
  PRODUCT_CODE_PAD,
  SEQUENCE_KEY,
  SKU_CODE_PREFIX,
} from "@/lib/products/constants";

type TransactionClient = Prisma.TransactionClient;

/**
 * 在事务内原子领取下一个序号。
 *
 * 使用 SQLite 原子 upsert：
 *
 * ```sql
 * INSERT INTO BusinessSequence (key, currentValue, updatedAt)
 * VALUES (?, 1, CURRENT_TIMESTAMP)
 * ON CONFLICT(key) DO UPDATE
 * SET currentValue = currentValue + 1,
 *     updatedAt = CURRENT_TIMESTAMP
 * RETURNING currentValue;
 * ```
 *
 * Prisma 5 的 upsert 不直接支持 RETURNING + 原子 increment 的组合，
 * 但 `$executeRaw` + `$queryRaw` 在同一事务内对 SQLite 是原子的
 * （SQLite 的 upsert 在单条语句内持写锁）。
 */
export async function nextSequenceValue(
  tx: TransactionClient,
  key: string,
): Promise<number> {
  // 原子 upsert + increment。SQLite ON CONFLICT 在单语句内加写锁，
  // 并发请求会串行化，保证 currentValue 单调递增。
  await tx.$executeRaw`
    INSERT INTO BusinessSequence (key, currentValue, updatedAt)
    VALUES (${key}, 0, datetime('now'))
    ON CONFLICT(key) DO NOTHING
  `;
  const rows = await tx.$queryRaw<Array<{ currentValue: number }>>`
    UPDATE BusinessSequence
    SET currentValue = currentValue + 1,
        updatedAt = datetime('now')
    WHERE key = ${key}
    RETURNING currentValue
  `;
  return Number(rows[0].currentValue);
}

/** 格式化产品编号：PRD-000001。 */
export function formatProductCode(seq: number): string {
  return `${PRODUCT_CODE_PREFIX}-${String(seq).padStart(PRODUCT_CODE_PAD, "0")}`;
}

/** 格式化 SKU 编号：SKU-000001。 */
export function formatSkuCode(seq: number): string {
  return `${SKU_CODE_PREFIX}-${String(seq).padStart(PRODUCT_CODE_PAD, "0")}`;
}

/**
 * 在事务内领取并格式化下一个产品编号。
 * 唯一冲突由调用方重试（重试时重新领号，不复用旧号）。
 */
export async function nextProductCode(tx: TransactionClient): Promise<string> {
  const seq = await nextSequenceValue(tx, SEQUENCE_KEY.PRODUCT);
  return formatProductCode(seq);
}

/**
 * 在事务内领取并格式化下一个 SKU 编号。
 */
export async function nextSkuCode(tx: TransactionClient): Promise<string> {
  const seq = await nextSequenceValue(tx, SEQUENCE_KEY.PRODUCT_SKU);
  return formatSkuCode(seq);
}

/**
 * 在事务内领取任意 key 的下一个序号（用于未来扩展 Order/Project 编号）。
 */
export async function nextSequenceCode(
  tx: TransactionClient,
  key: string,
  prefix: string,
  pad = PRODUCT_CODE_PAD,
): Promise<string> {
  const seq = await nextSequenceValue(tx, key);
  return `${prefix}-${String(seq).padStart(pad, "0")}`;
}

/**
 * P2002 唯一冲突检测：判断错误是否是某个字段的唯一约束冲突。
 * 用于编号领号后的重试决策。
 */
export function isUniqueConflictOn(
  err: unknown,
  ...targets: string[]
): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e.code !== "P2002") return false;
  const target = Array.isArray(e.meta?.target) ? (e.meta!.target as string[]) : [];
  return targets.some((t) => target.includes(t));
}

/**
 * 重试包装：对编号唯一冲突最多重试 maxAttempts 次，每次重新领号。
 * 非编号冲突（如 productCode @unique 以外）直接抛出。
 *
 * 注：调用 fn 在 prisma.$transaction 内执行，fn 接收 tx。
 */
export async function withSequenceRetry<T>(
  maxAttempts: number,
  fn: (tx: TransactionClient) => Promise<T>,
  conflictTargets: string[] = ["productCode", "skuCode"],
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await prisma.$transaction(fn);
    } catch (err) {
      lastError = err;
      if (isUniqueConflictOn(err, ...conflictTargets) && attempt < maxAttempts - 1) {
        // 编号冲突 → 重新领号重试（fn 内会再次调用 nextProductCode/nextSkuCode）
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
