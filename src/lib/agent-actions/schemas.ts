import { AgentActionInputError } from "./errors";
import type { JsonSchemaObject, JsonSchemaValue } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function objectSchema(
  properties: Record<string, JsonSchemaObject>,
  required: string[] = [],
  extra: JsonSchemaObject = {},
): JsonSchemaObject {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
    ...extra,
  };
}

export function stringSchema(description?: string, extra: JsonSchemaObject = {}): JsonSchemaObject {
  return { type: "string", ...(description ? { description } : {}), ...extra };
}

export function numberSchema(description?: string, extra: JsonSchemaObject = {}): JsonSchemaObject {
  return { type: "number", ...(description ? { description } : {}), ...extra };
}

export function integerSchema(description?: string, extra: JsonSchemaObject = {}): JsonSchemaObject {
  return { type: "integer", ...(description ? { description } : {}), ...extra };
}

export function booleanSchema(description?: string, extra: JsonSchemaObject = {}): JsonSchemaObject {
  return { type: "boolean", ...(description ? { description } : {}), ...extra };
}

export function arraySchema(items: JsonSchemaValue, description?: string, extra: JsonSchemaObject = {}): JsonSchemaObject {
  return { type: "array", items, ...(description ? { description } : {}), ...extra };
}

export function ensureObject(value: unknown, label = "input"): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new AgentActionInputError(`${label} must be an object`);
  }
  return value;
}

export function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new AgentActionInputError(`${key} must be a string`);
  }
  return value.trim() || undefined;
}

export function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = readOptionalString(record, key);
  if (!value) {
    throw new AgentActionInputError(`${key} is required`);
  }
  return value;
}

export function readOptionalInteger(
  record: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  const value = record[key];
  if (value == null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    throw new AgentActionInputError(`${key} must be an integer`);
  }
  if (opts.min != null && parsed < opts.min) {
    throw new AgentActionInputError(`${key} must be >= ${opts.min}`);
  }
  if (opts.max != null && parsed > opts.max) {
    throw new AgentActionInputError(`${key} must be <= ${opts.max}`);
  }
  return parsed;
}

export function readOptionalNumber(
  record: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  const value = record[key];
  if (value == null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AgentActionInputError(`${key} must be a number`);
  }
  if (opts.min != null && parsed < opts.min) {
    throw new AgentActionInputError(`${key} must be >= ${opts.min}`);
  }
  if (opts.max != null && parsed > opts.max) {
    throw new AgentActionInputError(`${key} must be <= ${opts.max}`);
  }
  return parsed;
}

export function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value == null || value === "") return undefined;
  if (typeof value !== "boolean") {
    throw new AgentActionInputError(`${key} must be a boolean`);
  }
  return value;
}

export function readOptionalArray(record: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = record[key];
  if (value == null) return undefined;
  if (!Array.isArray(value)) {
    throw new AgentActionInputError(`${key} must be an array`);
  }
  return value;
}

export function clampLimit(limit: number | undefined, fallback = 10, max = 30): number {
  if (!limit) return fallback;
  return Math.max(1, Math.min(max, limit));
}
