import type { FormSchema } from "./types";

export const projectCreateSchema: FormSchema = {
  formKey: "project.create",
  fields: [
    { key: "name", label: "项目名称", type: "string", required: true },
    { key: "description", label: "项目描述", type: "string" },
    {
      key: "organization",
      label: "单位",
      type: "string",
      searchable: true,
      entityType: "organization",
    },
    { key: "client", label: "客户", type: "string", entityType: "customer" },
    { key: "representative", label: "代表", type: "string" },
    {
      key: "status",
      label: "状态",
      type: "enum",
      normalizer: "status",
      enumValues: {
        NOT_STARTED: "未开始",
        IN_PROGRESS: "进行中",
        COMPLETED: "已完成",
        ON_HOLD: "暂停",
        TERMINATED: "终止",
      },
    },
    { key: "startDate", label: "开始日期", type: "date", normalizer: "date" },
    { key: "endDate", label: "结束日期", type: "date", normalizer: "date" },
    { key: "progress", label: "项目进度", type: "number" },
  ],
};

// Edit schema keeps product fields (visible in project edit page "商品信息" section)
// but excludes financial fields (managed by orders)
export const projectEditSchema: FormSchema = {
  formKey: "project.edit",
  fields: [
    ...projectCreateSchema.fields,
    { key: "projectType", label: "项目类型", type: "enum", enumValues: { "商品": "商品", "服务": "服务" } },
    { key: "projectContent", label: "项目内容", type: "string" },
    { key: "quantity", label: "数量", type: "number" },
    { key: "procurementSource", label: "采购渠道", type: "string" },
    { key: "brand", label: "品牌", type: "string" },
    { key: "techSupport", label: "技术支持", type: "string" },
  ],
};
