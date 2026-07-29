import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

/**
 * T3.5: actor-aware project resource resolver + hot-project candidate query.
 */
describe("T3.5 project resource and hot-project consumers", () => {
  it("getProjectResourceForActor and listHotProjectCandidatesForActor enforce scope", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { getProjectResourceForActor } = await import(
        "@/lib/projects/application/get-project-resource"
      );
      const { listHotProjectCandidatesForActor } = await import(
        "@/lib/projects/application/query-hot-project-candidates"
      );
      const { NotFoundError } = await import("@/lib/application/errors");

      const userA = await prisma.user.create({
        data: { email: "t35-a@example.com", name: "UserA", password: "h", role: "USER" },
      });
      const userB = await prisma.user.create({
        data: { email: "t35-b@example.com", name: "UserB", password: "h", role: "USER" },
      });

      const owned = await prisma.project.create({
        data: {
          name: "Owned Project",
          status: "IN_PROGRESS",
          members: { create: { userId: userA.id, role: "OWNER" } },
        },
      });
      const other = await prisma.project.create({
        data: {
          name: "Other Project",
          status: "IN_PROGRESS",
          members: { create: { userId: userB.id, role: "OWNER" } },
        },
      });
      await prisma.project.create({
        data: {
          name: "Completed Owned",
          status: "COMPLETED",
          members: { create: { userId: userA.id, role: "OWNER" } },
        },
      });

      const actorA = { userId: userA.id, role: "USER" };
      const resource = await getProjectResourceForActor(actorA, owned.id);
      expect(resource).toEqual({ id: owned.id, name: "Owned Project" });

      await expect(getProjectResourceForActor(actorA, other.id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(getProjectResourceForActor(actorA, "nonexistent-id")).rejects.toBeInstanceOf(
        NotFoundError,
      );

      const hotRows = await listHotProjectCandidatesForActor(actorA);
      expect(hotRows.map((r) => r.id)).toEqual([owned.id]);
    });
  });
});
