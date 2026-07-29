import type { DraftInputPayload, DraftArtifact, AuditTrail } from "./types";
import type { ProjectPluginContext, PluginActor } from "../plugins/types";
import { normalizeInput } from "./normalizer";
import { getFormSchema } from "./form-schemas";
import { getChatProvider, getSearchProvider } from "./providers";
import { buildPass1Prompt, buildPass2Prompt } from "./prompts";
import { resolveOrgEntity, resolveCustomerEntity } from "./entity-resolver";
import { shouldSearch, buildSearchQuery } from "./search-gate";

export interface OrchestratorInput {
  payload: DraftInputPayload;
  formKey: string;
  projectCtx?: ProjectPluginContext;
  actor: PluginActor;
}

export interface OrchestratorOutput {
  artifact: DraftArtifact;
  audit: AuditTrail;
}

function parseJsonResponse(content: string): Record<string, unknown> {
  let cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  cleaned = cleaned.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("无法从 AI 返回中提取 JSON");
  }
}

function normalizeDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const m = value.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!m) return undefined;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

function normalizeStatus(value: unknown, enumValues: Record<string, string>): string | undefined {
  if (typeof value !== "string") return undefined;
  if (enumValues[value]) return value;
  const v = value.trim();
  for (const [key, label] of Object.entries(enumValues)) {
    if (label === v || v.includes(label)) return key;
  }
  const aliases: Record<string, string> = {
    "预实验": "NOT_STARTED", "未开始": "NOT_STARTED",
    "进行中": "IN_PROGRESS",
    "已交付": "COMPLETED", "已完成": "COMPLETED",
    "暂停": "ON_HOLD",
    "终止": "TERMINATED",
  };
  return aliases[v];
}

type FieldMetaMap = Record<string, {
  source: "text" | "search" | "project_context";
  confidence: number;
  reviewRequired?: boolean;
  reason?: string;
}>;

