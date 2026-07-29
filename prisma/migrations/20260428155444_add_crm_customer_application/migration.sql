-- CreateTable
CREATE TABLE "CrmCustomerApplication" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "principal" TEXT,
    "email" TEXT,
    "wechat" TEXT,
    "organization" TEXT,
    "organizationId" TEXT,
    "organizationSiteId" TEXT,
    "address" TEXT,
    "miniProgramId" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "submittedByUserId" TEXT NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewedAt" DATETIME,
    "reviewNote" TEXT,
    "createdCustomerId" TEXT,
    "createdCrmProfileId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CrmCustomerApplication_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CrmCustomerApplication_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CrmCustomerApplication_createdCustomerId_fkey" FOREIGN KEY ("createdCustomerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CrmCustomerApplication_createdCrmProfileId_fkey" FOREIGN KEY ("createdCrmProfileId") REFERENCES "CrmCustomerProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CrmCustomerApplication_submittedByUserId_idx" ON "CrmCustomerApplication"("submittedByUserId");

-- CreateIndex
CREATE INDEX "CrmCustomerApplication_status_idx" ON "CrmCustomerApplication"("status");
