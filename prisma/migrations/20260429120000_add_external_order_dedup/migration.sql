-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- Add dedup columns to ExternalOrder
CREATE TABLE "new_ExternalOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "platform" TEXT,
    "externalOrderNo" TEXT NOT NULL,
    "merchantOrderNo" TEXT,
    "storeName" TEXT,
    "orderType" TEXT,
    "receiverName" TEXT,
    "receiverPhone" TEXT,
    "receiverAddress" TEXT,
    "orderUser" TEXT,
    "orderUserTags" TEXT,
    "productNamesRaw" TEXT,
    "productNamesJson" TEXT,
    "itemCount" INTEGER,
    "itemTypeCount" INTEGER,
    "orderAt" DATETIME,
    "paidAt" DATETIME,
    "scheduledDeliveryText" TEXT,
    "sellerMessage" TEXT,
    "merchantRemark" TEXT,
    "formNote" TEXT,
    "grossAmount" REAL,
    "priceAdjustment" REAL,
    "paidAmount" REAL,
    "shippingFee" REAL,
    "importBatchId" TEXT NOT NULL,
    "rawJson" TEXT,
    "invoiceStatus" TEXT NOT NULL DEFAULT 'NONE',
    "duplicateGroupId" TEXT,
    "duplicateStatus" TEXT NOT NULL DEFAULT 'UNREVIEWED',
    "mergedIntoId" TEXT,
    "reviewNote" TEXT,
    "reviewedAt" DATETIME,
    "reviewedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExternalOrder_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ExternalOrderImportBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExternalOrder_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "ExternalOrder" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ExternalOrder_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_ExternalOrder" (
    "id", "source", "platform", "externalOrderNo", "merchantOrderNo", "storeName", "orderType",
    "receiverName", "receiverPhone", "receiverAddress", "orderUser", "orderUserTags",
    "productNamesRaw", "productNamesJson", "itemCount", "itemTypeCount", "orderAt", "paidAt",
    "scheduledDeliveryText", "sellerMessage", "merchantRemark", "formNote",
    "grossAmount", "priceAdjustment", "paidAmount", "shippingFee",
    "importBatchId", "rawJson", "invoiceStatus", "createdAt", "updatedAt"
)
SELECT
    "id", "source", "platform", "externalOrderNo", "merchantOrderNo", "storeName", "orderType",
    "receiverName", "receiverPhone", "receiverAddress", "orderUser", "orderUserTags",
    "productNamesRaw", "productNamesJson", "itemCount", "itemTypeCount", "orderAt", "paidAt",
    "scheduledDeliveryText", "sellerMessage", "merchantRemark", "formNote",
    "grossAmount", "priceAdjustment", "paidAmount", "shippingFee",
    "importBatchId", "rawJson", "invoiceStatus", "createdAt", "updatedAt"
FROM "ExternalOrder";

DROP TABLE "ExternalOrder";
ALTER TABLE "new_ExternalOrder" RENAME TO "ExternalOrder";

CREATE INDEX "ExternalOrder_externalOrderNo_idx" ON "ExternalOrder"("externalOrderNo");
CREATE INDEX "ExternalOrder_receiverPhone_idx" ON "ExternalOrder"("receiverPhone");
CREATE INDEX "ExternalOrder_orderAt_idx" ON "ExternalOrder"("orderAt");
CREATE INDEX "ExternalOrder_importBatchId_idx" ON "ExternalOrder"("importBatchId");
CREATE INDEX "ExternalOrder_duplicateStatus_idx" ON "ExternalOrder"("duplicateStatus");
CREATE INDEX "ExternalOrder_duplicateGroupId_idx" ON "ExternalOrder"("duplicateGroupId");
CREATE UNIQUE INDEX "ExternalOrder_source_externalOrderNo_key" ON "ExternalOrder"("source", "externalOrderNo");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
