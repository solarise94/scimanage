/**
 * 只读差异报告：对比旧口径（type IN CRM_EFFECTIVE_INTERACTION_TYPES + binding 倒推归属）
 * 与新口径（getRepresentativeCommunicationEvents, createdByUserId 归属）的代表沟通次数。
 *
 * 旧口径：该 rep 当前有效 profile 内、type IN (CALL,WECHAT,EMAIL,MEETING,VISIT,REFERRAL) 的 interaction 数
 *         + completed checkin 数（不排除签到派生的 VISIT interaction）。
 * 新口径：getRepresentativeCommunicationEvents({ actorUserIds: [userId], from: d30, to: now }) 的事件数。
 *
 * 运行：npx tsx scripts/diff-old-communication-metrics.ts
 */
import { prisma } from "../src/lib/prisma";
import { getRepresentativeCommunicationEvents } from "../src/lib/crm/representative-communication-events";
import { resolveEffectiveRepresentativesForProfiles } from "../src/lib/crm/customer-effective-representative";
import { CRM_EFFECTIVE_INTERACTION_TYPES } from "../src/lib/crm/constants";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function main() {
  const now = new Date();
  const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Load all HUMAN representatives
  const reps = await prisma.representative.findMany({
    where: { kind: "HUMAN" },
    select: { id: true, name: true, email: true },
  });

  // Build email -> User bridge
  const repEmails = reps.map((r) => r.email).filter(Boolean);
  const users = repEmails.length > 0
    ? await prisma.user.findMany({
        where: { email: { in: repEmails }, role: { in: ["REPRESENTATIVE", "REGIONAL_MANAGER"] } },
        select: { id: true, email: true, name: true },
      })
    : [];
  const emailToUser = new Map(users.map((u) => [u.email, u]));

  // Get all non-archived profiles for effective rep resolution
  const allProfiles = await prisma.crmCustomerProfile.findMany({
    where: { archived: false, deleted: false },
    select: { id: true, ownerUserId: true },
  });
  const effectiveMap = await resolveEffectiveRepresentativesForProfiles(
    allProfiles.map((p) => p.id),
  );

  // Group profile IDs by effective representative
  const repToProfileIds = new Map<string, Set<string>>();
  for (const profile of allProfiles) {
    const effective = effectiveMap.get(profile.id);
    const repId = effective?.representativeId;
    if (!repId) continue;
    const set = repToProfileIds.get(repId) || new Set<string>();
    set.add(profile.id);
    repToProfileIds.set(repId, set);
  }

  interface RepDiff {
    representativeId: string;
    name: string;
    email: string;
    linkedUserId: string | null;
    oldInteractionCount: number;
    oldCheckinCount: number;
    oldTotal: number;
    newEventCount: number;
    diff: number;
  }

  const diffs: RepDiff[] = [];
  let hasDiff = false;

  for (const rep of reps) {
    const user = emailToUser.get(rep.email);
    const userId = user?.id ?? null;

    // ── Old metric: interactions with effective interaction types in rep's profiles ──
    const profileIds = [...(repToProfileIds.get(rep.id) ?? [])];

    const [oldInteractions, oldCheckins] = await Promise.all([
      profileIds.length > 0
        ? prisma.crmInteraction.count({
            where: {
              profileId: { in: profileIds },
              type: { in: [...CRM_EFFECTIVE_INTERACTION_TYPES] },
              happenedAt: { gte: d30, lt: now },
            },
          })
        : 0,
      // Old checkin count: completed checkins in rep's profiles (no actor filter)
      profileIds.length > 0
        ? prisma.crmVisitCheckin.count({
            where: {
              profileId: { in: profileIds },
              status: "COMPLETED",
              OR: [
                { completedAt: { gte: d30, lt: now } },
                { completedAt: null, createdAt: { gte: d30, lt: now } },
              ],
            },
          })
        : 0,
    ]);

    const oldTotal = oldInteractions + oldCheckins;

    // ── New metric: shared event service with actor attribution ──
    const newEvents = userId
      ? await getRepresentativeCommunicationEvents({ actorUserIds: [userId], from: d30, to: now })
      : [];
    const newEventCount = newEvents.length;

    const diff = oldTotal - newEventCount;
    if (diff !== 0) hasDiff = true;

    diffs.push({
      representativeId: rep.id,
      name: rep.name,
      email: rep.email,
      linkedUserId: userId,
      oldInteractionCount: oldInteractions,
      oldCheckinCount: oldCheckins,
      oldTotal,
      newEventCount,
      diff,
    });
  }

  // Write JSON artifact
  const artifactsDir = join(process.cwd(), "artifacts", "governance");
  await mkdir(artifactsDir, { recursive: true });
  const timestamp = Date.now();
  const artifactPath = join(artifactsDir, `communication-metrics-diff-${timestamp}.json`);
  await writeFile(artifactPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    window: { from: d30.toISOString(), to: now.toISOString() },
    summary: {
      totalReps: reps.length,
      repsWithDiff: diffs.filter((d) => d.diff !== 0).length,
      maxAbsDiff: Math.max(0, ...diffs.map((d) => Math.abs(d.diff))),
    },
    diffs,
  }, null, 2));

  // Print summary
  console.log(`\n=== Communication Metrics Diff Report ===`);
  console.log(`Window: ${d30.toISOString()} ~ ${now.toISOString()}`);
  console.log(`Total reps: ${diffs.length}`);
  console.log(`Reps with diff: ${diffs.filter((d) => d.diff !== 0).length}`);
  console.log(`Artifact: ${artifactPath}\n`);

  for (const d of diffs.filter((d) => d.diff !== 0)) {
    console.log(`  ${d.name} (${d.email})`);
    console.log(`    old: ${d.oldTotal} (interactions=${d.oldInteractionCount}, checkins=${d.oldCheckinCount})`);
    console.log(`    new: ${d.newEventCount}`);
    console.log(`    diff: ${d.diff > 0 ? "+" : ""}${d.diff}`);
  }

  if (hasDiff) {
    console.log(`\n⚠ Differences found -- exit code 2`);
    process.exitCode = 2;
  } else {
    console.log(`\n✓ No differences found`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
