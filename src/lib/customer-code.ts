/**
 * Generate a sequential customer code in KH-000001 format.
 * Accepts an optional transaction client for use within $transaction blocks.
 *
 * 用 MAX(customerCode)+1 起算，避免在跳号场景（历史导入留下稀疏号空间）下
 * count+1 落到已占用号触发 P2002。customerCode 是 6 位 zero-padded，字典序=数字序。
 *
 * 主权：customerCode 已迁到 CrmCustomerProfile，禁止再查 Customer 旧列。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function generateCustomerCode(tx?: any): Promise<string> {
  const client = tx ?? (await import("@/lib/prisma")).prisma;
  const maxRow = await client.crmCustomerProfile.findFirst({
    where: { customerCode: { startsWith: "KH-" } },
    orderBy: { customerCode: "desc" },
    select: { customerCode: true },
  });
  const maxN = maxRow?.customerCode ? parseInt(maxRow.customerCode.slice(3), 10) || 0 : 0;
  for (let i = 1; i <= 10; i++) {
    const code = `KH-${String(maxN + i).padStart(6, "0")}`;
    const exists = await client.crmCustomerProfile.findUnique({
      where: { customerCode: code },
      select: { id: true },
    });
    if (!exists) return code;
  }
  // fallback: random within 6-digit range
  return `KH-${String(Math.floor(Math.random() * 999999) + 1).padStart(6, "0")}`;
}
