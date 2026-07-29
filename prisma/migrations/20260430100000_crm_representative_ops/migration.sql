-- AlterTable: add assignment fields to CrmCustomerProfile
CREATE TABLE "new_CrmCustomerProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceCustomerId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'NEW',
    "importance" TEXT NOT NULL DEFAULT 'NORMAL',
    "tagsJson" TEXT,
    "summary" TEXT,
    "lastFollowUpAt" DATETIME,
    "nextFollowUpAt" DATETIME,
    "lastOrderAt" DATETIME,
    "assignmentStatus" TEXT NOT NULL DEFAULT 'ASSIGNED',
    "assignedAt" DATETIME,
    "assignedByUserId" TEXT,
    "recalledAt" DATETIME,
    "recalledByUserId" TEXT,
    "reflowReason" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CrmCustomerProfile_sourceCustomerId_fkey" FOREIGN KEY ("sourceCustomerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CrmCustomerProfile_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CrmCustomerProfile_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CrmCustomerProfile_recalledByUserId_fkey" FOREIGN KEY ("recalledByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_CrmCustomerProfile" (
    "id", "sourceCustomerId", "ownerUserId", "stage", "importance",
    "tagsJson", "summary", "lastFollowUpAt", "nextFollowUpAt", "lastOrderAt",
    "archived", "createdAt", "updatedAt"
)
SELECT
    "id", "sourceCustomerId", "ownerUserId", "stage", "importance",
    "tagsJson", "summary", "lastFollowUpAt", "nextFollowUpAt", "lastOrderAt",
    "archived", "createdAt", "updatedAt"
FROM "CrmCustomerProfile";

DROP TABLE "CrmCustomerProfile";
ALTER TABLE "new_CrmCustomerProfile" RENAME TO "CrmCustomerProfile";

CREATE UNIQUE INDEX "CrmCustomerProfile_sourceCustomerId_key" ON "CrmCustomerProfile"("sourceCustomerId");
CREATE INDEX "CrmCustomerProfile_ownerUserId_idx" ON "CrmCustomerProfile"("ownerUserId");
CREATE INDEX "CrmCustomerProfile_stage_idx" ON "CrmCustomerProfile"("stage");
CREATE INDEX "CrmCustomerProfile_nextFollowUpAt_idx" ON "CrmCustomerProfile"("nextFollowUpAt");
CREATE INDEX "CrmCustomerProfile_assignmentStatus_idx" ON "CrmCustomerProfile"("assignmentStatus");

-- CreateTable: CrmRegionManager
CREATE TABLE "CrmRegionManager" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "regionName" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CrmRegionManager_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CrmRegionManager_userId_key" ON "CrmRegionManager"("userId");

-- CreateTable: CrmRegionManagerRepresentative
CREATE TABLE "CrmRegionManagerRepresentative" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "managerId" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "assignedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CrmRegionManagerRepresentative_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "CrmRegionManager" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CrmRegionManagerRepresentative_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CrmRegionManagerRepresentative_managerId_representativeId_key" ON "CrmRegionManagerRepresentative"("managerId", "representativeId");
CREATE INDEX "CrmRegionManagerRepresentative_representativeId_idx" ON "CrmRegionManagerRepresentative"("representativeId");

-- CreateTable: CrmCustomerAssignmentLog
CREATE TABLE "CrmCustomerAssignmentLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL,
    "fromOwnerUserId" TEXT,
    "toOwnerUserId" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CrmCustomerAssignmentLog_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CrmCustomerProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CrmCustomerAssignmentLog_fromOwnerUserId_fkey" FOREIGN KEY ("fromOwnerUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CrmCustomerAssignmentLog_toOwnerUserId_fkey" FOREIGN KEY ("toOwnerUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CrmCustomerAssignmentLog_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "CrmCustomerAssignmentLog_profileId_idx" ON "CrmCustomerAssignmentLog"("profileId");
CREATE INDEX "CrmCustomerAssignmentLog_createdAt_idx" ON "CrmCustomerAssignmentLog"("createdAt");
