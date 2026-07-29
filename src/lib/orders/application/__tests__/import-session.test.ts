import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

describe("import-session application (T2.4)", () => {
  it("update draft / resume require ADMIN owner; version conflict blocks overwrite", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const {
        updateImportRowDraftForActor,
        resumeImportSessionForActor,
      } = await import("@/lib/orders/application/import-session");
      const { ForbiddenError, ConflictError, NotFoundError } = await import(
        "@/lib/application/errors"
      );

      const admin = await prisma.user.create({
        data: { email: "t24-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const other = await prisma.user.create({
        data: { email: "t24-other@example.com", name: "Other", password: "h", role: "ADMIN" },
      });
      const user = await prisma.user.create({
        data: { email: "t24-user@example.com", name: "User", password: "h", role: "USER" },
      });

      const session = await prisma.orderImportSession.create({
        data: {
          createdById: admin.id,
          status: "OPEN",
          source: "OTHER_IMPORT",
          parserKey: "ORDER_GENERIC",
          fileName: "t24.csv",
        },
      });
      const row = await prisma.orderImportRow.create({
        data: {
          sessionId: session.id,
          rowNo: 0,
          reviewStatus: "NO_MATCH",
          version: 1,
          rawPayloadJson: JSON.stringify({ col: "x" }),
          normalizedPayloadJson: JSON.stringify({
            externalOrderNo: "EXT-1",
            receiverName: "甲",
            productNamesRaw: "测序",
            paidAmount: 100,
          }),
          fieldProvenanceJson: JSON.stringify({ externalOrderNo: "FILE" }),
        },
      });

      const adminActor = { userId: admin.id, role: "ADMIN", name: "Admin", email: admin.email };
      const userActor = { userId: user.id, role: "USER", name: "User", email: user.email };
      const otherActor = { userId: other.id, role: "ADMIN", name: "Other", email: other.email };

      await expect(
        updateImportRowDraftForActor(userActor, {
          sessionId: session.id,
          rowId: row.id,
          expectedVersion: 1,
          patch: { receiverName: "乙" },
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      await expect(
        updateImportRowDraftForActor(otherActor, {
          sessionId: session.id,
          rowId: row.id,
          expectedVersion: 1,
          patch: { receiverName: "乙" },
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      const updated = await updateImportRowDraftForActor(adminActor, {
        sessionId: session.id,
        rowId: row.id,
        expectedVersion: 1,
        patch: { receiverName: "乙" },
        provenance: { receiverName: "USER_MESSAGE" },
      });
      expect(updated.version).toBe(2);
      expect(updated.appliedFields).toContain("receiverName");
      expect(updated.normalized.receiverName).toBe("乙");

      await expect(
        updateImportRowDraftForActor(adminActor, {
          sessionId: session.id,
          rowId: row.id,
          expectedVersion: 1,
          patch: { receiverName: "丙" },
        }),
      ).rejects.toBeInstanceOf(ConflictError);

      const resume = await resumeImportSessionForActor(adminActor, session.id);
      expect(resume.sessionStatus).toBe("OPEN");
      expect(resume.nextRowId).toBe(row.id);
      expect(resume.counts.total).toBe(1);
      expect(resume.hasPendingProposal).toBe(false);
    });
  }, 120_000);
});
