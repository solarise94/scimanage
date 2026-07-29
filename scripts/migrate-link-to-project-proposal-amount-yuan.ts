/**
 * 迁移 PENDING 的 orders.link_to_project proposal：
 * 旧 inputJson 的 allocatedAmount（分）→ allocatedAmountYuan（元）+ inputVersion: 2。
 *
 * 修复确认时把「已是分」的字段再按元 ×100 的风险。
 *
 * 用法:
 *   npx tsx scripts/migrate-link-to-project-proposal-amount-yuan.ts          # dry-run
 *   npx tsx scripts/migrate-link-to-project-proposal-amount-yuan.ts --apply
 */

import { prisma } from "../src/lib/prisma";
import { centsToYuan } from "../src/lib/finance/money";
import { migrateLinkToProjectProposalInput } from "../src/lib/agent-actions/format-tool-result-for-model";

const APPLY = process.argv.includes("--apply");

async function main() {
  const rows = await prisma.agentProposal.findMany({
    where: {
      actionKey: "orders.link_to_project",
      status: { in: ["PENDING", "PROCESSING"] },
    },
    select: { id: true, inputJson: true, status: true },
  });

  console.log(`找到 ${rows.length} 条 PENDING/PROCESSING link_to_project proposal`);
  let changed = 0;

  for (const row of rows) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.inputJson) as Record<string, unknown>;
    } catch {
      console.warn(`  skip ${row.id}: invalid JSON`);
      continue;
    }
    const { migrated, input } = migrateLinkToProjectProposalInput(parsed, centsToYuan);
    if (!migrated) continue;
    changed++;
    console.log(
      `  ${APPLY ? "UPDATE" : "would update"} ${row.id} (${row.status}): ` +
        `allocatedAmount=${String(parsed.allocatedAmount)} → allocatedAmountYuan=${String(input.allocatedAmountYuan)}`,
    );
    if (APPLY) {
      await prisma.agentProposal.update({
        where: { id: row.id },
        data: { inputJson: JSON.stringify(input) },
      });
    }
  }

  console.log(APPLY ? `已迁移 ${changed} 条` : `dry-run：将迁移 ${changed} 条（加 --apply 写入）`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
