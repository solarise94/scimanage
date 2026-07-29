/** Form schema types — define what fields a form has and how to extract them. */

export interface FormFieldSchema {
  key: string;
  label: string;
  type: "string" | "date" | "enum" | "number";
  required?: boolean;
  enumValues?: Record<string, string>;
  searchable?: boolean;
  normalizer?: "date" | "status";
  entityType?: "organization" | "customer";
}

export interface FormSchema {
  formKey: string;
  fields: FormFieldSchema[];
}
