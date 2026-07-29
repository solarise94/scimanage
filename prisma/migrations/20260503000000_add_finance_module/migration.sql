-- AlterTable: add finance fields to ExternalOrder
ALTER TABLE "ExternalOrder" ADD COLUMN "projectId" TEXT;
ALTER TABLE "ExternalOrder" ADD COLUMN "customerMatchStatus" TEXT NOT NULL DEFAULT 'UNMATCHED';
ALTER TABLE "ExternalOrder" ADD COLUMN "customerMatchScore" REAL;
ALTER TABLE "ExternalOrder" ADD COLUMN "customerMatchReason" TEXT;

-- CreateTable: FinanceReceipt
CREATE TABLE "FinanceReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT,
    "projectId" TEXT,
    "externalOrderId" TEXT,
    "projectInvoiceId" TEXT,
    "externalOrderInvoiceRequestId" TEXT,
    "amount" REAL NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "remark" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FinanceReceipt_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FinanceReceipt_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FinanceReceipt_externalOrderId_fkey" FOREIGN KEY ("externalOrderId") REFERENCES "ExternalOrder" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FinanceReceipt_projectInvoiceId_fkey" FOREIGN KEY ("projectInvoiceId") REFERENCES "ProjectInvoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FinanceReceipt_externalOrderInvoiceRequestId_fkey" FOREIGN KEY ("externalOrderInvoiceRequestId") REFERENCES "ExternalOrderInvoiceRequest" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FinanceReceipt_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ExternalOrder_projectId_idx" ON "ExternalOrder"("projectId");
CREATE INDEX "ExternalOrder_customerMatchStatus_idx" ON "ExternalOrder"("customerMatchStatus");
CREATE INDEX "FinanceReceipt_customerId_idx" ON "FinanceReceipt"("customerId");
CREATE INDEX "FinanceReceipt_projectId_idx" ON "FinanceReceipt"("projectId");
CREATE INDEX "FinanceReceipt_externalOrderId_idx" ON "FinanceReceipt"("externalOrderId");
CREATE INDEX "FinanceReceipt_receivedAt_idx" ON "FinanceReceipt"("receivedAt");
