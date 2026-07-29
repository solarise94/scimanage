import { prisma } from "@/lib/prisma";

/** Build a mapping of orderId → hasProjectLinks for efficient treatment derivation. */
export async function buildOrderProjectLinkMap(orderIds: string[]): Promise<Map<string, boolean>> {
  if (orderIds.length === 0) return new Map();
  const links = await prisma.orderProjectLink.findMany({
    where: { orderId: { in: orderIds } },
    select: { orderId: true },
    distinct: ["orderId"],
  });
  const map = new Map<string, boolean>();
  for (const l of links) map.set(l.orderId, true);
  return map;
}
