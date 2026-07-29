// One-shot: seed ProcurementChannel from existing Project.procurementSource values.
// Run with: npx tsx prisma/backfill-procurement-channels.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.project.findMany({
    where: { procurementSource: { not: null }, deleted: false },
    select: { procurementSource: true },
    distinct: ["procurementSource"],
  });

  const names = [...new Set(rows.map((r) => r.procurementSource!.trim()).filter(Boolean))];

  let created = 0;
  for (const name of names) {
    const exists = await prisma.procurementChannel.findUnique({ where: { name } });
    if (!exists) {
      await prisma.procurementChannel.create({ data: { name } });
      created++;
    }
  }

  console.log(`Backfilled ${created} new channels from ${names.length} unique procurement sources.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
