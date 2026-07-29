// 合同类型
export const CONTRACT_CATEGORY = {
  SEQUENCING: "SEQUENCING", // 测序服务
  EQUIPMENT: "EQUIPMENT", // 设备采购
  NDA: "NDA", // 保密协议
  DELIVERY_NOTE: "DELIVERY_NOTE", // 出库单
  OTHER: "OTHER", // 其他
} as const;
export type ContractCategory =
  (typeof CONTRACT_CATEGORY)[keyof typeof CONTRACT_CATEGORY];

export const CONTRACT_CATEGORY_LABELS: Record<string, string> = {
  SEQUENCING: "测序服务",
  EQUIPMENT: "设备采购",
  NDA: "保密协议",
  DELIVERY_NOTE: "出库单",
  OTHER: "其他",
};

