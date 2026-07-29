-- CreateTable
CREATE TABLE "ExternalOrderInvoiceCoverage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceRequestId" TEXT NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExternalOrderInvoiceCoverage_invoiceRequestId_fkey" FOREIGN KEY ("invoiceRequestId") REFERENCES "ExternalOrderInvoiceRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExternalOrderInvoiceCoverage_externalOrderId_fkey" FOREIGN KEY ("externalOrderId") REFERENCES "ExternalOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalOrderInvoiceCoverage_invoiceRequestId_externalOrderId_key" ON "ExternalOrderInvoiceCoverage"("invoiceRequestId", "externalOrderId");

-- CreateIndex
CREATE INDEX "ExternalOrderInvoiceCoverage_externalOrderId_idx" ON "ExternalOrderInvoiceCoverage"("externalOrderId");

-- CreateIndex
CREATE INDEX "ExternalOrderInvoiceCoverage_invoiceRequestId_idx" ON "ExternalOrderInvoiceCoverage"("invoiceRequestId");
