import type { FormSchema } from "./form-schemas/types";
import type { ProjectPluginContext } from "../plugins/types";

export function buildPass1Prompt(schema: FormSchema, projectCtx?: ProjectPluginContext): string {
  const fieldDefs = schema.fields.map((f) => {
    let desc = `"${f.key}": ${f.label} (${f.type})`;
    if (f.enumValues) {
      const vals = Object.entries(f.enumValues)
        .map(([k, v]) => `${v}→"${k}"`)
        .join(", ");
      desc += ` 枚举映射: ${vals}`;
    }
    if (f.normalizer === "date") desc += " 格式: YYYY-MM-DD";
    if (f.required) desc += " [必填]";
    if (f.entityType === "organization") desc += " [提取完整机构名称，不要缩写，包含院区名称]";
    if (f.entityType === "customer") desc += " [提取完整人名，姓+名]";
    return desc;
  });

  let contextHint = "";
  if (projectCtx) {
    const p = projectCtx.project;
    contextHint = `\n\n当前项目上下文（仅供参考，不要覆盖用户输入）：
- 项目名称: ${p.name}
- 状态: ${p.status}
- 单位: ${p.organization || "未知"}
- 客户: ${p.client || "未知"}`;
  }

  const formLabel = schema.formKey.startsWith("order.") ? "订单" : schema.formKey.startsWith("customer.") ? "客户" : schema.formKey.startsWith("ticket.") ? "工单" : "项目";

  return `你是科研${formLabel}信息提取助手。从用户提供的文本中提取${formLabel}字段。

字段定义：
${fieldDefs.join("\n")}

规则：
1. 按字段定义提取信息，允许根据上下文合理推测
2. 枚举字段必须映射为英文值（如"进行中"→"IN_PROGRESS"）
3. 日期统一为 YYYY-MM-DD 格式
4. 对每个字段给出置信度（0-1）和来源（text/image/audio/project_context）
5. 直接从文本提取的字段置信度高（0.8-1.0），推测的字段置信度低（0.3-0.6）
6. 宁可多提取、标低置信度，也不要遗漏可能有用的信息

返回严格 JSON，不要包含其他文字：
{
  "fields": { "fieldKey": "value", ... },
  "fieldMeta": {
    "fieldKey": { "source": "text", "confidence": 0.95 },
    ...
  }
}${contextHint}`;
}

export function buildPass2Prompt(schema: FormSchema): string {
  const fieldKeys = schema.fields.map((f) => f.key).join(", ");
  const formLabel = schema.formKey.startsWith("order.") ? "订单" : schema.formKey.startsWith("customer.") ? "客户" : schema.formKey.startsWith("ticket.") ? "工单" : "项目";

  return `你是科研${formLabel}信息校验助手。根据搜索补充信息修正和完善字段值。

可修正的字段: ${fieldKeys}

规则：
1. 只修改有搜索证据支持的字段
2. 如果搜索结果能确认或修正机构标准名称、地址等，更新对应字段并提高置信度
3. 如果搜索结果与原始提取矛盾，以搜索结果为准但降低置信度并标记 reviewRequired
4. 不要修改没有搜索证据的字段
5. 保持原始 fieldMeta 中的 source 不变，但可以更新 confidence

输入格式：
- "原始提取" 部分是 Pass 1 的结果
- "搜索证据" 部分是按字段分组的搜索结果

返回严格 JSON，格式同 Pass 1：
{
  "fields": { ... },
  "fieldMeta": { ... }
}`;
}
