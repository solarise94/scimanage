import { describe, expect, it, vi } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent" },
});

/**
 * T3.3: actor-aware project note list/add shared by Agent get_notes / add_note.
 */
describe("T3.3 project note services", () => {
  it("enforces list scope, creates notes with activity log, blocks REP via Agent", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const {
        listProjectNotesForActor,
        addProjectNoteForActor,
        previewAddProjectNoteForActor,
      } = await import("@/lib/projects/application/project-notes");
      const {
        ForbiddenError,
        NotFoundError,
      } = await import("@/lib/application/errors");
      const { buildInvocationContext } = await import("@/lib/application/actor");
      const { executeAgentAction, getAgentAction } = await import("@/lib/agent-actions/registry");
      const { registerProjectActions } = await import("@/lib/agent-actions/actions/projects");

      registerProjectActions();

      const admin = await prisma.user.create({
        data: { email: "t33-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const userA = await prisma.user.create({
        data: { email: "t33-usera@example.com", name: "UserA", password: "h", role: "USER" },
      });
      const userB = await prisma.user.create({
        data: { email: "t33-userb@example.com", name: "UserB", password: "h", role: "USER" },
      });
      const repUser = await prisma.user.create({
        data: { email: "t33-rep@example.com", name: "RepUser", password: "h", role: "REPRESENTATIVE" },
      });

      const adminActor = { userId: admin.id, role: "ADMIN", name: "Admin" };
      const userAActor = { userId: userA.id, role: "USER", name: "UserA" };
      const userBActor = { userId: userB.id, role: "USER", name: "UserB" };
      const repActor = { userId: repUser.id, role: "REPRESENTATIVE", name: "RepUser" };

      const project = await prisma.project.create({
        data: {
          name: "Note 测试项目",
          status: "IN_PROGRESS",
          technicalOwnerUserId: userA.id,
          members: { create: { userId: userA.id, role: "OWNER" } },
        },
      });

      await prisma.projectNote.create({
        data: {
          projectId: project.id,
          authorId: userA.id,
          authorNameSnapshot: "UserA",
          category: "GENERAL",
          content: "已有备注",
          visibility: "INTERNAL",
          source: "WEB",
        },
      });

      const listA = await listProjectNotesForActor(userAActor, { projectId: project.id, limit: 10 });
      expect(listA.items).toHaveLength(1);
      expect(listA.items[0]?.content).toBe("已有备注");
      expect(listA.nextCursor).toBeNull();

      await expect(
        listProjectNotesForActor(userBActor, { projectId: project.id, limit: 10 }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      await expect(
        listProjectNotesForActor(adminActor, { projectId: "missing-project", limit: 10 }),
      ).rejects.toBeInstanceOf(NotFoundError);

      const invocation = buildInvocationContext({ channel: "agent" });
      const added = await addProjectNoteForActor(userAActor, invocation, {
        projectId: project.id,
        content: "新备注一条",
        category: "RISK",
        attachments: [],
      });
      expect(added.note.content).toBe("新备注一条");
      expect(added.note.category).toBe("RISK");
      expect(added.attachments).toEqual([]);
      expect(added.partialFailures).toEqual([]);

      const log = await prisma.activityLog.findFirst({
        where: { projectId: project.id, type: "PROJECT_NOTE_ADDED" },
        orderBy: { createdAt: "desc" },
      });
      expect(log).toBeTruthy();
      expect(log?.content).toBe("添加了项目备注");

      const listAfterAdd = await listProjectNotesForActor(userAActor, { projectId: project.id, limit: 10 });
      expect(listAfterAdd.items.some((n) => n.content === "新备注一条")).toBe(true);

      // canonical command/preview must own the contribute gate (not rely on the Agent adapter)
      await expect(
        addProjectNoteForActor(userBActor, invocation, {
          projectId: project.id,
          content: "越权写入",
          category: "GENERAL",
          attachments: [],
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        previewAddProjectNoteForActor(userBActor, {
          projectId: project.id,
          content: "越权预览",
          category: "GENERAL",
          attachments: [],
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // TOCTOU: membership revoked after the pre-tx gate passed but before the
      // write transaction — the in-tx re-check must reject and nothing may be
      // persisted (no ProjectNote, no PROJECT_NOTE_ADDED log).
      const notesBefore = await prisma.projectNote.count({
        where: { projectId: project.id },
      });
      const logsBefore = await prisma.activityLog.count({
        where: { projectId: project.id, type: "PROJECT_NOTE_ADDED" },
      });
      const origTx = prisma.$transaction.bind(prisma);
      const txSpy = vi
        .spyOn(prisma, "$transaction")
        .mockImplementationOnce((async (...args: unknown[]) => {
          // Revoke userA's membership exactly at the write-transaction boundary.
          await prisma.projectMember.deleteMany({
            where: { projectId: project.id, userId: userA.id },
          });
          return origTx(...(args as Parameters<typeof prisma.$transaction>));
        }) as unknown as typeof prisma.$transaction);
      try {
        await expect(
          addProjectNoteForActor(userAActor, invocation, {
            projectId: project.id,
            content: "竞态写入",
            category: "GENERAL",
            attachments: [],
          }),
        ).rejects.toBeInstanceOf(ForbiddenError);
      } finally {
        txSpy.mockRestore();
        // Restore membership for the Agent parity assertions below.
        await prisma.projectMember.create({
          data: { projectId: project.id, userId: userA.id, role: "OWNER" },
        });
      }
      expect(await prisma.projectNote.count({ where: { projectId: project.id } })).toBe(
        notesBefore,
      );
      expect(
        await prisma.activityLog.count({
          where: { projectId: project.id, type: "PROJECT_NOTE_ADDED" },
        }),
      ).toBe(logsBefore);

      const addNoteAction = getAgentAction("projects.add_note")!;
      expect(await addNoteAction.availability(repActor)).toBe(false);

      await expect(
        executeAgentAction(agentExecCtx(repActor), "projects.add_note", {
          projectId: project.id,
          content: "代表不能加",
          category: "GENERAL",
        }),
      ).rejects.toMatchObject({ status: 403 });

      const agentList = await executeAgentAction<{ items: Array<{ content: string }> }>(
        agentExecCtx(userAActor),
        "projects.get_notes",
        { projectId: project.id, limit: 10 },
      );
      expect(agentList.result.items.some((n) => n.content === "新备注一条")).toBe(true);
    });
  }, 120_000);
});
