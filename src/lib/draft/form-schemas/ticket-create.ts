import type { FormSchema } from "./types";

export const ticketCreateSchema: FormSchema = {
  formKey: "ticket.create",
  fields: [
    { key: "title", label: "标题", type: "string", required: true },
    { key: "description", label: "描述", type: "string" },
    {
      key: "priority",
      label: "优先级",
      type: "enum",
      enumValues: {
        LOW: "低",
        MEDIUM: "中",
        HIGH: "高",
        URGENT: "紧急",
      },
    },
  ],
};
