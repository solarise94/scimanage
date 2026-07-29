import { prisma } from "@/lib/prisma";
import { resolveRepresentativeForOwnerUserId } from "@/lib/crm/customer-owner-representative";
import { isSalesRole } from "@/lib/role-guards";

export async function canAccessOwnRepresentativeReport(
  userId: string,
  role: string,
  representativeId: string,
): Promise<boolean> {
  if (!isSalesRole(role)) return false;
  const ownRepresentative = await resolveRepresentativeForOwnerUserId(userId);
  return ownRepresentative.representativeId === representativeId;
}

export async function canReadRepresentativeReport(
  userId: string,
  role: string,
  representativeId: string,
): Promise<boolean> {
  if (role === "ADMIN") return true;
  if (await canAccessOwnRepresentativeReport(userId, role, representativeId)) return true;
  if (role !== "REGIONAL_MANAGER") return false;

  const manager = await prisma.crmRegionManager.findUnique({
    where: { userId: userId, archived: false },
    include: { reps: { where: { representativeId }, select: { id: true } } },
  });
  return Boolean(manager && manager.reps.length > 0);
}
