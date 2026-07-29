export interface InvoiceSheetItem {
  itemName: string;
  spec: string | null;
  unit: string | null;
  quantity: number | null;
  amount: number;
}

export interface InvoiceSheetData {
  contactName: string | null;
  projectCode: string | null;
  invoiceType: "NORMAL" | "SPECIAL";
  sellerName: string | null;
  sellerTaxId: string | null;
  sellerBankName: string | null;
  sellerBankAccount: string | null;
  sellerAddress: string | null;
  sellerPhone: string | null;
  buyerOrganizationName: string;
  buyerTaxId: string | null;
  contentSummary: string | null;
  items: InvoiceSheetItem[];
  totalAmount: number;
  remark: string | null;
  status: string | null;
  createdAt: string | null;
  createdByName: string | null;
}

export function sheetDataFromForm(form: {
  contactName: string;
  projectCode: string;
  sellerName: string;
  sellerTaxId: string;
  sellerBankName: string;
  sellerBankAccount: string;
  sellerAddress?: string;
  sellerPhone?: string;
  buyerOrgName: string;
  buyerTaxId: string;
  invoiceType: string;
  contentSummary: string;
  remark: string;
  items: Array<{ itemName: string; spec: string; unit: string; quantity: string; amount: string }>;
}): InvoiceSheetData {
  const items: InvoiceSheetItem[] = form.items
    .filter((it) => it.itemName.trim())
    .map((it) => ({
      itemName: it.itemName,
      spec: it.spec || null,
      unit: it.unit || null,
      quantity: it.quantity ? parseFloat(it.quantity) || null : null,
      amount: parseFloat(it.amount) || 0,
    }));

  return {
    contactName: form.contactName || null,
    projectCode: form.projectCode || null,
    invoiceType: form.invoiceType === "SPECIAL" ? "SPECIAL" : "NORMAL",
    sellerName: form.sellerName || null,
    sellerTaxId: form.sellerTaxId || null,
    sellerBankName: form.sellerBankName || null,
    sellerBankAccount: form.sellerBankAccount || null,
    sellerAddress: form.sellerAddress || null,
    sellerPhone: form.sellerPhone || null,
    buyerOrganizationName: form.buyerOrgName,
    buyerTaxId: form.buyerTaxId || null,
    contentSummary: form.contentSummary || null,
    items,
    totalAmount: items.reduce((s, it) => s + it.amount, 0),
    remark: form.remark || null,
    status: null,
    createdAt: null,
    createdByName: null,
  };
}

export function sheetDataFromRecord(inv: {
  contactName: string | null;
  projectCode: string | null;
  sellerName: string | null;
  sellerTaxId: string | null;
  sellerBankName: string | null;
  sellerBankAccount: string | null;
  sellerAddress: string | null;
  sellerPhone: string | null;
  buyerOrganizationName: string;
  buyerTaxId: string | null;
  invoiceType: string;
  contentSummary: string | null;
  totalAmount: number;
  status: string;
  remark: string | null;
  createdAt: string;
  createdBy: { name: string };
  items: Array<{
    itemName: string;
    spec: string | null;
    unit: string | null;
    quantity: number | null;
    amount: number;
  }>;
}): InvoiceSheetData {
  return {
    contactName: inv.contactName,
    projectCode: inv.projectCode,
    invoiceType: inv.invoiceType === "SPECIAL" ? "SPECIAL" : "NORMAL",
    sellerName: inv.sellerName,
    sellerTaxId: inv.sellerTaxId,
    sellerBankName: inv.sellerBankName,
    sellerBankAccount: inv.sellerBankAccount,
    sellerAddress: inv.sellerAddress,
    sellerPhone: inv.sellerPhone,
    buyerOrganizationName: inv.buyerOrganizationName,
    buyerTaxId: inv.buyerTaxId,
    contentSummary: inv.contentSummary,
    items: inv.items.map((it) => ({
      itemName: it.itemName,
      spec: it.spec,
      unit: it.unit,
      quantity: it.quantity,
      amount: it.amount,
    })),
    totalAmount: inv.totalAmount,
    remark: inv.remark,
    status: inv.status,
    createdAt: inv.createdAt,
    createdByName: inv.createdBy.name,
  };
}
