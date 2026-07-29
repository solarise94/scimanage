-- AlterTable CrmVisitCheckin: add voice/ASR fields
ALTER TABLE "CrmVisitCheckin" ADD COLUMN "voiceUrl" TEXT;
ALTER TABLE "CrmVisitCheckin" ADD COLUMN "transcript" TEXT;
ALTER TABLE "CrmVisitCheckin" ADD COLUMN "summaryTitle" TEXT;
ALTER TABLE "CrmVisitCheckin" ADD COLUMN "summary" TEXT;
ALTER TABLE "CrmVisitCheckin" ADD COLUMN "asrStatus" TEXT NOT NULL DEFAULT 'NONE';
CREATE INDEX "CrmVisitCheckin_asrStatus_idx" ON "CrmVisitCheckin"("asrStatus");
