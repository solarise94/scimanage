/**
 * 只读治理探测：检查已完成签到的业务时间与派生 interaction 完整性。
 * 运行：npx tsx scripts/govern-checkin-completion-integrity.ts
 */
import { prisma } from "../src/lib/prisma";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function main() {
  const completed = await prisma.crmVisitCheckin.findMany({
    where: { status: "COMPLETED" },
    select: {
      id: true,
      profileId: true,
      interactionId: true,
      completedAt: true,
    },
  });

  const interactionIds = completed
    .map((checkin) => checkin.interactionId)
    .filter((id): id is string => !!id);
  const interactions = interactionIds.length > 0
    ? await prisma.crmInteraction.findMany({
        where: { id: { in: interactionIds } },
        select: { id: true, profileId: true, type: true },
      })
    : [];
  const interactionById = new Map(interactions.map((interaction) => [interaction.id, interaction]));

  const sourcedVisitInteractions = await prisma.crmInteraction.findMany({
    where: { sourceType: "CHECKIN" },
    select: {
      id: true,
      profileId: true,
      type: true,
      sourceId: true,
    },
  });
  const sourcedCheckinIds = sourcedVisitInteractions
    .map((interaction) => interaction.sourceId)
    .filter((id): id is string => !!id);
  const sourcedCheckins = sourcedCheckinIds.length > 0
    ? await prisma.crmVisitCheckin.findMany({
        where: { id: { in: sourcedCheckinIds } },
        select: { id: true, profileId: true, status: true, interactionId: true },
      })
    : [];
  const sourcedCheckinById = new Map(sourcedCheckins.map((checkin) => [checkin.id, checkin]));

  const missingCompletedAt = completed.filter((checkin) => !checkin.completedAt);
  const missingInteractionId = completed.filter((checkin) => !checkin.interactionId);
  const missingInteraction = completed.filter(
    (checkin) => checkin.interactionId && !interactionById.has(checkin.interactionId),
  );
  const mismatchedInteraction = completed.filter((checkin) => {
    if (!checkin.interactionId) return false;
    const interaction = interactionById.get(checkin.interactionId);
    return !!interaction && (interaction.profileId !== checkin.profileId || interaction.type !== "VISIT");
  });

  const duplicateInteractionReferences = [...completed.reduce((groups, checkin) => {
    if (!checkin.interactionId) return groups;
    const ids = groups.get(checkin.interactionId) ?? [];
    ids.push(checkin.id);
    groups.set(checkin.interactionId, ids);
    return groups;
  }, new Map<string, string[]>())]
    .filter(([, checkinIds]) => checkinIds.length > 1)
    .map(([linkedInteractionId, checkinIds]) => ({ linkedInteractionId, checkinIds }));

  const sourcedInteractionsByCheckin = sourcedVisitInteractions.reduce((groups, interaction) => {
    if (!interaction.sourceId) return groups;
    const ids = groups.get(interaction.sourceId) ?? [];
    ids.push(interaction.id);
    groups.set(interaction.sourceId, ids);
    return groups;
  }, new Map<string, string[]>());
  const multipleVisitsForCheckin = [...sourcedInteractionsByCheckin]
    .filter(([, ids]) => ids.length > 1)
    .map(([checkinId, interactionIdsForCheckin]) => ({ checkinId, interactionIds: interactionIdsForCheckin }));

  const orphanSourcedInteractions = sourcedVisitInteractions.filter((interaction) => {
    if (!interaction.sourceId) return true;
    const checkin = sourcedCheckinById.get(interaction.sourceId);
    return !checkin
      || checkin.status !== "COMPLETED"
      || checkin.profileId !== interaction.profileId
      || interaction.type !== "VISIT"
      || checkin.interactionId !== interaction.id;
  });

  const issueCount = missingCompletedAt.length
    + missingInteractionId.length
    + missingInteraction.length
    + mismatchedInteraction.length
    + duplicateInteractionReferences.length
    + multipleVisitsForCheckin.length
    + orphanSourcedInteractions.length;
  const report = {
    generatedAt: new Date().toISOString(),
    severity: issueCount > 0 ? "ERROR" : "OK",
    issueCount,
    completedCount: completed.length,
    missingCompletedAtCount: missingCompletedAt.length,
    missingCompletedAtIds: missingCompletedAt.map((row) => row.id),
    missingInteractionIdCount: missingInteractionId.length,
    missingInteractionIdIds: missingInteractionId.map((row) => row.id),
    missingInteractionCount: missingInteraction.length,
    missingInteractionCheckinIds: missingInteraction.map((row) => row.id),
    mismatchedInteractionCount: mismatchedInteraction.length,
    mismatchedInteractionCheckinIds: mismatchedInteraction.map((row) => row.id),
    duplicateInteractionReferenceCount: duplicateInteractionReferences.length,
    duplicateInteractionReferences,
    multipleVisitsForCheckinCount: multipleVisitsForCheckin.length,
    multipleVisitsForCheckin,
    orphanSourcedInteractionCount: orphanSourcedInteractions.length,
    orphanSourcedInteractionIds: orphanSourcedInteractions.map((row) => row.id),
  };

  const artifactDir = join(process.cwd(), "artifacts", "governance");
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, `checkin-completion-integrity-${Date.now()}.json`);
  await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ ...report, artifactPath }, null, 2));
  if (issueCount > 0) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
