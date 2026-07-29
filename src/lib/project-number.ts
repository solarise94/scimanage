import { prisma } from "@/lib/prisma";

/**
 * Generate a project number in PRJ-YYYYMMDD-NNNN format.
 * Accepts optional transaction client for use within $transaction().
 */
export async function generateProjectNo(tx?: { project: typeof prisma.project }): Promise<string> {
  const db = tx || prisma;
  const today = new Date();
  const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;

  const last = await db.project.findFirst({
    where: { projectNo: { startsWith: `PRJ-${dateStr}` } },
    orderBy: { projectNo: "desc" },
    select: { projectNo: true },
  });

  let seq = 1;
  if (last?.projectNo) {
    const parts = last.projectNo.split("-");
    seq = parseInt(parts[parts.length - 1] || "0", 10) + 1;
  }

  return `PRJ-${dateStr}-${String(seq).padStart(4, "0")}`;
}
