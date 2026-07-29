-- AlterTable: add customerId to ExternalOrder
ALTER TABLE "ExternalOrder" ADD COLUMN "customerId" TEXT REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "ExternalOrder_customerId_idx" ON "ExternalOrder"("customerId");
