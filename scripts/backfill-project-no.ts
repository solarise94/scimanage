/**
 * Backfill projectNo for existing Project rows.
 *
 * Usage: npx tsx scripts/backfill-project-no.ts
 *
 * Format: PRJ-YYYYMMDD-0001
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const projects = await prisma.project.findMany({
    where: { projectNo: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true },
  });

  console.log(`[BACKFILL] Found ${projects.length} projects without projectNo`);

  let count = 0;
  for (const p of projects) {
    const d = p.createdAt;
    const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await prisma.project.findFirst({
        where: { projectNo: { startsWith: `PRJ-${dateStr}` } },
        orderBy: { projectNo: "desc" },
        select: { projectNo: true },
      });
      let seq = 1;
      if (last?.projectNo) {
        const parts = last.projectNo.split("-");
        seq = parseInt(parts[parts.length - 1] || "0", 10) + 1;
      }
      const projectNo = `PRJ-${dateStr}-${String(seq + attempt).padStart(4, "0")}`;

      try {
        await prisma.project.update({
          where: { id: p.id },
          data: { projectNo },
        });
        count++;
        break;
      } catch (e: unknown) {
        const isP2002 = typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002";
        if (!isP2002 || attempt === 4) throw e;
      }
    }
  }

  console.log(`[BACKFILL] ${count} projects assigned projectNo`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[BACKFILL] Fatal error:", err);
  process.exit(1);
});
