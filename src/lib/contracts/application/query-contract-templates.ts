/**
 * T8.1a — actor-aware 合同模板查询。
 *
 * Shared by GET /api/contracts/templates and Agent contracts.list_templates：
 * - 查看权限：非销售角色（canViewTemplates），销售角色 → ForbiddenError；
 * - 默认只返回未归档、当前可用模板（includeArchived 为可选兼容入参，现网客户端不发送）；
 * - 排序固定 [category asc, isDefault desc, createdAt desc]。
 *
 * DTO 保持 detectedVariables 为原始 JSON 字符串（存储形态）：admin 页面直接
 * JSON.parse 该字段，Web 响应必须逐字节保持现状；解析后的数组只在 Agent
 * shape（shapeContractTemplateForAgent）中产出。
 */
import type { Prisma } from "@prisma/client";
import type { BusinessActor } from "@/lib/application/actor";
import { ForbiddenError } from "@/lib/application/errors";
import { prisma } from "@/lib/prisma";
import { canViewTemplates } from "@/lib/contracts/permissions";

const TEMPLATE_LIST_INCLUDE = {
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.ContractTemplateInclude;

export type ContractTemplateRecord = Prisma.ContractTemplateGetPayload<{
  include: typeof TEMPLATE_LIST_INCLUDE;
}>;

export type ListContractTemplatesInput = {
  /** 模板类别过滤（SEQUENCING/EQUIPMENT/NDA/DELIVERY_NOTE/OTHER）；省略不过滤。 */
  category?: string | null;
  /** 兼容入参：true 时连同已归档模板返回；默认 false（只返回可用模板）。 */
  includeArchived?: boolean;
};

export type ListContractTemplatesResult = {
  templates: ContractTemplateRecord[];
};

/** Agent 输出用的 detectedVariables 解析：非法/非数组 JSON 一律降级为空数组。 */
export function safeParseJsonStringArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 模板列表查询（权威实现）。Web route 直接返回 templates 数组以保持响应形态；
 * Agent adapter 经 shapeContractTemplateForAgent 产出稳定 6 键输出。
 */
export async function listContractTemplatesForActor(
  actor: BusinessActor,
  input: ListContractTemplatesInput = {},
): Promise<ListContractTemplatesResult> {
  if (!canViewTemplates(actor.role)) {
    throw new ForbiddenError();
  }

  const where: Record<string, unknown> = {};
  if (!input.includeArchived) where.archived = false;
  if (input.category) where.category = input.category;

  const templates = await prisma.contractTemplate.findMany({
    where,
    include: TEMPLATE_LIST_INCLUDE,
    orderBy: [{ category: "asc" }, { isDefault: "desc" }, { createdAt: "desc" }],
  });

  return { templates };
}

/** Agent contracts.list_templates 稳定输出形状（format-tool-result-for-model 消费）。 */
export function shapeContractTemplateForAgent(
  template: Pick<
    ContractTemplateRecord,
    "id" | "name" | "category" | "isDefault" | "detectedVariables" | "fileName"
  >,
) {
  return {
    id: template.id,
    name: template.name,
    category: template.category,
    isDefault: template.isDefault,
    detectedVariables: safeParseJsonStringArray(template.detectedVariables),
    fileName: template.fileName,
  };
}
