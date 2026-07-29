export interface VariableDef {
  key: string; // 占位符名，如 "sellerName"
  label: string; // 中文名，如"卖方名称"
  type: "text" | "money" | "date" | "lines" | "amountInWords";
  source: string; // 取数来源说明
  required?: boolean; // 是否必填
}

// 固定变量字典——所有合法占位符
export const TEMPLATE_VARIABLES: VariableDef[] = [
  // === 卖方（收款方，来自 BillingProfile）===
  {
    key: "sellerName",
    label: "卖方名称",
    type: "text",
    source: "BillingProfile.name",
    required: true,
  },
  {
    key: "sellerTaxId",
    label: "卖方税号",
    type: "text",
    source: "BillingProfile.taxId",
  },
  {
    key: "sellerBankName",
    label: "卖方开户行",
    type: "text",
    source: "BillingProfile.bankName",
  },
  {
    key: "sellerBankAccount",
    label: "卖方银行账号",
    type: "text",
    source: "BillingProfile.bankAccount",
  },
  {
    key: "sellerAddress",
    label: "卖方地址",
    type: "text",
    source: "BillingProfile.address",
  },
  {
    key: "sellerPhone",
    label: "卖方电话",
    type: "text",
    source: "BillingProfile.phone",
  },
  {
    key: "sellerLegalRepresentative",
    label: "卖方法定代表人",
    type: "text",
    source: "BillingProfile.legalRepresentative",
  },

  // === 买方（付款方，来自 Customer/Organization + 可手填）===
  {
    key: "buyerName",
    label: "买方名称",
    type: "text",
    source: "CrmCustomerProfile.name / Order.buyerNameSnapshot",
    required: true,
  },
  {
    key: "buyerOrgName",
    label: "买方单位",
    type: "text",
    source: "Organization.canonicalName / Order.buyerOrgNameSnapshot",
    required: true,
  },
  {
    key: "buyerTaxId",
    label: "买方税号",
    type: "text",
    source: "Organization.taxId",
  },
  {
    key: "buyerAddress",
    label: "买方地址",
    type: "text",
    source: "Organization.address / Order.buyerAddressSnapshot",
  },
  {
    key: "buyerPhone",
    label: "买方电话",
    type: "text",
    source: "Order.buyerPhoneSnapshot",
  },
  {
    key: "buyerEmail",
    label: "买方邮箱",
    type: "text",
    source: "CrmCustomerProfile.email",
  },

  // === 合同主体 ===
  {
    key: "contractNo",
    label: "合同编号",
    type: "text",
    source: "系统生成（如 HT-20260624-xxxx）",
    required: true,
  },
  {
    key: "totalAmount",
    label: "合同总金额",
    type: "money",
    source: "Order.totalAmount（元，保留2位小数）",
    required: true,
  },
  {
    key: "totalAmountInWords",
    label: "合同总金额大写",
    type: "amountInWords",
    source: "由 totalAmount 转换",
  },
  {
    key: "signingDate",
    label: "签订日期",
    type: "date",
    source: "生成当天（YYYY年MM月DD日）",
  },

  // === 行项目明细（循环块）===
  {
    key: "lines",
    label: "行项目明细",
    type: "lines",
    source: "Order.lines[]",
    required: true,
  },
];

// 用于快速查找
export const VARIABLE_KEYS = new Set(TEMPLATE_VARIABLES.map((v) => v.key));
export const VARIABLE_MAP = new Map(
  TEMPLATE_VARIABLES.map((v) => [v.key, v])
);

// lines 循环块内合法子变量
export const LINES_CHILD_KEYS = new Set([
  "index",
  "itemName",
  "spec",
  "quantity",
  "unit",
  "unitPrice",
  "amount",
]);
