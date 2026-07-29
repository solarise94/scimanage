-- AlterTable: add finance classification fields to ExternalOrder
ALTER TABLE "ExternalOrder" ADD COLUMN "financeCategory" TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "ExternalOrder" ADD COLUMN "financeTreatment" TEXT NOT NULL DEFAULT 'AUTO';
ALTER TABLE "ExternalOrder" ADD COLUMN "financeAmountOverride" REAL;
ALTER TABLE "ExternalOrder" ADD COLUMN "financeNote" TEXT;
