/**
 * FinanceReceipt 写路径的 profileId 守卫（可单测，不依赖 HTTP）。
 */

export class ReceiptMissingProfileError extends Error {
  constructor(message = "订单缺少 profileId，无法登记回款。请先完成客户资料绑定。") {
    super(message);
    this.name = "ReceiptMissingProfileError";
  }
}

/** 1-to-1 回款：订单必须有非空 profileId。 */
export function requireOrderProfileIdForReceipt(profileId: string | null | undefined): string {
  if (!profileId) {
    throw new ReceiptMissingProfileError();
  }
  return profileId;
}

/**
 * Allocation 回款：每个 coverage 订单都必须有 profileId；
 * 唯一 Profile → 返回该 id；跨 Profile → 返回 null（无单一归属，允许）。
 */
export function resolveAllocationReceiptProfileId(
  orders: Array<{ id: string; profileId: string | null }>,
  expectedOrderIds: string[],
): string | null {
  if (orders.length !== expectedOrderIds.length) {
    throw new ReceiptMissingProfileError("部分 coverage 订单不存在");
  }
  const missing = orders.filter((o) => !o.profileId);
  if (missing.length > 0) {
    throw new ReceiptMissingProfileError(
      `订单缺少 profileId，无法登记回款: ${missing.map((o) => o.id).join(", ")}`,
    );
  }
  const unique = [...new Set(orders.map((o) => o.profileId!))];
  return unique.length === 1 ? unique[0]! : null;
}
