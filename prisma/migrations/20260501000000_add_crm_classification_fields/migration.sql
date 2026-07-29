-- CrmCustomerProfile: add personCategory, jobTitle, graduationDate, graduationReminderAt
ALTER TABLE "CrmCustomerProfile" ADD COLUMN "personCategory" TEXT;
ALTER TABLE "CrmCustomerProfile" ADD COLUMN "jobTitle" TEXT;
ALTER TABLE "CrmCustomerProfile" ADD COLUMN "graduationDate" DATETIME;
ALTER TABLE "CrmCustomerProfile" ADD COLUMN "graduationReminderAt" DATETIME;
CREATE INDEX "CrmCustomerProfile_personCategory_idx" ON "CrmCustomerProfile"("personCategory");
CREATE INDEX "CrmCustomerProfile_graduationDate_idx" ON "CrmCustomerProfile"("graduationDate");

-- Customer: add labOrGroup
ALTER TABLE "Customer" ADD COLUMN "labOrGroup" TEXT;

-- OrganizationSite: add siteType, parentSiteId
ALTER TABLE "OrganizationSite" ADD COLUMN "siteType" TEXT NOT NULL DEFAULT 'CAMPUS';
ALTER TABLE "OrganizationSite" ADD COLUMN "parentSiteId" TEXT;
CREATE INDEX "OrganizationSite_siteType_idx" ON "OrganizationSite"("siteType");
CREATE INDEX "OrganizationSite_parentSiteId_idx" ON "OrganizationSite"("parentSiteId");
