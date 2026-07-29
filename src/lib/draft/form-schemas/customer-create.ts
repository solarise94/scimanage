import type { FormSchema } from "./types";

export const customerCreateSchema: FormSchema = {
  formKey: "customer.create",
  fields: [
    { key: "name", label: "客户姓名", type: "string", required: true },
    {
      key: "organization",
      label: "单位",
      type: "string",
      searchable: true,
      entityType: "organization",
    },
    { key: "principal", label: "课题组负责人", type: "string" },
    { key: "email", label: "邮箱", type: "string" },
    { key: "wechat", label: "微信", type: "string" },
    { key: "address", label: "通讯地址", type: "string" },
    { key: "miniProgramId", label: "小程序 ID", type: "string" },
  ],
};