export async function runDraftOrchestrator(input: OrchestratorInput): Promise<OrchestratorOutput> {
  const startTime = Date.now();
  const schema = getFormSchema(input.formKey);
  if (!schema) throw new Error(`未知的 formKey: ${input.formKey}`);

  const chat = getChatProvider();
  const search = getSearchProvider();

  // 1. Normalize input (text only now)
  const normalized = normalizeInput(input.payload);
  if (!normalized.combinedText.trim()) {
    throw new Error("输入内容为空");
  }

  // 2. LLM Pass 1 — Extract
  const pass1System = buildPass1Prompt(schema, input.projectCtx);
  const pass1Response = await chat.chat({ systemPrompt: pass1System, userMessage: normalized.combinedText });
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonResponse(pass1Response.content);
  } catch (e) {
    console.error("Pass 1 JSON 解析失败，原始返回:", pass1Response.content.slice(0, 500));
    throw new Error(`AI 返回格式异常，无法解析: ${e instanceof Error ? e.message : "unknown"}`);
  }

  let fields = (parsed.fields || {}) as Record<string, unknown>;
  let fieldMeta = (parsed.fieldMeta || {}) as FieldMetaMap;

  // 2.5. Entity resolution — match client/organization against DB (concurrent)
  const orgHintValue = fields.organization ?? fields.buyerOrgNameSnapshot;
  const orgHint = typeof orgHintValue === "string" ? orgHintValue : undefined;
  const entityPromises: Array<{ key: string; type: "organization" | "customer"; promise: ReturnType<typeof resolveOrgEntity> | ReturnType<typeof resolveCustomerEntity> }> = [];

  for (const fieldSchema of schema.fields) {
    if (!fieldSchema.entityType) continue;
    const rawValue = fields[fieldSchema.key];
    if (typeof rawValue !== "string" || !rawValue.trim()) continue;

    if (fieldSchema.entityType === "organization") {
      entityPromises.push({ key: fieldSchema.key, type: "organization", promise: resolveOrgEntity(rawValue) });
    }
    if (fieldSchema.entityType === "customer") {
      entityPromises.push({ key: fieldSchema.key, type: "customer", promise: resolveCustomerEntity(rawValue, orgHint) });
    }
  }

  const entityResults = await Promise.all(entityPromises.map(async (ep) => ({ ...ep, resolution: await ep.promise })));

  for (const { key, type, resolution } of entityResults) {
    if (type === "organization") {
      if (resolution.status === "exact" && resolution.match) {
        fields[key] = {
          id: resolution.match.id, name: resolution.match.name,
          address: resolution.match.extra?.address || null, matched: true,
        };
        fieldMeta[key] = { ...fieldMeta[key], confidence: 0.95, reviewRequired: false };
      } else if (resolution.status === "candidate" && resolution.candidates?.length) {
        fields[key] = {
          name: resolution.rawText, matched: false,
          candidates: resolution.candidates.map((c) => ({
            id: c.id, name: c.name, address: c.extra?.address || null, confidence: c.confidence,
          })),
        };
        fieldMeta[key] = { ...fieldMeta[key], confidence: 0.6, reviewRequired: true, reason: `找到 ${resolution.candidates.length} 个候选单位，请确认` };
      } else {
        fields[key] = { name: resolution.rawText, matched: false };
        fieldMeta[key] = { ...fieldMeta[key], confidence: 0.3, reviewRequired: true, reason: "未匹配到已有单位" };
      }
    }

    if (type === "customer") {
      if (resolution.status === "exact" && resolution.match) {
        fields[key] = {
          id: resolution.match.id, name: resolution.match.name,
          organization: resolution.match.extra?.organization || null,
          organizationId: resolution.match.extra?.organizationId || null, matched: true,
        };
        fieldMeta[key] = { ...fieldMeta[key], confidence: 0.95, reviewRequired: false };
      } else if (resolution.status === "candidate" && resolution.candidates?.length) {
        fields[key] = {
          name: resolution.rawText, matched: false,
          candidates: resolution.candidates.map((c) => ({
            id: c.id, name: c.name, organization: c.extra?.organization || null,
            organizationId: c.extra?.organizationId || null, confidence: c.confidence,
          })),
        };
        fieldMeta[key] = { ...fieldMeta[key], confidence: 0.6, reviewRequired: true, reason: `找到 ${resolution.candidates.length} 个候选客户，请确认` };
      } else {
        fields[key] = { name: resolution.rawText, matched: false };
        fieldMeta[key] = { ...fieldMeta[key], confidence: 0.3, reviewRequired: true, reason: "未匹配到已有客户" };
      }
    }
  }

  // 3. Search supplement (concurrent)
  const searchQueries: string[] = [];
  const searchEvidence: Record<string, Array<{ title: string; url: string; snippet: string }>> = {};

  const searchTasks: Array<{ key: string; query: string }> = [];
  for (const fieldSchema of schema.fields) {
    const meta = fieldMeta[fieldSchema.key];
    const confidence = meta?.confidence ?? 0;
    const value = fields[fieldSchema.key];

    if (shouldSearch(fieldSchema, value, confidence)) {
      const query = buildSearchQuery(fieldSchema.key, value);
      if (!query) continue;
      searchQueries.push(query);
      searchTasks.push({ key: fieldSchema.key, query });
    }
  }

  if (searchTasks.length > 0) {
    const searchResults = await Promise.allSettled(
      searchTasks.map(async ({ key, query }) => {
        const result = await search.search({ query, maxResults: 3 });
        return { key, results: result.results };
      }),
    );
    for (const r of searchResults) {
      if (r.status === "fulfilled" && r.value.results.length > 0) {
        searchEvidence[r.value.key] = r.value.results;
      } else if (r.status === "rejected") {
        console.warn(`搜索失败:`, r.reason);
      }
    }
  }

  // 4. LLM Pass 2 — Finalize (only if search was used)
  const entityStash: Record<string, { field: unknown; meta: FieldMetaMap[string] }> = {};
  for (const fieldSchema of schema.fields) {
    if (fieldSchema.entityType && typeof fields[fieldSchema.key] === "object" && fields[fieldSchema.key] !== null) {
      entityStash[fieldSchema.key] = { field: fields[fieldSchema.key], meta: fieldMeta[fieldSchema.key] };
    }
  }

  const searchUsed = Object.keys(searchEvidence).length > 0;
  if (searchUsed) {
    const pass2Fields: Record<string, unknown> = {};
    const pass2Meta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (!entityStash[k]) { pass2Fields[k] = v; if (fieldMeta[k]) pass2Meta[k] = fieldMeta[k]; }
    }

    const pass2System = buildPass2Prompt(schema);
    const evidenceText = Object.entries(searchEvidence)
      .map(([key, results]) => {
        const items = results.map((r) => `  - ${r.title}: ${r.snippet}`).join("\n");
        return `[${key}]\n${items}`;
      }).join("\n\n");

    const pass2Message = `原始提取：\n${JSON.stringify({ fields: pass2Fields, fieldMeta: pass2Meta }, null, 2)}\n\n搜索证据：\n${evidenceText}`;
    const pass2Response = await chat.chat({ systemPrompt: pass2System, userMessage: pass2Message, temperature: 0.2 });

    try {
      const pass2Parsed = parseJsonResponse(pass2Response.content);
      fields = (pass2Parsed.fields || fields) as Record<string, unknown>;
      fieldMeta = (pass2Parsed.fieldMeta || fieldMeta) as FieldMetaMap;
    } catch {
      console.warn("Pass 2 解析失败，保留 Pass 1 结果");
    }
  }

  // Restore entity fields
  for (const [key, stash] of Object.entries(entityStash)) {
    fields[key] = stash.field;
    if (stash.meta) fieldMeta[key] = stash.meta;
  }

  // 5. Post-process: normalizers
  for (const fieldSchema of schema.fields) {
    const value = fields[fieldSchema.key];
    if (value === undefined) continue;
    if (fieldSchema.normalizer === "date") {
      const n = normalizeDate(value);
      if (n) fields[fieldSchema.key] = n; else delete fields[fieldSchema.key];
    }
    if (fieldSchema.normalizer === "status" && fieldSchema.enumValues) {
      const n = normalizeStatus(value, fieldSchema.enumValues);
      if (n) fields[fieldSchema.key] = n; else delete fields[fieldSchema.key];
    }
    if (fieldSchema.searchable && !fieldSchema.entityType && fieldMeta[fieldSchema.key]) {
      fieldMeta[fieldSchema.key].reviewRequired = true;
      if (!fieldMeta[fieldSchema.key].reason) fieldMeta[fieldSchema.key].reason = `${fieldSchema.label}建议人工确认`;
    }
  }

  // 6. Build sources
  const sources: DraftArtifact["sources"] = [];
  for (const [, results] of Object.entries(searchEvidence)) {
    for (const r of results) {
      sources.push({ kind: "search_result", title: r.title, url: r.url, snippet: r.snippet });
    }
  }

  // 7. Build warnings
  const warnings: string[] = [];
  for (const fieldSchema of schema.fields) {
    if (fieldMeta[fieldSchema.key]?.reviewRequired) warnings.push(`${fieldSchema.label}需要人工确认`);
    if (fieldSchema.required && !fields[fieldSchema.key]) warnings.push(`未能提取${fieldSchema.label}`);
  }

  return {
    artifact: {
      fields,
      fieldMeta: Object.keys(fieldMeta).length > 0 ? fieldMeta : undefined,
      sources: sources.length > 0 ? sources : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    },
    audit: {
      inputMode: "text",
      searchUsed,
      searchQueries,
      inferredFields: Object.keys(fields),
      processingTimeMs: Date.now() - startTime,
    },
  };
}
