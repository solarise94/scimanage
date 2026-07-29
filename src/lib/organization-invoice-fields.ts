import { lookupOrgByName } from "@/lib/invoice-org-api";

export type OrganizationInvoiceFieldInput = {
  taxId?: string | null;
  isInvoiceSubject?: boolean;
  invoiceAddress?: string | null;
  invoicePhone?: string | null;
  invoiceBankName?: string | null;
  invoiceBankAccount?: string | null;
};

export type OrganizationInvoiceFieldPatch = {
  taxId?: string | null;
  isInvoiceSubject?: boolean;
  invoiceAddress?: string | null;
  invoicePhone?: string | null;
  invoiceBankName?: string | null;
  invoiceBankAccount?: string | null;
  taxIdVerifySource?: string | null;
  taxIdVerifiedAt?: Date | null;
};

/**
 * 税号变更时推导开票主体与四要素（POST/PATCH 共用，避免逻辑漂移）。
 * 有税号时 isInvoiceSubject 恒为 true，调用方显式 false 不能覆盖。
 */
export async function buildOrganizationInvoiceFieldsOnTaxIdChange(params: {
  taxId?: string | null;
  isInvoiceSubject?: boolean;
  invoiceAddress?: string | null;
  invoicePhone?: string | null;
  invoiceBankName?: string | null;
  invoiceBankAccount?: string | null;
  lookupName: string;
  existingTaxId?: string | null;
  isCreate?: boolean;
}): Promise<OrganizationInvoiceFieldPatch> {
  const patch: OrganizationInvoiceFieldPatch = {};

  const resolvedTaxId = params.taxId !== undefined ? (params.taxId?.trim() || null) : undefined;
  const taxIdChanged = resolvedTaxId !== undefined
    && resolvedTaxId !== (params.existingTaxId?.trim() || null);

  if (params.invoiceAddress !== undefined) {
    patch.invoiceAddress = params.invoiceAddress?.trim() || null;
  }
  if (params.invoicePhone !== undefined) {
    patch.invoicePhone = params.invoicePhone?.trim() || null;
  }
  if (params.invoiceBankName !== undefined) {
    patch.invoiceBankName = params.invoiceBankName?.trim() || null;
  }
  if (params.invoiceBankAccount !== undefined) {
    patch.invoiceBankAccount = params.invoiceBankAccount?.trim() || null;
  }

  if (resolvedTaxId !== undefined) {
    patch.taxId = resolvedTaxId;

    if (resolvedTaxId) {
      patch.isInvoiceSubject = true;
      patch.taxIdVerifySource = "MANUAL";

      const shouldLookupApi = params.isCreate || taxIdChanged;
      if (shouldLookupApi) {
        try {
          const results = await lookupOrgByName(params.lookupName);
          const match = results.find((r) => r.unitTaxNo === resolvedTaxId);
          if (match) {
            patch.invoiceAddress = match.unitAddress || null;
            patch.invoicePhone = match.unitPhone || null;
            patch.invoiceBankName = match.bankName || null;
            patch.invoiceBankAccount = match.bankNo || null;
            patch.taxIdVerifiedAt = new Date();
            patch.taxIdVerifySource = "API";
          } else if (taxIdChanged) {
            patch.taxIdVerifiedAt = null;
          }
        } catch {
          if (taxIdChanged) {
            patch.taxIdVerifiedAt = null;
          }
        }
      }
    } else if (params.isInvoiceSubject !== undefined) {
      patch.isInvoiceSubject = params.isInvoiceSubject;
    }
  } else if (params.isInvoiceSubject !== undefined) {
    patch.isInvoiceSubject = params.isInvoiceSubject;
  }

  return patch;
}
