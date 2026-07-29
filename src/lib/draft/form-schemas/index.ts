import type { FormSchema } from "./types";
import { projectCreateSchema, projectEditSchema } from "./project-create";
import { customerCreateSchema } from "./customer-create";
import { ticketCreateSchema } from "./ticket-create";
import { orderCreateSchema } from "./order-create";

const schemas: Record<string, FormSchema> = {
  "project.create": projectCreateSchema,
  "project.edit": projectEditSchema,
  "customer.create": customerCreateSchema,
  "ticket.create": ticketCreateSchema,
  "order.create": orderCreateSchema,
};

export function getFormSchema(formKey: string): FormSchema | undefined {
  return schemas[formKey];
}
