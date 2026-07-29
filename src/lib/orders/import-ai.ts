export const ORDER_IMPORT_MAX_COLUMNS = 40;
export const ORDER_IMPORT_AI_CHUNK_COLUMNS = 20;
export const ORDER_IMPORT_MAX_ROWS_PER_AI_CHUNK = 200;
export const ORDER_IMPORT_MAX_CELLS_PER_REQUEST = 6000;

const KEY_COLUMNS = ["订单号", "姓名", "电话", "单位", "金额"];

export function chunkColumns(rawColumns: string[]): string[][] {
  if (rawColumns.length <= ORDER_IMPORT_AI_CHUNK_COLUMNS) return [rawColumns];

  const chunks: string[][] = [];
  for (let i = 0; i < rawColumns.length; i += ORDER_IMPORT_AI_CHUNK_COLUMNS) {
    const chunk = rawColumns.slice(i, i + ORDER_IMPORT_AI_CHUNK_COLUMNS);
    // Ensure key columns are present in each chunk
    for (const key of KEY_COLUMNS) {
      if (rawColumns.includes(key) && !chunk.includes(key)) {
        chunk.unshift(key);
      }
    }
    chunks.push(chunk);
  }
  return chunks;
}

export function buildAiNormalizePrompt(rawHeaders: string[], sampleRows: string[][]): string {
  const standardFields = [
    "source", "platform", "externalOrderNo", "merchantOrderNo",
    "buyerName", "buyerPhone", "buyerWechat", "buyerCustomerCode", "buyerOrgName", "buyerAddress",
    "productNamesRaw", "itemCount", "orderAt", "paidAt",
    "grossAmount", "priceAdjustment", "paidAmount", "shippingFee",
    "sellerMessage", "merchantRemark", "rawExtraJson",
  ];

  const headerLine = rawHeaders.join(", ");
  const sampleLines = sampleRows.slice(0, 5).map((r) => r.join(", ")).join("\n");

  return `你是一个数据标准化助手。请将以下订单导入文件的列映射到标准字段。

标准字段: ${standardFields.join(", ")}

原始表头: ${headerLine}

示例数据行:
${sampleLines}

请输出 JSON 格式的列映射，格式为 { "原始列名": "标准字段名" }。无法映射的列放入 rawExtraJson。只输出 JSON，不要其他文字。`;
}

export function mergeAiChunks(chunkResults: Array<Record<string, string>>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const chunk of chunkResults) {
    Object.assign(merged, chunk);
  }
  return merged;
}
