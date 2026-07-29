import { beforeEach, describe, expect, it, vi } from "vitest";

const { getReadableProjectIds } = vi.hoisted(() => ({
  getReadableProjectIds: vi.fn(),
}));

vi.mock("@/lib/permissions", () => ({
  getReadableProjectIds,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    agentEntityMemory: {
      findMany: vi.fn(),
    },
  },
}));

import { filterEntityMemoriesForActor } from "@/lib/agent-runtime/entity-memory-access";

const INTERNAL_NOTE_METADATA = JSON.stringify({
  containsInternalProjectNotes: true,
});

describe("filterEntityMemoriesForActor", () => {
  beforeEach(() => {
    getReadableProjectIds.mockReset();
  });

  it("removes project memories outside the actor's current project scope", async () => {
    getReadableProjectIds.mockResolvedValue(["project-readable"]);

    const result = await filterEntityMemoriesForActor(
      { userId: "user-1", role: "USER" },
      [
        { entityType: "project", entityId: "project-readable" },
        { entityType: "project", entityId: "project-hidden" },
        { entityType: "customer", entityId: "customer-1" },
      ],
    );

    expect(result).toEqual([
      { entityType: "project", entityId: "project-readable" },
      { entityType: "customer", entityId: "customer-1" },
    ]);
  });

  it("hides internal-note project summaries from sales roles", async () => {
    getReadableProjectIds.mockResolvedValue(["project-1"]);

    const result = await filterEntityMemoriesForActor(
      { userId: "rep-1", role: "REPRESENTATIVE" },
      [
        {
          entityType: "project",
          entityId: "project-1",
          metadataJson: INTERNAL_NOTE_METADATA,
        },
        {
          entityType: "project",
          entityId: "project-1",
          metadataJson: null,
        },
      ],
    );

    expect(result).toEqual([
      {
        entityType: "project",
        entityId: "project-1",
        metadataJson: null,
      },
    ]);
  });

  it("allows admins to use internal-note summaries", async () => {
    getReadableProjectIds.mockResolvedValue(null);
    const memory = {
      entityType: "project",
      entityId: "project-1",
      metadataJson: INTERNAL_NOTE_METADATA,
    };

    const result = await filterEntityMemoriesForActor(
      { userId: "admin-1", role: "ADMIN" },
      [memory],
    );

    expect(result).toEqual([memory]);
  });

  it("fails closed for project memories when scope lookup fails", async () => {
    getReadableProjectIds.mockRejectedValue(new Error("database unavailable"));

    const result = await filterEntityMemoriesForActor(
      { userId: "user-1", role: "USER" },
      [
        { entityType: "project", entityId: "project-1" },
        { entityType: "customer", entityId: "customer-1" },
      ],
    );

    expect(result).toEqual([
      { entityType: "customer", entityId: "customer-1" },
    ]);
  });
});
