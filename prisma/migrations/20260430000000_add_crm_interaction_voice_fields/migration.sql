-- AlterTable: add voice fields to CrmInteraction
CREATE TABLE "new_CrmInteraction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "detail" TEXT,
    "happenedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextActionAt" DATETIME,
    "relatedProjectId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "voiceUrl" TEXT,
    "transcript" TEXT,
    "summaryTitle" TEXT,
    "summaryNote" TEXT,
    "asrStatus" TEXT NOT NULL DEFAULT 'NONE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CrmInteraction_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CrmCustomerProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CrmInteraction_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_CrmInteraction" (
    "id", "profileId", "type", "summary", "detail", "happenedAt", "nextActionAt",
    "relatedProjectId", "createdByUserId", "createdAt", "updatedAt"
)
SELECT
    "id", "profileId", "type", "summary", "detail", "happenedAt", "nextActionAt",
    "relatedProjectId", "createdByUserId", "createdAt", "updatedAt"
FROM "CrmInteraction";

DROP TABLE "CrmInteraction";
ALTER TABLE "new_CrmInteraction" RENAME TO "CrmInteraction";

CREATE INDEX "CrmInteraction_profileId_happenedAt_idx" ON "CrmInteraction"("profileId", "happenedAt");
CREATE INDEX "CrmInteraction_asrStatus_idx" ON "CrmInteraction"("asrStatus");
