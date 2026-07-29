-- CreateTable
CREATE TABLE "ProcurementChannel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "ProcurementChannel_name_key" ON "ProcurementChannel"("name");

-- Backfill: seed distinct procurementSource values from existing projects
INSERT OR IGNORE INTO "ProcurementChannel" ("id", "name", "isDefault", "createdAt", "updatedAt")
SELECT
    lower(hex(randomblob(12))) AS "id",
    TRIM(p."procurementSource") AS "name",
    false AS "isDefault",
    datetime('now') AS "createdAt",
    datetime('now') AS "updatedAt"
FROM (
    SELECT DISTINCT "procurementSource"
    FROM "Project"
    WHERE "procurementSource" IS NOT NULL
      AND TRIM("procurementSource") != ''
) p;
